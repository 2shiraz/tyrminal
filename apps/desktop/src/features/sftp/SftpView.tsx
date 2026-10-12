import type { ConflictChoice, RemoteEntry, TransferDirection, TransferEvent, TransferStarted } from "@tyrminal/contracts";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { IconButton, Notice } from "../../components/ui/controls";
import { IconArrowLeftRight, IconTrash2, IconX } from "../../components/ui/icons";
import { type AppError, files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgFiles } from "../files/messages";
import { TransferDrawer } from "../files/TransferDrawer";
import { type Transfer, applyEvent, refused, started as startedTransfer } from "../files/transfers";
import { msgSftp } from "./messages";
import type { Endpoint } from "./model";
import { type PaneHealth, type Side, type Source, SftpPane } from "./SftpPane";
import "./sftp.css";

interface Conflict {
  name: string;
  /** Where the existing item is (for the explanation). */
  remote: boolean;
  /** Folders can only be kept both, never replaced. */
  folder: boolean;
  start: (choice: ConflictChoice) => void;
}

/** Panes keep their identity (and connection) when they swap sides. */
type PaneId = "a" | "b";
const PANES: Record<PaneId, Source> = { a: { kind: "local" }, b: { kind: "none" } };
const other = (id: PaneId): PaneId => (id === "a" ? "b" : "a");

function whereOf(endpoint: Endpoint | null): string | null {
  if (!endpoint) return null;
  return endpoint.kind === "local" ? msgSftp.thisComputer : endpoint.label;
}

const RANK: PaneHealth[] = ["idle", "ok", "busy", "bad", "attention"];

/**
 * The SFTP tab: two panes side by side, each showing this computer or a saved host over a
 * files-only connection. Dragging an item to the other pane (or F5, or Copy to in its menu)
 * copies it through the transfer queue, with progress, cancel and the usual conflict choices.
 * The pane in use is marked; Swap exchanges the panes' sides without reconnecting.
 */
export function SftpView({
  visible,
  onIndicator,
  onOpenKnownHosts,
}: {
  visible: boolean;
  onIndicator: (indicator: "busy" | "ok" | "bad" | "attention" | "idle") => void;
  onOpenKnownHosts: () => void;
}) {
  const data = useVaultData();
  const hosts = data.hosts.value ?? [];
  const [order, setOrder] = useState<[PaneId, PaneId]>(["a", "b"]);
  const [active, setActive] = useState<PaneId>("a");
  const [endpoints, setEndpoints] = useState<Record<PaneId, Endpoint | null>>({ a: null, b: null });
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  const [refresh, setRefresh] = useState<Record<PaneId, number>>({ a: 0, b: 0 });
  const [health, setHealth] = useState<Record<PaneId, PaneHealth>>({ a: "idle", b: "idle" });
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  /** Name conflicts waiting for a decision, asked one at a time. */
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const conflict = conflicts[0] ?? null;
  const settle = () => setConflicts((list) => list.slice(1));
  const [notice, setNotice] = useState<string | null>(null);
  const sideOf = (id: PaneId): Side => (order[0] === id ? "left" : "right");

  const onEndpoint = {
    a: useCallback((e: Endpoint | null) => setEndpoints((c) => ({ ...c, a: e })), []),
    b: useCallback((e: Endpoint | null) => setEndpoints((c) => ({ ...c, b: e })), []),
  };
  const onHealth = {
    a: useCallback((h: PaneHealth) => setHealth((c) => (c.a === h ? c : { ...c, a: h })), []),
    b: useCallback((h: PaneHealth) => setHealth((c) => (c.b === h ? c : { ...c, b: h })), []),
  };

  const indicator = RANK[Math.max(RANK.indexOf(health.a), RANK.indexOf(health.b))] ?? "idle";
  const indicatorRef = useRef(onIndicator);
  indicatorRef.current = onIndicator;
  useEffect(() => indicatorRef.current(indicator), [indicator]);

  function apply(id: string, event: TransferEvent) {
    setTransfers((list) => list.map((t) => (t.id === id ? applyEvent(t, event) : t)));
  }

  function failNow(name: string, direction: TransferDirection, e: AppError) {
    setTransfers((list) => [...list, refused(name, direction, e.message, list.length)]);
  }

  function transferAll(from: PaneId, entries: RemoteEntry[]) {
    for (const entry of entries) transfer(from, entry);
  }

  /** Copies `entry` from the `from` pane's folder into the other pane's folder. */
  function transfer(from: PaneId, entry: RemoteEntry, choice: ConflictChoice = "ask") {
    setNotice(null);
    const to = other(from);
    const src = endpointsRef.current[from];
    const dst = endpointsRef.current[to];
    if (!src || !dst) {
      setNotice(msgSftp.notReady);
      return;
    }
    if (src.kind === "local" && dst.kind === "local") {
      setNotice(msgSftp.localToLocal);
      return;
    }
    if (src.kind === "remote" && dst.kind === "remote" && src.sessionId === dst.sessionId && src.path === dst.path) {
      setNotice(msgSftp.sameFolder);
      return;
    }
    const direction: TransferDirection = src.kind === "local" ? "upload" : dst.kind === "local" ? "download" : "copy";
    const destination = JSON.stringify(dst);
    // Events can arrive before the call that started the transfer returns its id.
    let bound: string | null = null;
    const early: TransferEvent[] = [];
    const onEvent = (event: TransferEvent) => {
      if (event.type === "done") {
        // The destination pane lists again if it still shows that folder.
        if (JSON.stringify(endpointsRef.current[to]) === destination) setRefresh((r) => ({ ...r, [to]: r[to] + 1 }));
      }
      if (bound) apply(bound, event);
      else early.push(event);
    };
    let started: Promise<TransferStarted>;
    if (src.kind === "local" && dst.kind === "remote") {
      started = filesApi.upload(dst.sessionId, src.token, dst.path, choice, onEvent, [...src.path, entry.name]);
    } else if (src.kind === "remote" && dst.kind === "local") {
      started = filesApi.download(src.sessionId, src.path, entry.name, dst.token, choice, onEvent, dst.path);
    } else if (src.kind === "remote" && dst.kind === "remote") {
      started = filesApi.copy(src.sessionId, src.path, entry.name, dst.sessionId, dst.path, choice, onEvent);
    } else {
      return;
    }
    started
      .then((s) => {
        setTransfers((list) => [...list, startedTransfer(s)]);
        bound = s.transferId;
        for (const event of early.splice(0)) apply(s.transferId, event);
      })
      .catch((caught) => {
        const e = toAppError(caught);
        if (e.code === "CONFLICT" && choice === "ask") {
          const next = { name: entry.name, remote: dst.kind === "remote", folder: entry.kind === "dir", start: (c: ConflictChoice) => transfer(from, entry, c) };
          setConflicts((list) => [...list, next]);
        } else {
          failNow(entry.name, direction, e);
        }
      });
  }

  return (
    <div className="sftp" role="region" aria-label={msgSftp.view}>
      <div className="sftp-panes">
        {order.map((id, index) => (
          <Fragment key={id}>
            {index === 1 && (
              <div className="sftp-divider">
                <IconButton size="sm" className="sftp-swap" label={msgFiles.swap} onClick={() => setOrder(([l, r]) => [r, l])}>
                  <IconArrowLeftRight size={14} />
                </IconButton>
              </div>
            )}
            <SftpPane
              side={sideOf(id)}
              initial={PANES[id]}
              hosts={hosts}
              visible={visible}
              active={active === id}
              refreshKey={refresh[id]}
              otherWhere={whereOf(endpoints[other(id)])}
              onFocusIn={() => setActive(id)}
              onEndpoint={onEndpoint[id]}
              onHealth={onHealth[id]}
              onTransfer={(entries) => transferAll(id, entries)}
              onDropFrom={(entries) => transferAll(other(id), entries)}
              onOpenKnownHosts={onOpenKnownHosts}
            />
          </Fragment>
        ))}
      </div>

      {notice && (
        <div className="sftp-notice">
          <Notice tone="info">{notice}</Notice>
          <IconButton size="sm" label={msg.common.close} onClick={() => setNotice(null)}>
            <IconX size={14} />
          </IconButton>
        </div>
      )}

      <TransferDrawer
        transfers={transfers}
        onCancel={(t) => void filesApi.cancel(t.id).catch(() => undefined)}
        onClear={() => setTransfers((list) => list.filter((t) => t.state === "running"))}
      />

      {conflict && visible && (
        <Dialog key={`${conflict.name}-${conflicts.length}`} title={msg.files.replaceTitle(conflict.name)} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => settle()}>
          <div className="stack">
            <p>{conflict.folder ? msg.files.folderExists : conflict.remote ? msg.files.replaceRemote : msg.files.replaceLocal}</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => settle()} data-autofocus>
                {msg.common.cancel}
              </button>
              <button
                type="button"
                className={conflict.folder ? "btn btn-primary" : "btn"}
                onClick={() => {
                  conflict.start("keep_both");
                  settle();
                }}
              >
                {msg.files.keepBoth}
              </button>
              {!conflict.folder && (
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={() => {
                    conflict.start("replace");
                    settle();
                  }}
                >
                  {msg.files.replace}
                </button>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

import type { ConflictChoice, RemoteEntry, TransferDirection, TransferEvent, TransferStarted } from "@tyrminal/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { IconButton, Notice } from "../../components/ui/controls";
import { IconCopy, IconDownload, IconTrash2, IconUpload, IconX } from "../../components/ui/icons";
import { type AppError, files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgSftp } from "./messages";
import { type Endpoint, formatSize, visibleName } from "./model";
import { type PaneHealth, type Side, SftpPane } from "./SftpPane";
import "./sftp.css";

interface Transfer {
  id: string;
  name: string;
  direction: TransferDirection;
  total: number | null;
  done: number;
  state: "running" | "done" | "cancelled" | "failed";
  error?: string;
  files?: number;
  skipped?: number;
}

interface Conflict {
  name: string;
  /** Where the existing item is (for the explanation). */
  remote: boolean;
  /** Folders can only be kept both, never replaced. */
  folder: boolean;
  start: (choice: ConflictChoice) => void;
}

const other = (side: Side): Side => (side === "left" ? "right" : "left");

function whereOf(endpoint: Endpoint | null): string | null {
  if (!endpoint) return null;
  return endpoint.kind === "local" ? msgSftp.thisComputer : endpoint.label;
}

const RANK: PaneHealth[] = ["idle", "ok", "busy", "bad", "attention"];

/**
 * The SFTP tab: two panes side by side, each showing this computer or a saved host over a
 * files-only connection. Dragging an item to the other pane (or Actions → Copy to) copies it
 * through the transfer queue, with progress, cancel and the usual conflict choices.
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
  const [endpoints, setEndpoints] = useState<Record<Side, Endpoint | null>>({ left: null, right: null });
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  const [refresh, setRefresh] = useState<Record<Side, number>>({ left: 0, right: 0 });
  const [health, setHealth] = useState<Record<Side, PaneHealth>>({ left: "idle", right: "idle" });
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onLeftEndpoint = useCallback((e: Endpoint | null) => setEndpoints((c) => ({ ...c, left: e })), []);
  const onRightEndpoint = useCallback((e: Endpoint | null) => setEndpoints((c) => ({ ...c, right: e })), []);
  const onLeftHealth = useCallback((h: PaneHealth) => setHealth((c) => (c.left === h ? c : { ...c, left: h })), []);
  const onRightHealth = useCallback((h: PaneHealth) => setHealth((c) => (c.right === h ? c : { ...c, right: h })), []);

  const indicator = RANK[Math.max(RANK.indexOf(health.left), RANK.indexOf(health.right))] ?? "idle";
  const indicatorRef = useRef(onIndicator);
  indicatorRef.current = onIndicator;
  useEffect(() => indicatorRef.current(indicator), [indicator]);

  function apply(id: string, event: TransferEvent) {
    setTransfers((list) =>
      list.map((t) => {
        if (t.id !== id) return t;
        switch (event.type) {
          case "progress":
            return { ...t, done: event.done };
          case "done":
            return { ...t, done: event.bytes, state: "done", files: event.files, skipped: event.skipped };
          case "cancelled":
            return { ...t, state: "cancelled" };
          case "failed":
            return { ...t, state: "failed", error: event.error.message };
        }
      }),
    );
  }

  function failNow(name: string, direction: TransferDirection, e: AppError) {
    setTransfers((list) => [
      ...list,
      { id: `refused-${Date.now()}-${list.length}`, name, direction, total: null, done: 0, state: "failed", error: e.message },
    ]);
  }

  /** Copies `entry` from the `from` pane's folder into the other pane's folder. */
  function transfer(from: Side, entry: RemoteEntry, choice: ConflictChoice = "ask") {
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
        setTransfers((list) => [...list, { id: s.transferId, name: s.name, direction: s.direction, total: s.total, done: 0, state: "running" }]);
        bound = s.transferId;
        for (const event of early.splice(0)) apply(s.transferId, event);
      })
      .catch((caught) => {
        const e = toAppError(caught);
        if (e.code === "CONFLICT" && choice === "ask") {
          setConflict({ name: entry.name, remote: dst.kind === "remote", folder: entry.kind === "dir", start: (c) => transfer(from, entry, c) });
        } else {
          failNow(entry.name, direction, e);
        }
      });
  }

  return (
    <div className="sftp" role="region" aria-label={msgSftp.view}>
      <div className="sftp-panes">
        <SftpPane
          side="left"
          initial={{ kind: "local" }}
          hosts={hosts}
          visible={visible}
          refreshKey={refresh.left}
          otherWhere={whereOf(endpoints.right)}
          onEndpoint={onLeftEndpoint}
          onHealth={onLeftHealth}
          onTransfer={(entry) => transfer("left", entry)}
          onDropFrom={(entry) => transfer("right", entry)}
          onOpenKnownHosts={onOpenKnownHosts}
        />
        <div className="sftp-divider" aria-hidden="true" />
        <SftpPane
          side="right"
          initial={{ kind: "none" }}
          hosts={hosts}
          visible={visible}
          refreshKey={refresh.right}
          otherWhere={whereOf(endpoints.left)}
          onEndpoint={onRightEndpoint}
          onHealth={onRightHealth}
          onTransfer={(entry) => transfer("right", entry)}
          onDropFrom={(entry) => transfer("left", entry)}
          onOpenKnownHosts={onOpenKnownHosts}
        />
      </div>

      {notice && (
        <div className="sftp-notice">
          <Notice tone="info">{notice}</Notice>
          <IconButton size="sm" label={msg.common.close} onClick={() => setNotice(null)}>
            <IconX size={14} />
          </IconButton>
        </div>
      )}

      {transfers.length > 0 && (
        <section className="files-transfers sftp-transfers" aria-label={msg.files.transfers}>
          <div className="files-transfers-head">
            <h3>{msg.files.transfers}</h3>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setTransfers((list) => list.filter((t) => t.state === "running"))}
              disabled={!transfers.some((t) => t.state !== "running")}
            >
              {msg.files.clearDone}
            </button>
          </div>
          <ul>
            {transfers.map((t) => (
              <li key={t.id} className="files-transfer" data-state={t.state}>
                <span className="files-transfer-icon">
                  {t.direction === "upload" ? <IconUpload size={13} /> : t.direction === "copy" ? <IconCopy size={13} /> : <IconDownload size={13} />}
                </span>
                <span className="files-name">{visibleName(t.name)}</span>
                <span className="files-meta" data-testid="transfer-state">
                  {t.state === "running"
                    ? msg.files.progress(formatSize(t.done), t.total == null ? null : formatSize(t.total))
                    : t.state === "done"
                      ? msg.files.doneSummary(t.files ?? 1, t.skipped ?? 0)
                      : t.state === "cancelled"
                        ? msg.files.cancelled
                        : `${msg.files.failed}: ${t.error ?? ""}`}
                </span>
                {t.state === "running" && (
                  <>
                    <progress max={t.total ?? undefined} value={t.total ? t.done : undefined} aria-label={t.name} />
                    <IconButton label={msg.files.cancelTransfer(t.name)} onClick={() => void filesApi.cancel(t.id).catch(() => undefined)}>
                      <IconX size={14} />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {conflict && visible && (
        <Dialog title={msg.files.replaceTitle(conflict.name)} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => setConflict(null)}>
          <div className="stack">
            <p>{conflict.folder ? msg.files.folderExists : conflict.remote ? msg.files.replaceRemote : msg.files.replaceLocal}</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setConflict(null)} data-autofocus>
                {msg.common.cancel}
              </button>
              <button
                type="button"
                className={conflict.folder ? "btn btn-primary" : "btn"}
                onClick={() => {
                  conflict.start("keep_both");
                  setConflict(null);
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
                    setConflict(null);
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

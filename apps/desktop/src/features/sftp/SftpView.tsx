import type { RemoteEntry } from "@tyrminal/contracts";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { IconButton, Notice } from "../../components/ui/controls";
import { IconArrowLeftRight, IconX } from "../../components/ui/icons";
import { files as filesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { droppedFileJob, droppedFiles } from "../files/dropUpload";
import { copyJob, downloadJob, uploadJob } from "../files/jobs";
import { msgFiles } from "../files/messages";
import { TransferDrawer } from "../files/TransferDrawer";
import { type QueuedTransfer, type TransferJob, useTransferQueue } from "../files/useTransferQueue";
import { msgSftp } from "./messages";
import type { Endpoint } from "./model";
import { type PaneHealth, type PaneTransfers, type Side, type Source, SftpPane } from "./SftpPane";
import "./sftp.css";

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
 * copies it through the transfer queue, with progress, cancel, retry and the usual conflict
 * choices. The pane in use is marked; Swap exchanges the panes' sides without reconnecting.
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
  const [list, setList] = useState<QueuedTransfer[]>([]);
  const queue = useTransferQueue(list, setList, visible);
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

  /** Lists `pane` again when it still shows the folder a finished transfer went to. */
  const refreshIfShowing = (pane: PaneId, endpoint: Endpoint) => {
    const shown = JSON.stringify(endpoint);
    return () => {
      if (JSON.stringify(endpointsRef.current[pane]) === shown) setRefresh((r) => ({ ...r, [pane]: r[pane] + 1 }));
    };
  };

  /** Copies `entries` from the `from` pane's folder into the other pane's folder. */
  function transfer(from: PaneId, entries: RemoteEntry[]) {
    setNotice(null);
    const to = other(from);
    const src = endpointsRef.current[from];
    const dst = endpointsRef.current[to];
    if (!src || !dst) return setNotice(msgSftp.notReady);
    if (src.kind === "local" && dst.kind === "local") return setNotice(msgSftp.localToLocal);
    if (src.kind === "remote" && dst.kind === "remote" && src.sessionId === dst.sessionId && src.path === dst.path) return setNotice(msgSftp.sameFolder);
    const done = refreshIfShowing(to, dst);
    for (const entry of entries) {
      let job: TransferJob | null = null;
      if (src.kind === "local" && dst.kind === "remote") job = uploadJob(dst.sessionId, src.token, dst.path, entry.name, entry.kind === "dir", [...src.path, entry.name], done);
      else if (src.kind === "remote" && dst.kind === "local") job = downloadJob(src.sessionId, src.path, entry, dst.token, dst.path, done);
      else if (src.kind === "remote" && dst.kind === "remote") job = copyJob(src.sessionId, src.path, entry, dst.sessionId, dst.path, done);
      if (job) queue.run(job);
    }
  }

  /** What one pane may do with transfers (its endpoint is looked up when an action runs). */
  function transfersFor(id: PaneId): PaneTransfers {
    const remoteHere = () => {
      const e = endpointsRef.current[id];
      return e?.kind === "remote" ? e : null;
    };
    const otherWhere = whereOf(endpoints[other(id)]);
    return {
      copyLabel: otherWhere ? msgFiles.copyToOther(otherWhere) : null,
      copy: (entries) => transfer(id, entries),
      dropFrom: (entries) => transfer(other(id), entries),
      dropFiles: (dt) => {
        const here = remoteHere();
        if (!here) return;
        const { files, folders } = droppedFiles(dt);
        for (const name of folders) queue.refuse(name, "upload", msg.files.dropFolder);
        for (const file of files) queue.run(droppedFileJob(here.sessionId, here.path, file, refreshIfShowing(id, here)));
      },
      download: async (entries) => {
        const here = remoteHere();
        if (!here) return;
        const folder = await filesApi.pickFolder().catch(() => null);
        if (folder) for (const entry of entries) queue.run(downloadJob(here.sessionId, here.path, entry, folder.token, null));
      },
      upload: async () => {
        const here = remoteHere();
        if (!here) return;
        const picks = await filesApi.pickUpload().catch(() => null);
        for (const pick of picks ?? []) queue.run(uploadJob(here.sessionId, pick.token, here.path, pick.name, false, null, refreshIfShowing(id, here)));
      },
      uploadFolder: async () => {
        const here = remoteHere();
        if (!here) return;
        const pick = await filesApi.pickUploadFolder().catch(() => null);
        if (pick) queue.run(uploadJob(here.sessionId, pick.token, here.path, pick.name, true, null, refreshIfShowing(id, here)));
      },
      duplicate: (entries) => {
        const here = remoteHere();
        if (!here) return;
        for (const entry of entries) queue.run(copyJob(here.sessionId, here.path, entry, here.sessionId, here.path, refreshIfShowing(id, here)));
      },
    };
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
              paneId={id}
              side={sideOf(id)}
              initial={PANES[id]}
              hosts={hosts}
              visible={visible}
              active={active === id}
              refreshKey={refresh[id]}
              transfers={transfersFor(id)}
              onFocusIn={() => setActive(id)}
              onEndpoint={onEndpoint[id]}
              onHealth={onHealth[id]}
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

      <TransferDrawer transfers={list} onCancel={queue.cancel} onRetry={queue.retry} onClear={queue.clear} />
      {queue.dialog}
    </div>
  );
}

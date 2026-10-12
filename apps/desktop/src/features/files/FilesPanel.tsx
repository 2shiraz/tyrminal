import type { EditStatus, RemoteEntry } from "@tyrminal/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Dialog } from "../../components/ui/Dialog";
import type { MenuEntry } from "../../components/ui/Menu";
import { ErrorNotice, IconButton, Notice, TextField } from "../../components/ui/controls";
import { IconArrowLeftRight, IconCopy, IconFolderOpen, IconHardDrive, IconPencil, IconSquareTerminal, IconTriangleAlert, IconUpload, IconX } from "../../components/ui/icons";
import { files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { shellContexts } from "../autocomplete/shellContext";
import { msgSftp } from "../sftp/messages";
import type { Loc } from "../sftp/model";
import { visibleName } from "../sftp/model";
import { droppedFileJob, droppedFiles } from "./dropUpload";
import { FILE_DRAG, type FileDrag, FilePane, type PaneView, emptyView, localBackend, remoteBackend } from "./FilePane";
import { copyJob, downloadJob, uploadJob } from "./jobs";
import { KeyedMemory, useMemory } from "./memory";
import { msgFiles } from "./messages";
import { TransferDrawer } from "./TransferDrawer";
import { type QueuedTransfer, useTransferQueue } from "./useTransferQueue";
import { useExit } from "../../lib/exitGhost";

export interface FilesTarget {
  sessionId: string;
  label: string;
}

type Edit = EditStatus & { saved?: boolean | undefined };
type LocalRoot = Loc & { kind: "local" };

/** What the panel shows for one session; it stays while the session lives (see `panelMemory`). */
export interface PanelMemory {
  /** The server pane: folder, history, filter, sort, options, selection, scroll. */
  view: PaneView;
  /** "Show this computer": a second pane on a folder the user chose here. */
  twoPane: boolean;
  localRoot: LocalRoot | null;
  localView: PaneView;
  transfers: QueuedTransfer[];
  edits: Edit[];
}

const emptyMemory = (): PanelMemory => ({ view: emptyView(), twoPane: false, localRoot: null, localView: emptyView(), transfers: [], edits: [] });

const NO_SESSION = emptyMemory();

/**
 * Per-session panel state. Switching tabs unmounts the panel; coming back shows the same folder,
 * selection, scroll position and transfers without listing again. The shell drops a session's
 * entry when the session ends.
 */
export const panelMemory = new KeyedMemory<PanelMemory>(emptyMemory);

type Prompt =
  | { kind: "editConflict"; edit: EditStatus; overwrite: () => void }
  | { kind: "copy"; entry: RemoteEntry; dir: string; others: FilesTarget[] };

/**
 * The Files side panel: one pane of the same file browser as the SFTP tab, bound to the focused
 * session's own connection (and, on request, a second pane on this computer). Every action is
 * explicit; transfers never replace an existing file without asking.
 */
export function FilesPanel({
  target,
  others = [],
  onOpenSftp,
  onClose,
}: {
  target: FilesTarget | null;
  /** Other connected SSH sessions in this window, for copying between servers. */
  others?: FilesTarget[];
  /** Open in SFTP tab: this host at the folder shown (SSH sessions of a saved host). */
  onOpenSftp?: ((path: string | null) => void) | undefined;
  onClose: () => void;
}) {
  const sessionId = target?.sessionId ?? null;
  const [memory, change] = useMemory(panelMemory, sessionId, NO_SESSION);
  const { view, twoPane, localRoot, localView, transfers, edits } = memory;
  const setView = useCallback((f: (v: PaneView) => PaneView) => change((m) => ({ ...m, view: f(m.view) })), [change]);
  const setLocalView = useCallback((f: (v: PaneView) => PaneView) => change((m) => ({ ...m, localView: f(m.localView) })), [change]);
  const setTransfers = useCallback((f: (l: QueuedTransfer[]) => QueuedTransfer[]) => change((m) => ({ ...m, transfers: f(m.transfers) })), [change]);
  const setEdits = (f: (l: Edit[]) => Edit[]) => change((m) => ({ ...m, edits: f(m.edits) }));
  const queue = useTransferQueue(transfers, setTransfers);
  const [refresh, setRefresh] = useState({ remote: 0, local: 0 });
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [goShell, setGoShell] = useState<{ loc: Loc; seq: number } | null>(null);
  const { pending, error, run } = useAction();

  // The shell's current folder, when the shell integration reports it (AUT-06): the first folder
  // shown for a session, and a button to go back to it.
  const shellFolder = useSyncExternalStore(shellContexts.subscribe, () => (sessionId ? (shellContexts.get(sessionId)?.cwd ?? null) : null));
  const start = useMemo<Loc | null>(() => {
    const cwd = sessionId ? (shellContexts.get(sessionId)?.cwd ?? null) : null;
    return cwd ? { kind: "remote", path: cwd } : null;
    // biome-ignore lint/correctness/useExhaustiveDependencies: where a session starts is read once.
  }, [sessionId]);

  const backend = useMemo(() => (target ? remoteBackend(target.sessionId, target.label) : null), [target?.sessionId, target?.label]);
  const local = useMemo(() => (localRoot ? localBackend(localRoot) : null), [localRoot]);
  const dir = view.folder?.loc.kind === "remote" ? view.folder.loc.path : null;
  const localAt = localView.folder?.loc.kind === "local" ? localView.folder.loc : null;

  // Open edits: their local copies are watched while the panel is open (nothing uploads by itself).
  const editIds = edits.map((e) => e.editId).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: polls the open edits.
  useEffect(() => {
    if (!editIds) return;
    const timer = window.setInterval(() => {
      for (const id of editIds.split(",")) {
        filesApi
          .editStatus(id)
          .then((status) => setEdits((list) => list.map((e) => (e.editId === id ? { ...status, saved: status.changed ? false : e.saved } : e))))
          .catch(() => setEdits((list) => list.filter((e) => e.editId !== id)));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [editIds]);

  async function editEntry(entry: RemoteEntry, at: string) {
    if (!sessionId) return;
    const opened = await run(() => filesApi.editOpen(sessionId, at, entry.name));
    if (opened) setEdits((list) => [...list, opened]);
  }

  async function saveEdit(edit: EditStatus, overwrite: boolean) {
    try {
      const status = await filesApi.editSave(edit.editId, overwrite);
      setEdits((list) => list.map((e) => (e.editId === edit.editId ? { ...status, saved: true } : e)));
      setRefresh((r) => ({ ...r, remote: r.remote + 1 }));
    } catch (caught) {
      const e = toAppError(caught);
      if (e.code === "CONFLICT" && !overwrite) setPrompt({ kind: "editConflict", edit, overwrite: () => void saveEdit(edit, true) });
      else void run(() => Promise.reject(e));
    }
  }

  async function closeEdit(edit: EditStatus) {
    if (edit.changed && !window.confirm(msg.files.editCloseUnsaved)) return;
    await filesApi.editClose(edit.editId).catch(() => undefined);
    setEdits((list) => list.filter((e) => e.editId !== edit.editId));
  }

  /** Lists a pane again once a transfer into the folder it shows has finished. */
  const relist = (pane: "remote" | "local", shown: string | null) => () => {
    if (!sessionId) return;
    const m = panelMemory.get(sessionId);
    const now = pane === "remote" ? (m.view.folder?.loc.kind === "remote" ? m.view.folder.loc.path : null) : JSON.stringify(m.localView.folder?.loc ?? null);
    if (now === shown) setRefresh((r) => ({ ...r, [pane]: r[pane] + 1 }));
  };

  async function chooseLocal() {
    const pick = await run(() => filesApi.pickFolder());
    if (pick) change((m) => ({ ...m, localRoot: { kind: "local", token: pick.token, rootName: pick.name, path: [] }, localView: emptyView() }));
  }

  const toLocal = (entries: RemoteEntry[], at: string) => {
    if (!sessionId || !localAt) return;
    for (const entry of entries) queue.run(downloadJob(sessionId, at, entry, localAt.token, localAt.path, relist("local", JSON.stringify(localAt))));
  };
  const toServer = (entries: RemoteEntry[], from: LocalRoot) => {
    if (!sessionId || !dir) return;
    for (const entry of entries) queue.run(uploadJob(sessionId, from.token, dir, entry.name, entry.kind === "dir", [...from.path, entry.name], relist("remote", dir)));
  };

  const rowExtras = (entries: RemoteEntry[], loc: Loc): MenuEntry[] => {
    if (loc.kind !== "remote") return [];
    const one = entries.length === 1 ? entries[0] : undefined;
    return [
      ...(one?.kind === "file" ? [{ label: msgFiles.edit, icon: <IconPencil size={15} />, onSelect: () => void editEntry(one, loc.path) }] : []),
      ...(one && (one.kind === "file" || one.kind === "dir") && others.length > 0
        ? [{ label: msgFiles.copyTo, icon: <IconCopy size={15} />, onSelect: () => setPrompt({ kind: "copy", entry: one, dir: loc.path, others }) }]
        : []),
    ];
  };

  const menuExtras: MenuEntry[] = [
    { label: msgFiles.showLocal, checked: twoPane, onSelect: () => change((m) => ({ ...m, twoPane: !m.twoPane })) },
    ...(onOpenSftp ? [{ label: msgSftp.openInPanel, icon: <IconArrowLeftRight size={15} />, onSelect: () => onOpenSftp(dir) }] : []),
  ];

  // Closing, the panel fades and drifts back toward its edge (lib/exitGhost).
  const exitRef = useExit<HTMLElement>({ transform: "translateX(4px)" });
  return (
    <aside
      ref={exitRef}
      className={`side-panel side-panel-wide fp${twoPane ? " side-panel-two" : ""}`}
      aria-label={msg.files.panel}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !(event.target as HTMLElement).closest("dialog, [role='menu']")) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head fp-head">
        <h2>
          {msg.files.panel}
          {target && (
            <span className="fp-target" role="status" aria-label="Target">
              {msgFiles.on(target.label)}
            </span>
          )}
        </h2>
        <IconButton size="sm" data-tooltip-side="bottom-end" label={msg.files.close} onClick={onClose}>
          <IconX size={15} />
        </IconButton>
      </div>

      {!target || !sessionId ? (
        <div className="panel-body">
          <Notice tone="info">{msg.files.noSession}</Notice>
        </div>
      ) : (
        <>
          <ErrorNotice error={error} />
          <div className="files-panes">
            {twoPane && (
              <FilePane
                id="local"
                label={msg.files.local}
                backend={local}
                view={localView}
                setView={setLocalView}
                start={localRoot}
                compact
                refreshKey={refresh.local}
                placeholder={
                  <div className="ft-state">
                    <IconHardDrive size={24} />
                    <strong>{msg.files.localNone}</strong>
                    <span>{msgFiles.localBody}</span>
                    <button type="button" className="btn btn-sm" onClick={() => void chooseLocal()} disabled={pending}>
                      <IconFolderOpen size={14} /> {msg.files.localChoose}
                    </button>
                  </div>
                }
                menuExtras={[{ label: msg.files.localChange, icon: <IconFolderOpen size={15} />, onSelect: () => void chooseLocal() }]}
                copyOther={dir && localAt ? { label: msgFiles.copyToOther(target.label), run: (entries) => toServer(entries, localAt) } : null}
                drop={{
                  accepts: (types) => types.includes(FILE_DRAG),
                  onDrop: (data, loc) => {
                    const dragged = JSON.parse(data.getData(FILE_DRAG) || "null") as FileDrag | null;
                    if (dragged?.pane === "remote" && dir && loc.kind === "local") toLocal(dragged.entries, dir);
                  },
                  hint: msgFiles.dropInto(msg.files.local),
                }}
              />
            )}
            <FilePane
              id="remote"
              label={msgFiles.serverPane(target.label)}
              backend={backend}
              view={view}
              setView={setView}
              start={start}
              compact={!twoPane}
              autoFocus
              refreshKey={refresh.remote}
              goRequest={goShell}
              tools={
                shellFolder ? (
                  <IconButton
                    size="sm"
                    label={msg.files.shellFolder(shellFolder)}
                    disabled={dir === shellFolder}
                    onClick={() => setGoShell((g) => ({ loc: { kind: "remote", path: shellFolder }, seq: (g?.seq ?? 0) + 1 }))}
                  >
                    <IconSquareTerminal size={15} />
                  </IconButton>
                ) : null
              }
              menuExtras={menuExtras}
              rowExtras={rowExtras}
              onDownload={async (entries, loc) => {
                if (loc.kind !== "remote") return;
                const folder = await run(() => filesApi.pickFolder());
                if (folder) for (const entry of entries) queue.run(downloadJob(sessionId, loc.path, entry, folder.token, null));
              }}
              onUpload={async (loc) => {
                if (loc.kind !== "remote") return;
                const picks = await run(() => filesApi.pickUpload());
                for (const pick of picks ?? []) queue.run(uploadJob(sessionId, pick.token, loc.path, pick.name, false, null, relist("remote", loc.path)));
              }}
              onUploadFolder={async (loc) => {
                if (loc.kind !== "remote") return;
                const pick = await run(() => filesApi.pickUploadFolder());
                if (pick) queue.run(uploadJob(sessionId, pick.token, loc.path, pick.name, true, null, relist("remote", loc.path)));
              }}
              onDownloadFolder={async (folder) => {
                const loc = folder.loc;
                if (loc.kind !== "remote" || loc.path === "/") return;
                const parent = loc.path.slice(0, loc.path.lastIndexOf("/")) || "/";
                const name = loc.path.slice(loc.path.lastIndexOf("/") + 1);
                const pick = await run(() => filesApi.pickFolder());
                if (pick) queue.run(downloadJob(sessionId, parent, { name, kind: "dir", size: null, permissions: null, modified: null }, pick.token, null));
              }}
              onDuplicate={(entries, loc) => {
                if (loc.kind !== "remote") return;
                for (const entry of entries) queue.run(copyJob(sessionId, loc.path, entry, sessionId, loc.path, relist("remote", loc.path)));
              }}
              copyOther={twoPane && localAt && dir ? { label: msgFiles.copyToOther(msg.files.local), run: (entries) => toLocal(entries, dir) } : null}
              drop={{
                accepts: (types) => types.includes(FILE_DRAG) || types.includes("Files"),
                onDrop: (data, loc) => {
                  if (loc.kind !== "remote") return;
                  const raw = data.getData(FILE_DRAG);
                  if (raw) {
                    const dragged = JSON.parse(raw) as FileDrag;
                    if (dragged.pane === "local" && localAt) toServer(dragged.entries, localAt);
                    return;
                  }
                  const { files, folders } = droppedFiles(data);
                  for (const name of folders) queue.refuse(name, "upload", msg.files.dropFolder);
                  for (const file of files) queue.run(droppedFileJob(sessionId, loc.path, file, relist("remote", loc.path)));
                },
                hint: msgFiles.dropInto(target.label),
              }}
            />
          </div>

          {edits.length > 0 && (
            <section className="xfer fp-edits" aria-label={msg.files.editing} data-open>
              <div className="xfer-head">
                <span className="xfer-toggle">
                  <span className="xfer-title">{msg.files.editing}</span>
                </span>
              </div>
              <ul className="xfer-list">
                {edits.map((e) => (
                  <li key={e.editId} className="xfer-row" data-state={e.changed ? "changed" : "clean"}>
                    <span className="xfer-icon" aria-hidden="true">
                      <IconPencil size={14} />
                    </span>
                    <span className="xfer-name">{visibleName(e.name)}</span>
                    <span className="xfer-end">
                      <button type="button" className="btn btn-sm btn-primary" disabled={!e.changed} onClick={() => void saveEdit(e, false)} aria-label={msg.files.editSave(e.name)}>
                        <IconUpload size={13} />
                      </button>
                      <IconButton size="sm" label={msg.files.editClose(e.name)} onClick={() => void closeEdit(e)}>
                        <IconX size={13} />
                      </IconButton>
                    </span>
                    <span className="xfer-detail" data-testid="edit-state">
                      {e.changed ? msg.files.editChanged : e.saved ? msg.files.editSaved : msg.files.editUnchanged}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <TransferDrawer transfers={transfers} onCancel={queue.cancel} onRetry={queue.retry} onClear={queue.clear} />
          {queue.dialog}
        </>
      )}

      {prompt?.kind === "editConflict" && (
        <Dialog title={msg.files.editConflictTitle(prompt.edit.name)} role="alertdialog" tone="danger" icon={<IconTriangleAlert size={18} />} onDismiss={() => setPrompt(null)}>
          <div className="stack">
            <p>{msg.files.editConflictBody}</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setPrompt(null)} data-autofocus>
                {msg.common.cancel}
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                onClick={() => {
                  prompt.overwrite();
                  setPrompt(null);
                }}
              >
                {msg.files.editOverwrite}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {prompt?.kind === "copy" && sessionId && (
        <CopyDialog
          prompt={{
            entry: prompt.entry,
            others: prompt.others,
            start: (dst, dstDir) => queue.run(copyJob(sessionId, prompt.dir, prompt.entry, dst.sessionId, dstDir)),
          }}
          onDone={() => setPrompt(null)}
        />
      )}
    </aside>
  );
}

function CopyDialog({
  prompt,
  onDone,
}: {
  prompt: { entry: RemoteEntry; others: FilesTarget[]; start: (dst: FilesTarget, dir: string) => void };
  onDone: () => void;
}) {
  const [targetId, setTargetId] = useState(prompt.others[0]?.sessionId ?? "");
  const [dir, setDir] = useState("");
  const { error, run } = useAction();
  // Start in the chosen server's login folder.
  useEffect(() => {
    if (!targetId) return;
    void run(() => filesApi.list(targetId, null)).then((listing) => listing && setDir(listing.path));
  }, [targetId, run]);
  const target = prompt.others.find((o) => o.sessionId === targetId);
  return (
    <Dialog title={msg.files.copyTitle(prompt.entry.name)} icon={<IconCopy size={18} />} onDismiss={onDone}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (target && dir.startsWith("/")) {
            prompt.start(target, dir);
            onDone();
          }
        }}
      >
        <label className="field">
          <span className="label">{msg.files.copyTarget}</span>
          <select className="select" value={targetId} onChange={(event) => setTargetId(event.target.value)} data-autofocus>
            {prompt.others.map((o) => (
              <option key={o.sessionId} value={o.sessionId}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <TextField label={msg.files.copyFolder} value={dir} onChange={setDir} className="mono" />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onDone}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!target || !dir.startsWith("/")}>
            {msg.files.copyStart}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

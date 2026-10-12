import type {
  ConflictChoice,
  EditStatus,
  LocalListing,
  RemoteEntry,
  RemoteListing,
  StreamUpload,
  TransferDirection,
  TransferEvent,
  TransferStarted,
} from "@tyrminal/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, IconButton, Notice, Shortcut, Switch, TextField } from "../../components/ui/controls";
import {
  IconCopy,
  IconDownload,
  IconEye,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconFolderUp,
  IconHardDrive,
  IconLink2,
  IconPanelRightClose,
  IconPencil,
  IconRefreshCw,
  IconSlidersHorizontal,
  IconSquareTerminal,
  IconTrash2,
  IconUpload,
  IconX,
} from "../../components/ui/icons";
import { AppError, files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { shellContexts } from "../autocomplete/shellContext";
import { beginUpload, sendUpload } from "./dropUpload";
import { DRAG_TYPE, type LocalLocation, LocalPane } from "./LocalPane";
import { KeyedMemory, useMemory } from "./memory";

/** Transfer ids of dropped-file uploads (cancelled in the page, not by the core's transfer id). */
const DROP_PREFIX = "drop-";

export interface FilesTarget {
  sessionId: string;
  label: string;
}

interface Transfer {
  id: string;
  name: string;
  direction: TransferDirection;
  total: number | null;
  done: number;
  state: "running" | "done" | "cancelled" | "failed";
  error?: string;
  /** Files copied and links/special files skipped (folders only). */
  files?: number;
  skipped?: number;
  /** Remote folder the transfer touches (refreshed when an upload finishes there). */
  dir: string;
}

type Edit = EditStatus & { saved?: boolean | undefined };

/** What the panel shows for one session; it stays while the session lives (see `panelMemory`). */
export interface PanelMemory {
  listing: RemoteListing | null;
  pathText: string;
  selected: string | null;
  showHidden: boolean;
  twoPane: boolean;
  scrollTop: number;
  local: LocalListing | null;
  localSelection: RemoteEntry | null;
  transfers: Transfer[];
  edits: Edit[];
}

const emptyMemory = (): PanelMemory => ({
  listing: null,
  pathText: "",
  selected: null,
  showHidden: false,
  twoPane: false,
  scrollTop: 0,
  local: null,
  localSelection: null,
  transfers: [],
  edits: [],
});

const NO_SESSION = emptyMemory();

/**
 * Per-session panel state. Switching tabs unmounts the panel; coming back shows the same folder,
 * selection, scroll position and transfers without listing again. The shell drops a session's
 * entry when the session ends.
 */
export const panelMemory = new KeyedMemory<PanelMemory>(emptyMemory);

type Prompt =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete"; entry: RemoteEntry }
  | { kind: "replace"; name: string; remote: boolean; retry: (() => void) | null; keepBoth: () => void }
  | { kind: "editConflict"; edit: EditStatus; overwrite: () => void }
  | { kind: "copy"; entry: RemoteEntry; others: FilesTarget[]; start: (dst: FilesTarget, dir: string) => void };

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function modeText(mode: number | null): string {
  if (mode == null) return "";
  return mode.toString(8).padStart(3, "0");
}

/** Shows server-supplied names safely: control characters become visible escapes. */
function visibleName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters.
  return name.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "dir") return <IconFolder size={15} />;
  if (entry.kind === "symlink") return <IconLink2 size={15} />;
  return <IconFile size={15} />;
}

/**
 * Remote file browser for the focused SSH session. Every action is explicit; transfers never
 * replace an existing file without asking, and show their progress until they end.
 */
export function FilesPanel({
  target,
  others = [],
  onClose,
}: {
  target: FilesTarget | null;
  /** Other connected SSH sessions in this window, for copying between servers. */
  others?: FilesTarget[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sessionId = target?.sessionId ?? null;
  const [memory, change] = useMemory(panelMemory, sessionId, NO_SESSION);
  const { listing, pathText, selected, showHidden, twoPane, transfers, edits, local, localSelection } = memory;
  const set = useCallback(
    <K extends keyof PanelMemory>(key: K, value: PanelMemory[K] | ((previous: PanelMemory[K]) => PanelMemory[K])) =>
      change((m) => ({ ...m, [key]: typeof value === "function" ? (value as (p: PanelMemory[K]) => PanelMemory[K])(m[key]) : value })),
    [change],
  );
  const setTransfers = (value: (list: Transfer[]) => Transfer[]) => set("transfers", value);
  const setEdits = (value: (list: Edit[]) => Edit[]) => set("edits", value);
  const setSelected = (name: string | null) => set("selected", name);
  const setPathText = (text: string) => set("pathText", text);
  const setShowHidden = (on: boolean) => set("showHidden", on);
  const setTwoPane = (on: boolean) => set("twoPane", on);
  const setLocalSelection = (entry: RemoteEntry | null) => set("localSelection", entry);
  const localLocation: LocalLocation | null = local ? { token: local.token, path: local.path } : null;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [remoteDrop, setRemoteDrop] = useState(false);
  /** Dropped-file uploads the user cancelled (stopped before their next piece). */
  const stopped = useRef(new Set<string>());
  const { pending, error, run } = useAction();

  // The shell's current folder, when the shell integration reports it (AUT-06).
  const shellFolder = useSyncExternalStore(shellContexts.subscribe, () => (sessionId ? (shellContexts.get(sessionId)?.cwd ?? null) : null));

  const show = useCallback(
    (result: RemoteListing) => {
      change((m) => {
        // Refreshing the same folder keeps the selection (while the entry is still there) and
        // the scroll position; another folder starts at the top.
        const same = m.listing?.path === result.path;
        const selected = same && result.entries.some((e) => e.name === m.selected) ? m.selected : null;
        return { ...m, listing: result, pathText: result.path, selected, scrollTop: same ? m.scrollTop : 0 };
      });
    },
    [change],
  );

  const load = useCallback(
    async (path: string | null) => {
      if (!sessionId) return;
      const result = await run(() => filesApi.list(sessionId, path));
      if (result) show(result);
    },
    [sessionId, run, show],
  );

  // A session seen for the first time starts in its shell's folder when the shell integration
  // reports it, else at its login folder (also when the shell's folder cannot be listed). One
  // seen before shows what it showed then: switching tabs never lists again, only Refresh or
  // moving to a folder does.
  useEffect(() => {
    if (!sessionId || panelMemory.get(sessionId).listing !== null) return;
    let live = true;
    const start = shellContexts.get(sessionId)?.cwd ?? null;
    if (start) {
      filesApi.list(sessionId, start).then(
        (result) => live && show(result),
        () => live && void load(null),
      );
    } else void load(null);
    return () => {
      live = false;
    };
  }, [sessionId, load, show]);

  // The scroll position comes back with the listing.
  useLayoutEffect(() => {
    if (bodyRef.current && sessionId) bodyRef.current.scrollTop = panelMemory.get(sessionId).scrollTop;
  }, [sessionId, listing]);

  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[name="remote-path"]')?.focus();
  }, []);

  // Open edits: their local copies are watched while the panel is open (nothing uploads by itself).
  const editIds = edits.map((e) => e.editId).join(",");
  useEffect(() => {
    if (!editIds) return;
    const timer = window.setInterval(() => {
      for (const id of editIds.split(",")) {
        filesApi
          .editStatus(id)
          .then((status) =>
            setEdits((list) => list.map((e) => (e.editId === id ? { ...status, saved: status.changed ? false : e.saved } : e))),
          )
          .catch(() => setEdits((list) => list.filter((e) => e.editId !== id)));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [editIds]);

  async function editSelected() {
    if (!sessionId || !current || !selection) return;
    const opened = await run(() => filesApi.editOpen(sessionId, current, selection.name));
    if (opened) setEdits((list) => [...list, opened]);
  }

  async function saveEdit(edit: EditStatus, overwrite: boolean) {
    try {
      const status = await filesApi.editSave(edit.editId, overwrite);
      setEdits((list) => list.map((e) => (e.editId === edit.editId ? { ...status, saved: true } : e)));
      if (current) void load(current);
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

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
  const current = listing?.path ?? null;
  const selection = entries.find((e) => e.name === selected) ?? null;

  function track(started: TransferStarted, dir: string) {
    setTransfers((list) => [
      ...list,
      { id: started.transferId, name: started.name, direction: started.direction, total: started.total, done: 0, state: "running", dir },
    ]);
  }

  function apply(transferId: string, dir: string, upload: boolean, event: TransferEvent) {
    setTransfers((list) =>
      list.map((t) => {
        if (t.id !== transferId) return t;
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
    // An upload changes the folder it went to; a download changes nothing on the server.
    if (event.type === "done" && upload && sessionId && panelMemory.get(sessionId).listing?.path === dir) void load(dir);
  }

  /** Lists the local pane's folder again (a download into it finished). */
  async function refreshLocal() {
    const shown = sessionId ? panelMemory.get(sessionId).local : null;
    if (!shown) return;
    const result = await filesApi.localList(shown.token, shown.path).catch(() => null);
    if (result) change((m) => (m.local === shown ? { ...m, local: result } : m));
  }

  /**
   * Events can arrive before the call that started the transfer returns its id (a small file
   * may even finish first); they are held until the transfer is listed, then applied in order.
   */
  function listener(dir: string, upload: boolean, intoLocalPane = false) {
    let bound: string | null = null;
    const early: TransferEvent[] = [];
    return {
      onEvent: (event: TransferEvent) => {
        if (intoLocalPane && event.type === "done") void refreshLocal();
        if (bound) apply(bound, dir, upload, event);
        else early.push(event);
      },
      bind: (started: TransferStarted) => {
        track(started, dir);
        bound = started.transferId;
        for (const event of early.splice(0)) apply(started.transferId, dir, upload, event);
      },
    };
  }

  async function startUpload(token: string, name: string, dir: string, choice: ConflictChoice, folder = false, path: string[] | null = null) {
    if (!sessionId) return;
    const events = listener(dir, true);
    try {
      events.bind(await filesApi.upload(sessionId, token, dir, choice, events.onEvent, path));
    } catch (caught) {
      const e = toAppError(caught);
      // Folders are never merged into or replace an existing one: they can only keep both.
      if (e.code === "CONFLICT" && choice === "ask") {
        setPrompt({
          kind: "replace",
          name,
          remote: true,
          retry: folder ? null : () => void startUpload(token, name, dir, "replace", false, path),
          keepBoth: () => void startUpload(token, name, dir, "keep_both", folder, path),
        });
      } else {
        failNow(name, "upload", dir, e);
      }
    }
  }

  async function startDownload(entry: RemoteEntry, dir: string, token: string, choice: ConflictChoice, path: string[] | null = null) {
    if (!sessionId) return;
    const events = listener(dir, false, path !== null);
    try {
      events.bind(await filesApi.download(sessionId, dir, entry.name, token, choice, events.onEvent, path));
    } catch (caught) {
      const e = toAppError(caught);
      if (e.code === "CONFLICT" && choice === "ask") {
        setPrompt({
          kind: "replace",
          name: entry.name,
          remote: false,
          retry: entry.kind === "dir" ? null : () => void startDownload(entry, dir, token, "replace", path),
          keepBoth: () => void startDownload(entry, dir, token, "keep_both", path),
        });
      } else {
        failNow(entry.name, "download", dir, e);
      }
    }
  }

  /**
   * Files dropped from the desktop: the webview gives the page their content but not their
   * paths, so the page sends it to the core in ordered pieces. Only a complete upload is renamed
   * into place on the server; anything else removes the partial file.
   */
  async function uploadDropped(file: File, dir: string, choice: ConflictChoice) {
    if (!sessionId) return;
    let started: StreamUpload;
    try {
      started = await beginUpload(sessionId, dir, file, choice);
    } catch (caught) {
      const e = toAppError(caught);
      if (e.code === "CONFLICT" && choice === "ask") {
        setPrompt({
          kind: "replace",
          name: file.name,
          remote: true,
          retry: () => void uploadDropped(file, dir, "replace"),
          keepBoth: () => void uploadDropped(file, dir, "keep_both"),
        });
      } else {
        failNow(file.name, "upload", dir, e);
      }
      return;
    }
    const id = `${DROP_PREFIX}${started.uploadId}`;
    track({ transferId: id, name: started.name, direction: "upload", total: file.size }, dir);
    try {
      const completed = await sendUpload(started, file, {
        onProgress: (done) => apply(id, dir, true, { type: "progress", done }),
        shouldStop: () => stopped.current.delete(id),
      });
      apply(id, dir, true, completed ? { type: "done", bytes: file.size, files: 1, skipped: 0 } : { type: "cancelled" });
    } catch (caught) {
      const e = toAppError(caught);
      apply(id, dir, true, { type: "failed", error: { code: e.code, message: e.message } });
    }
  }

  function droppedFiles(transfer: DataTransfer) {
    if (!current) return;
    const items = Array.from(transfer.items ?? []);
    const list = Array.from(transfer.files);
    list.forEach((file, i) => {
      // A dropped folder arrives as an empty "file"; folders go through Upload folder instead.
      const entry = items[i]?.webkitGetAsEntry?.();
      if (entry?.isDirectory) failNow(file.name, "upload", current, new AppError({ code: "INVALID_INPUT", message: msg.files.dropFolder }));
      else void uploadDropped(file, current, "ask");
    });
  }

  /** A transfer refused before it started still shows up in the list, with the reason. */
  function failNow(name: string, direction: TransferDirection, dir: string, e: AppError) {
    setTransfers((list) => [
      ...list,
      { id: `refused-${Date.now()}-${list.length}`, name, direction, total: null, done: 0, state: "failed", error: e.message, dir },
    ]);
  }

  async function startCopy(entry: RemoteEntry, dst: FilesTarget, dstDir: string, choice: ConflictChoice) {
    if (!sessionId || !current) return;
    const events = listener(dstDir, false);
    const srcDir = current;
    try {
      events.bind(await filesApi.copy(sessionId, srcDir, entry.name, dst.sessionId, dstDir, choice, events.onEvent));
    } catch (caught) {
      const e = toAppError(caught);
      if (e.code === "CONFLICT" && choice === "ask") {
        setPrompt({
          kind: "replace",
          name: entry.name,
          remote: true,
          retry: entry.kind === "dir" ? null : () => void startCopy(entry, dst, dstDir, "replace"),
          keepBoth: () => void startCopy(entry, dst, dstDir, "keep_both"),
        });
      } else {
        failNow(entry.name, "copy", dstDir, e);
      }
    }
  }

  /** Two-pane copy: local selection (or a dropped local name) to the server folder shown. */
  async function uploadFromLocal(name: string, kind: RemoteEntry["kind"]) {
    if (!current || !localLocation) return;
    await startUpload(localLocation.token, name, current, "ask", kind === "dir", [...localLocation.path, name]);
  }

  /** Two-pane copy: a remote file or folder to the local folder shown. */
  async function downloadToLocal(entry: RemoteEntry) {
    if (!current || !localLocation) return;
    await startDownload(entry, current, localLocation.token, "ask", localLocation.path);
  }

  async function upload() {
    if (!current) return;
    const picks = await run(() => filesApi.pickUpload());
    for (const pick of picks ?? []) await startUpload(pick.token, pick.name, current, "ask");
  }

  async function uploadFolder() {
    if (!current) return;
    const pick = await run(() => filesApi.pickUploadFolder());
    if (pick) await startUpload(pick.token, pick.name, current, "ask", true);
  }

  /** Downloads the folder being shown, with everything in it. */
  async function downloadFolder() {
    if (!listing?.parent) return;
    const name = listing.path.slice(listing.path.lastIndexOf("/") + 1);
    const folder = await run(() => filesApi.pickFolder());
    if (folder) {
      const entry: RemoteEntry = { name, kind: "dir", size: null, permissions: null, modified: null };
      await startDownload(entry, listing.parent, folder.token, "ask");
    }
  }

  async function download() {
    if (!current || !selection) return;
    const folder = await run(() => filesApi.pickFolder());
    if (folder) await startDownload(selection, current, folder.token, "ask");
  }

  function activate(entry: RemoteEntry) {
    if (!current) return;
    if (entry.kind === "dir" || entry.kind === "symlink") {
      const next = `${current.replace(/\/+$/, "")}/${entry.name}`;
      void load(next);
    } else {
      setSelected(entry.name);
    }
  }

  return (
    <aside
      ref={ref}
      className={`side-panel side-panel-wide${twoPane ? " side-panel-two" : ""}`}
      aria-label={msg.files.panel}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target as HTMLElement).closest("dialog")) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head">
        <h2>{msg.files.panel}</h2>
        <Shortcut action="toggleFiles" />
        <IconButton label={msg.files.close} onClick={onClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </div>

      {!target ? (
        <div className="panel-body">
          <Notice tone="info">{msg.files.noSession}</Notice>
        </div>
      ) : (
        <>
          <div className="files-bar">
            <span className="muted files-target" role="status" aria-label="Target">
              <IconHardDrive size={13} /> {msg.files.on(target.label)}
            </span>
            <form
              className="files-path"
              onSubmit={(event) => {
                event.preventDefault();
                const path = pathText.trim();
                if (path) void load(path);
              }}
            >
              <IconButton label={msg.files.up} onClick={() => listing?.parent && void load(listing.parent)} disabled={!listing?.parent || pending}>
                <span aria-hidden="true">↑</span>
              </IconButton>
              <input
                name="remote-path"
                className="input mono"
                aria-label={msg.files.path}
                value={pathText}
                onChange={(event) => setPathText(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {shellFolder && (
                <IconButton label={msg.files.shellFolder(shellFolder)} onClick={() => void load(shellFolder)} disabled={pending || current === shellFolder}>
                  <IconSquareTerminal size={15} />
                </IconButton>
              )}
              <IconButton label={msg.files.refresh} onClick={() => current && void load(current)} disabled={!current || pending}>
                <IconRefreshCw size={15} />
              </IconButton>
            </form>
            <div className="files-actions">
              <button type="button" className="btn btn-sm" onClick={() => void upload()} disabled={!current || pending}>
                <IconUpload size={14} /> {msg.files.upload}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void uploadFolder()} disabled={!current || pending}>
                <IconFolderUp size={14} /> {msg.files.uploadFolder}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void downloadFolder()} disabled={!listing?.parent || pending}>
                <IconDownload size={14} /> {msg.files.downloadFolder}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setPrompt({ kind: "mkdir" })} disabled={!current || pending}>
                <IconFolderPlus size={14} /> {msg.files.newFolder}
              </button>
              <span className="spacer" />
              <Switch label={msg.files.twoPane} checked={twoPane} onChange={setTwoPane} />
              <Switch label={msg.files.showHidden} checked={showHidden} onChange={setShowHidden} />
            </div>
            {selection && (
              <div className="files-actions" aria-label={selection.name}>
                {twoPane && localLocation && (selection.kind === "file" || selection.kind === "dir") && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void downloadToLocal(selection)} disabled={pending}>
                    <IconDownload size={14} /> {msg.files.toLocal}
                  </button>
                )}
                {selection.kind === "file" && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void download()} disabled={pending}>
                    <IconDownload size={14} /> {msg.files.download}
                  </button>
                )}
                {selection.kind === "file" && (
                  <button type="button" className="btn btn-sm" onClick={() => void editSelected()} disabled={pending}>
                    <IconPencil size={14} /> {msg.files.edit}
                  </button>
                )}
                {(selection.kind === "file" || selection.kind === "dir") && others.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setPrompt({ kind: "copy", entry: selection, others, start: (dst, dir) => void startCopy(selection, dst, dir, "ask") })}
                  >
                    {msg.files.copyTo}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => setPrompt({ kind: "rename", entry: selection })}>
                  <IconPencil size={14} /> {msg.files.rename}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setPrompt({ kind: "chmod", entry: selection })}>
                  <IconSlidersHorizontal size={14} /> {msg.files.permissions}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setPrompt({ kind: "delete", entry: selection })}>
                  <IconTrash2 size={14} /> {msg.files.delete}
                </button>
              </div>
            )}
          </div>

          <div className="files-panes">
          {twoPane && (
            <div className="files-local-col">
              <LocalPane
                selected={localSelection?.name ?? null}
                listing={local}
                onListing={(listing) => change((m) => ({ ...m, local: listing, localSelection: null }))}
                onSelect={setLocalSelection}
                onDropRemote={(name) => {
                  const entry = listing?.entries.find((e) => e.name === name);
                  if (entry) void downloadToLocal(entry);
                }}
              />
              {localSelection && localLocation && current && (localSelection.kind === "file" || localSelection.kind === "dir") && (
                <div className="files-actions files-local-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void uploadFromLocal(localSelection.name, localSelection.kind)}>
                    <IconUpload size={14} /> {msg.files.toServer}
                  </button>
                </div>
              )}
            </div>
          )}
          <div
            ref={bodyRef}
            className="panel-body files-body"
            onScroll={(event) => {
              // Kept without re-rendering; read back when the panel shows this session again.
              if (sessionId && panelMemory.has(sessionId)) panelMemory.get(sessionId).scrollTop = event.currentTarget.scrollTop;
            }}
            data-drop={remoteDrop || undefined}
            onDragOver={(event) => {
              const types = event.dataTransfer.types;
              if ((twoPane && types.includes(DRAG_TYPE)) || (listing && types.includes("Files"))) {
                event.preventDefault();
                setRemoteDrop(true);
              }
            }}
            onDragLeave={() => setRemoteDrop(false)}
            onDrop={(event) => {
              setRemoteDrop(false);
              if (event.dataTransfer.files.length > 0 && !event.dataTransfer.types.includes(DRAG_TYPE)) {
                event.preventDefault();
                droppedFiles(event.dataTransfer);
                return;
              }
              const raw = event.dataTransfer.getData(DRAG_TYPE);
              if (!raw) return;
              event.preventDefault();
              const data = JSON.parse(raw) as { side: string; name: string };
              const local = data.side === "local" ? (localSelection?.name === data.name ? localSelection : null) : null;
              if (data.side === "local") void uploadFromLocal(data.name, local?.kind ?? "file");
            }}
          >
            <ErrorNotice error={error} />
            {listing?.truncated && <Notice tone="warning">{msg.files.truncated(listing.entries.length)}</Notice>}
            {listing && entries.length === 0 && <p className="muted">{msg.files.empty}</p>}
            {listing && entries.length > 0 && (
              <ul className="files-list" aria-label={msg.files.listLabel(listing.path)}>
                {entries.map((entry) => (
                  <li key={entry.name} data-selected={entry.name === selected || undefined}>
                    <button
                      type="button"
                      className="files-row"
                      aria-label={entry.kind === "dir" ? msg.files.open(entry.name) : msg.files.select(entry.name)}
                      aria-pressed={entry.kind === "dir" ? undefined : entry.name === selected}
                      onClick={() => (entry.kind === "dir" ? activate(entry) : setSelected(entry.name === selected ? null : entry.name))}
                      onDoubleClick={() => activate(entry)}
                      draggable={twoPane && (entry.kind === "file" || entry.kind === "dir")}
                      onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ side: "remote", name: entry.name }))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && entry.kind === "symlink") {
                          event.preventDefault();
                          activate(entry);
                        }
                      }}
                    >
                      <span className={`files-icon files-icon-${entry.kind}`}>
                        <EntryIcon entry={entry} />
                      </span>
                      <span className="files-name">{visibleName(entry.name)}</span>
                      <span className="files-meta mono">{entry.kind === "dir" ? "" : formatSize(entry.size)}</span>
                      <span className="files-meta mono" title={msg.files.permissions}>
                        {modeText(entry.permissions)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          </div>

          {edits.length > 0 && (
            <section className="files-transfers" aria-label={msg.files.editing}>
              <div className="files-transfers-head">
                <h3>{msg.files.editing}</h3>
              </div>
              <ul>
                {edits.map((e) => (
                  <li key={e.editId} className="files-transfer" data-state={e.changed ? "changed" : "clean"}>
                    <span className="files-transfer-icon">
                      <IconPencil size={13} />
                    </span>
                    <span className="files-name">{visibleName(e.name)}</span>
                    <span className="files-meta" data-testid="edit-state">
                      {e.changed ? msg.files.editChanged : e.saved ? msg.files.editSaved : msg.files.editUnchanged}
                    </span>
                    <span className="files-edit-actions">
                      <button type="button" className="btn btn-sm btn-primary" disabled={!e.changed} onClick={() => void saveEdit(e, false)} aria-label={msg.files.editSave(e.name)}>
                        <IconUpload size={13} />
                      </button>
                      <IconButton label={msg.files.editClose(e.name)} onClick={() => void closeEdit(e)}>
                        <IconX size={14} />
                      </IconButton>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {transfers.length > 0 && (
            <section className="files-transfers" aria-label={msg.files.transfers}>
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
                        <IconButton label={msg.files.cancelTransfer(t.name)} onClick={() => {
                          if (t.id.startsWith(DROP_PREFIX)) stopped.current.add(t.id);
                          else void filesApi.cancel(t.id).catch(() => undefined);
                        }}>
                          <IconX size={14} />
                        </IconButton>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {prompt && target && current && (
        <FilesPrompt
          prompt={prompt}
          sessionId={target.sessionId}
          dir={current}
          onDone={(changed) => {
            setPrompt(null);
            if (changed) void load(current);
          }}
        />
      )}
    </aside>
  );
}

function FilesPrompt({
  prompt,
  sessionId,
  dir,
  onDone,
}: {
  prompt: Prompt;
  sessionId: string;
  dir: string;
  onDone: (changed: boolean) => void;
}) {
  const initial =
    prompt.kind === "rename" ? prompt.entry.name : prompt.kind === "chmod" ? modeText(prompt.entry.permissions) : "";
  const [text, setText] = useState(initial);
  const { pending, error, run } = useAction();
  const [invalid, setInvalid] = useState<string | null>(null);

  async function submit() {
    setInvalid(null);
    let ok: unknown;
    switch (prompt.kind) {
      case "mkdir":
        ok = await run(() => filesApi.mkdir(sessionId, dir, text.trim()).then(() => true));
        break;
      case "rename":
        ok = await run(() => filesApi.rename(sessionId, dir, prompt.entry.name, text.trim()).then(() => true));
        break;
      case "chmod": {
        if (!/^[0-7]{3,4}$/.test(text.trim())) {
          setInvalid(msg.files.modeInvalid);
          return;
        }
        const mode = Number.parseInt(text.trim(), 8);
        ok = await run(() => filesApi.chmod(sessionId, dir, prompt.entry.name, mode).then(() => true));
        break;
      }
      case "delete":
        ok = await run(() => filesApi.remove(sessionId, dir, prompt.entry.name).then(() => true));
        break;
      case "replace":
        prompt.retry?.();
        onDone(false);
        return;
      case "editConflict":
        prompt.overwrite();
        onDone(false);
        return;
      case "copy":
        return;
    }
    if (ok) onDone(true);
  }

  if (prompt.kind === "copy") {
    return <CopyDialog prompt={prompt} onDone={() => onDone(false)} />;
  }

  if (prompt.kind === "delete" || prompt.kind === "replace" || prompt.kind === "editConflict") {
    const title =
      prompt.kind === "delete"
        ? msg.files.deleteTitle(prompt.entry.name)
        : prompt.kind === "replace"
          ? msg.files.replaceTitle(prompt.name)
          : msg.files.editConflictTitle(prompt.edit.name);
    const body =
      prompt.kind === "delete"
        ? msg.files.deleteBody
        : prompt.kind === "editConflict"
          ? msg.files.editConflictBody
          : !prompt.retry
            ? msg.files.folderExists
            : prompt.remote
              ? msg.files.replaceRemote
              : msg.files.replaceLocal;
    return (
      <Dialog title={title} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => onDone(false)}>
        <div className="stack">
          <p>{body}</p>
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onDone(false)} data-autofocus>
              {msg.common.cancel}
            </button>
            {prompt.kind === "replace" && (
              <button
                type="button"
                className={prompt.retry ? "btn" : "btn btn-primary"}
                onClick={() => {
                  prompt.keepBoth();
                  onDone(false);
                }}
              >
                {msg.files.keepBoth}
              </button>
            )}
            {(prompt.kind !== "replace" || prompt.retry) && (
              <button type="button" className="btn btn-danger-solid" onClick={() => void submit()} disabled={pending}>
                {prompt.kind === "delete" ? msg.files.delete : prompt.kind === "editConflict" ? msg.files.editOverwrite : msg.files.replace}
              </button>
            )}
          </div>
        </div>
      </Dialog>
    );
  }

  const title =
    prompt.kind === "mkdir"
      ? msg.files.newFolderTitle
      : prompt.kind === "rename"
        ? msg.files.renameTitle(prompt.entry.name)
        : msg.files.permissionsTitle(prompt.entry.name);
  return (
    <Dialog title={title} icon={prompt.kind === "chmod" ? <IconEye size={18} /> : <IconFolderPlus size={18} />} onDismiss={() => onDone(false)}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={prompt.kind === "chmod" ? msg.files.mode : msg.files.name}
          hint={prompt.kind === "chmod" ? msg.files.modeHint : msg.files.nameHint}
          value={text}
          onChange={setText}
          error={invalid ?? undefined}
          autoFocus
          className="mono"
        />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onDone(false)}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending || text.trim() === ""}>
            {prompt.kind === "mkdir" ? msg.files.create : msg.files.save}
          </button>
        </div>
      </form>
    </Dialog>
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

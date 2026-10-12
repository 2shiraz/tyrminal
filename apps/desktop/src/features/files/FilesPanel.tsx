import type { ConflictChoice, EditStatus, LocalListing, RemoteEntry, RemoteListing, StreamUpload, TransferDirection, TransferEvent, TransferStarted } from "@tyrminal/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Menu, type MenuEntry } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { ErrorNotice, IconButton, Keys, Notice, TextField } from "../../components/ui/controls";
import {
  IconClipboardCopy,
  IconCopy,
  IconDownload,
  IconEye,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderUp,
  IconHardDrive,
  IconPencil,
  IconRefreshCw,
  IconSlidersHorizontal,
  IconSquareTerminal,
  IconTrash2,
  IconTriangleAlert,
  IconUpload,
  IconX,
} from "../../components/ui/icons";
import { AppError, files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { shellContexts } from "../autocomplete/shellContext";
import { type Sort, type SortKey, crumbs as crumbsOf, formatSize, visibleEntries, visibleName } from "../sftp/model";
import { beginUpload, sendUpload } from "./dropUpload";
import { FileTable, type MenuAt } from "./FileTable";
import { DRAG_TYPE, type LocalLocation, LocalPane } from "./LocalPane";
import { KeyedMemory, useMemory } from "./memory";
import { msgFiles } from "./messages";
import { PathBar } from "./PathBar";
import { NO_SELECTION, type Selection, pruneSelection, selectionSummary, single } from "./selection";
import { TransferDrawer } from "./TransferDrawer";
import { type Transfer as BaseTransfer, applyEvent, refused, started as startedTransfer } from "./transfers";
import "./files.css";

/** After this long, opening a folder shows a progress bar (the row shows it at once). */
const SLOW_MS = 300;

/** Transfer ids of dropped-file uploads (cancelled in the page, not by the core's transfer id). */
const DROP_PREFIX = "drop-";

export interface FilesTarget {
  sessionId: string;
  label: string;
}

/** A transfer and the server folder it touches (listed again when an upload finishes there). */
type Transfer = BaseTransfer & { dir: string };

type Edit = EditStatus & { saved?: boolean | undefined };

/** What the panel shows for one session; it stays while the session lives (see `panelMemory`). */
export interface PanelMemory {
  listing: RemoteListing | null;
  /** Selected names (several with Shift or Ctrl/Cmd), anchor and keyboard row. */
  selection: Selection;
  showHidden: boolean;
  sort: Sort;
  twoPane: boolean;
  scrollTop: number;
  local: LocalListing | null;
  localSelection: RemoteEntry | null;
  transfers: Transfer[];
  edits: Edit[];
}

const emptyMemory = (): PanelMemory => ({
  listing: null,
  selection: NO_SELECTION,
  showHidden: false,
  sort: { key: "name", ascending: true },
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
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete"; entries: RemoteEntry[] }
  | { kind: "replace"; name: string; remote: boolean; retry: (() => void) | null; keepBoth: () => void }
  | { kind: "editConflict"; edit: EditStatus; overwrite: () => void }
  | { kind: "copy"; entry: RemoteEntry; others: FilesTarget[]; start: (dst: FilesTarget, dir: string) => void };

type OpenMenu = { kind: "upload" | "view"; anchor: HTMLElement } | { kind: "row"; entries: RemoteEntry[]; at: MenuAt } | { kind: "folder"; at: MenuAt };

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
  const { listing, selection: picked, showHidden, sort, twoPane, transfers, edits, local, localSelection } = memory;
  const set = useCallback(
    <K extends keyof PanelMemory>(key: K, value: PanelMemory[K] | ((previous: PanelMemory[K]) => PanelMemory[K])) =>
      change((m) => ({ ...m, [key]: typeof value === "function" ? (value as (p: PanelMemory[K]) => PanelMemory[K])(m[key]) : value })),
    [change],
  );
  const setTransfers = (value: (list: Transfer[]) => Transfer[]) => set("transfers", value);
  const setEdits = (value: (list: Edit[]) => Edit[]) => set("edits", value);
  const setPicked = (next: Selection) => set("selection", next);
  /** The folder being opened (its row and the path show that the click registered). */
  const [opening, setOpening] = useState<string | null>(null);
  /** Opening has taken long enough to show a progress bar. */
  const [slow, setSlow] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editPath, setEditPath] = useState(0);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const localLocation: LocalLocation | null = local ? { token: local.token, path: local.path } : null;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [remoteDrop, setRemoteDrop] = useState(false);
  /** Dropped-file uploads the user cancelled (stopped before their next piece). */
  const stopped = useRef(new Set<string>());
  const { pending, error, run, clearError } = useAction();
  const notify = useToast();

  // The shell's current folder, when the shell integration reports it (AUT-06).
  const shellFolder = useSyncExternalStore(shellContexts.subscribe, () => (sessionId ? (shellContexts.get(sessionId)?.cwd ?? null) : null));

  // Refreshing the same folder keeps the selection (while the entry is still there) and the
  // scroll position; another folder starts at the top.
  const show = useCallback(
    (result: RemoteListing, select?: string) =>
      change((m) => {
        const same = m.listing?.path === result.path;
        const names = result.entries.map((e) => e.name);
        const selection = select && names.includes(select) ? single(select) : same ? pruneSelection(m.selection, names) : NO_SELECTION;
        return { ...m, listing: result, selection, scrollTop: same ? m.scrollTop : 0 };
      }),
    [change],
  );

  const load = useCallback(
    async (path: string | null, select?: string) => {
      if (!sessionId) return;
      const result = await run(() => filesApi.list(sessionId, path));
      if (result) show(result, select);
    },
    [sessionId, run, show],
  );

  // A session seen for the first time opens in its shell's folder when the shell integration
  // reports one, else its login folder (also when the shell's folder cannot be listed). One seen
  // before shows what it showed then: switching tabs never lists again, only Refresh or moving to
  // a folder does.
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

  // Opening the panel puts the keyboard in the list (once it is there), where type-ahead and the
  // arrows work.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !listing) return;
    focused.current = true;
    window.requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".ft-name[tabindex='0']")?.focus());
  }, [listing]);

  // Open edits: their local copies are watched while the panel is open (nothing uploads by itself).
  const editIds = edits.map((e) => e.editId).join(",");
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

  async function editEntry(entry: RemoteEntry) {
    if (!sessionId || !current) return;
    const opened = await run(() => filesApi.editOpen(sessionId, current, entry.name));
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

  const entries = useMemo(() => (listing ? visibleEntries(listing.entries, showHidden, "", sort) : []), [listing, showHidden, sort]);
  const current = listing?.path ?? null;
  const chosen = entries.filter((e) => picked.names.includes(e.name));
  /** The one selected entry, for actions that take a single item. */
  const selection = chosen.length === 1 ? (chosen[0] as RemoteEntry) : null;

  useEffect(() => {
    if (opening === null) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [opening]);

  // ---------- transfers ----------

  function track(started: TransferStarted, dir: string) {
    setTransfers((list) => [...list, { ...startedTransfer(started), dir }]);
  }

  function apply(transferId: string, dir: string, upload: boolean, event: TransferEvent) {
    setTransfers((list) => list.map((t) => (t.id === transferId ? applyEvent(t, event) : t)));
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
    setTransfers((list) => [...list, { ...refused(name, direction, e.message, list.length), dir }]);
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

  /** Downloads the chosen items into one folder picked on this computer. */
  async function download(items: RemoteEntry[]) {
    if (!current || items.length === 0) return;
    const folder = await run(() => filesApi.pickFolder());
    if (folder) for (const entry of items) await startDownload(entry, current, folder.token, "ask");
  }

  async function activate(entry: RemoteEntry) {
    if (!current) return;
    if (entry.kind === "dir" || entry.kind === "symlink") {
      const next = `${current.replace(/\/+$/, "")}/${entry.name}`;
      setOpening(entry.name);
      try {
        await load(next);
      } finally {
        setOpening(null);
      }
    } else {
      setPicked(single(entry.name));
    }
  }

  const up = () => listing?.parent && void load(listing.parent, listing.path.slice(listing.path.lastIndexOf("/") + 1));

  /** Renames in place; a refusal (a name already there) is shown under the field. */
  async function rename(entry: RemoteEntry, name: string): Promise<string | null> {
    if (!sessionId || !current) return null;
    try {
      await filesApi.rename(sessionId, current, entry.name, name);
    } catch (caught) {
      return toAppError(caught).message;
    }
    await load(current, name);
    return null;
  }

  function copyPath(entry: RemoteEntry | null) {
    if (!current) return;
    const path = entry ? `${current.replace(/\/+$/, "")}/${entry.name}` : current;
    void navigator.clipboard.writeText(path).then(
      () => notify("success", msgFiles.pathCopied),
      () => undefined,
    );
  }

  function onSort(key: SortKey) {
    set("sort", (s) => (s.key === key ? { ...s, ascending: !s.ascending } : { key, ascending: true }));
  }

  // ---------- menus ----------

  function rowItems(items: RemoteEntry[]): MenuEntry[] {
    const one = items.length === 1 ? (items[0] as RemoteEntry) : null;
    const movable = items.filter((e) => e.kind === "file" || e.kind === "dir");
    const list: MenuEntry[] = [];
    if (one && (one.kind === "dir" || one.kind === "symlink")) list.push({ label: msgFiles.open, icon: <IconFolderOpen size={15} />, onSelect: () => void activate(one) });
    if (movable.length > 0) list.push({ label: msgFiles.download, icon: <IconDownload size={15} />, onSelect: () => void download(movable) });
    if (twoPane && localLocation && movable.length > 0)
      list.push({ label: msgFiles.toLocal, icon: <IconHardDrive size={15} />, onSelect: () => void Promise.all(movable.map((e) => downloadToLocal(e))) });
    if (one?.kind === "file") list.push({ label: msgFiles.edit, icon: <IconPencil size={15} />, onSelect: () => void editEntry(one) });
    if (one && (one.kind === "file" || one.kind === "dir") && others.length > 0)
      list.push({ label: msgFiles.copyTo, icon: <IconCopy size={15} />, onSelect: () => setPrompt({ kind: "copy", entry: one, others, start: (dst, dir) => void startCopy(one, dst, dir, "ask") }) });
    list.push("separator");
    if (one) {
      list.push({ label: msgFiles.rename, icon: <IconPencil size={15} />, shortcut: <Keys caps={["F2"]} />, onSelect: () => setRenaming(one.name) });
      if (one.kind !== "symlink") list.push({ label: msgFiles.permissions, icon: <IconSlidersHorizontal size={15} />, onSelect: () => setPrompt({ kind: "chmod", entry: one }) });
      list.push({ label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, onSelect: () => copyPath(one) });
      list.push("separator");
    }
    list.push({ label: msgFiles.delete, icon: <IconTrash2 size={15} />, tone: "danger", shortcut: <Keys caps={["Del"]} />, onSelect: () => setPrompt({ kind: "delete", entries: items }) });
    return list[0] === "separator" ? list.slice(1) : list;
  }

  const uploadItems: MenuEntry[] = [
    { label: msgFiles.uploadFiles, icon: <IconUpload size={15} />, disabled: !current, onSelect: () => void upload() },
    { label: msgFiles.uploadFolder, icon: <IconFolderUp size={15} />, disabled: !current, onSelect: () => void uploadFolder() },
    "separator",
    { label: msgFiles.downloadFolder, icon: <IconDownload size={15} />, disabled: !listing?.parent, onSelect: () => void downloadFolder() },
  ];

  const viewItems: MenuEntry[] = [
    { label: msgFiles.showHidden, checked: showHidden, onSelect: () => set("showHidden", (v) => !v) },
    { label: msgFiles.showLocal, checked: twoPane, onSelect: () => set("twoPane", (v) => !v) },
  ];

  const folderItems: MenuEntry[] = [
    { label: msgFiles.newFolder, icon: <IconFolderPlus size={15} />, disabled: !current, onSelect: () => setPrompt({ kind: "mkdir" }) },
    { label: msgFiles.uploadFiles, icon: <IconUpload size={15} />, disabled: !current, onSelect: () => void upload() },
    { label: msgFiles.uploadFolder, icon: <IconFolderUp size={15} />, disabled: !current, onSelect: () => void uploadFolder() },
    "separator",
    { label: msgFiles.refresh, icon: <IconRefreshCw size={15} />, disabled: !current, onSelect: () => current && void load(current) },
    { label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, disabled: !current, onSelect: () => copyPath(null) },
    { label: msgFiles.showHidden, checked: showHidden, onSelect: () => set("showHidden", (v) => !v) },
  ];

  const hiddenCount = listing ? listing.entries.filter((e) => e.name.startsWith(".")).length : 0;
  const empty =
    listing && listing.entries.length > 0 ? (
      <div className="ft-state">
        <IconEye size={22} />
        <span>{msgFiles.onlyHidden(hiddenCount)}</span>
        <button type="button" className="btn btn-sm" onClick={() => set("showHidden", true)}>
          {msgFiles.showHidden}
        </button>
      </div>
    ) : (
      <div className="ft-state">
        <IconFolderOpen size={24} />
        <strong>{msgFiles.emptyTitle}</strong>
        <span>{msgFiles.emptyBody}</span>
      </div>
    );

  return (
    <aside
      ref={ref}
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
        {target && (
          <>
            <IconButton size="sm" label={msgFiles.uploadMenu} aria-haspopup="menu" disabled={!current} onClick={(e) => setMenu({ kind: "upload", anchor: e.currentTarget })}>
              <IconUpload size={15} />
            </IconButton>
            <IconButton size="sm" label={msgFiles.newFolder} disabled={!current} onClick={() => setPrompt({ kind: "mkdir" })}>
              <IconFolderPlus size={15} />
            </IconButton>
            <IconButton size="sm" label={msgFiles.viewOptions} aria-haspopup="menu" onClick={(e) => setMenu({ kind: "view", anchor: e.currentTarget })}>
              <IconSlidersHorizontal size={15} />
            </IconButton>
          </>
        )}
        <IconButton size="sm" data-tooltip-side="bottom-end" label={msg.files.close} onClick={onClose}>
          <IconX size={15} />
        </IconButton>
      </div>

      {!target ? (
        <div className="panel-body">
          <Notice tone="info">{msg.files.noSession}</Notice>
        </div>
      ) : (
        <>
          <div className="fp-nav">
            <IconButton size="sm" label={msg.files.up} onClick={up} disabled={!listing?.parent || pending}>
              <IconFolderUp size={15} />
            </IconButton>
            {listing ? (
              <PathBar
                crumbs={crumbsOf({ kind: "remote", path: listing.path }).map((c) => ({ label: c.label, onGo: () => c.loc.kind === "remote" && void load(c.loc.path) }))}
                opening={opening}
                busy={opening !== null}
                editable={{ value: listing.path, onSubmit: (path) => void load(path) }}
                editRequest={editPath}
              />
            ) : (
              <span className="pathbar" />
            )}
            {shellFolder && (
              <IconButton size="sm" label={msg.files.shellFolder(shellFolder)} onClick={() => void load(shellFolder)} disabled={pending || current === shellFolder}>
                <IconSquareTerminal size={15} />
              </IconButton>
            )}
            <IconButton size="sm" data-tooltip-side="bottom-end" label={msg.files.refresh} onClick={() => current && void load(current)} disabled={!current || pending}>
              <IconRefreshCw size={14} />
            </IconButton>
          </div>

          <div className="files-panes">
            {twoPane && (
              <div className="files-local-col">
                <LocalPane
                  selected={localSelection?.name ?? null}
                  listing={local}
                  showHidden={showHidden}
                  onListing={(next) => change((m) => ({ ...m, local: next, localSelection: null }))}
                  onSelect={(entry) => set("localSelection", entry)}
                  onDropRemote={(name) => {
                    const entry = listing?.entries.find((e) => e.name === name);
                    if (entry) void downloadToLocal(entry);
                  }}
                />
                {localSelection && localLocation && current && (localSelection.kind === "file" || localSelection.kind === "dir") && (
                  <div className="fp-local-actions">
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => void uploadFromLocal(localSelection.name, localSelection.kind)}>
                      <IconUpload size={14} /> {msg.files.toServer}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div
              ref={bodyRef}
              className="fp-body files-body"
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
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRemoteDrop(false);
              }}
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
                const dropped = data.side === "local" ? (localSelection?.name === data.name ? localSelection : null) : null;
                if (data.side === "local") void uploadFromLocal(data.name, dropped?.kind ?? "file");
              }}
            >
              {slow && <div className="list-progress" role="progressbar" aria-label={msg.files.loadingFolder} />}
              {listing && <ErrorNotice error={error} />}
              {listing?.truncated && <Notice tone="warning">{msg.files.truncated(listing.entries.length)}</Notice>}
              {!listing && error && (
                <div className="ft-state" role="alert">
                  <IconTriangleAlert size={22} />
                  <strong>{msgFiles.loadFailed}</strong>
                  <span>{error.message}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      clearError();
                      void load(null);
                    }}
                  >
                    <IconRefreshCw size={14} /> {msgFiles.retry}
                  </button>
                </div>
              )}
              {!listing && !error && (
                <div className="ft-skeleton" aria-busy="true" aria-label={msg.files.loadingFolder}>
                  {Array.from({ length: 6 }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: still placeholders.
                    <span key={i} />
                  ))}
                </div>
              )}
              {listing && (
                <FileTable
                  label={msg.files.listLabel(listing.path)}
                  entries={entries}
                  columns={["name", "modified", "size", "mode"]}
                  modeStyle="octal"
                  sort={sort}
                  onSort={onSort}
                  selection={picked}
                  onSelection={setPicked}
                  opening={opening}
                  busy={opening !== null}
                  renaming={renaming}
                  onRename={rename}
                  onRenameEnd={() => setRenaming(null)}
                  onActivate={(entry) => void activate(entry)}
                  onMenu={(items, at) => setMenu({ kind: "row", entries: items, at })}
                  onBackgroundMenu={(at) => setMenu({ kind: "folder", at })}
                  onKey={(key) => {
                    if (key === "up") up();
                    else if (key === "rename" && selection) setRenaming(selection.name);
                    else if (key === "delete" && chosen.length > 0) setPrompt({ kind: "delete", entries: chosen });
                    else if (key === "editPath") setEditPath((n) => n + 1);
                  }}
                  canDrag={(entry) => twoPane && (entry.kind === "file" || entry.kind === "dir")}
                  onDragStart={(event, entry) => event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ side: "remote", name: entry.name }))}
                  empty={empty}
                />
              )}
            </div>
          </div>

          {listing && (
            <div className="fp-footer" role="status" aria-label={msg.files.selectionStatus}>
              {selectionSummary(entries, picked.names, (n) => formatSize(n))}
            </div>
          )}

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

          <TransferDrawer
            transfers={transfers}
            onCancel={(t) => {
              if (t.id.startsWith(DROP_PREFIX)) stopped.current.add(t.id);
              else void filesApi.cancel(t.id).catch(() => undefined);
            }}
            onClear={() => setTransfers((list) => list.filter((t) => t.state === "running"))}
          />
        </>
      )}

      {menu?.kind === "upload" && <Menu anchor={menu.anchor} items={uploadItems} label={msgFiles.uploadMenu} onClose={() => setMenu(null)} />}
      {menu?.kind === "view" && <Menu anchor={menu.anchor} items={viewItems} label={msgFiles.viewOptions} onClose={() => setMenu(null)} />}
      {menu?.kind === "row" && (
        <Menu
          anchor={menu.at instanceof HTMLElement ? menu.at : undefined}
          point={menu.at instanceof HTMLElement ? undefined : menu.at}
          items={rowItems(menu.entries)}
          label={menu.entries.length === 1 ? msgFiles.rowMenu((menu.entries[0] as RemoteEntry).name) : msg.files.selectionStatus}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === "folder" && (
        <Menu
          anchor={menu.at instanceof HTMLElement ? menu.at : undefined}
          point={menu.at instanceof HTMLElement ? undefined : menu.at}
          items={folderItems}
          label={msgFiles.folderMenu}
          onClose={() => setMenu(null)}
        />
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
  const initial = prompt.kind === "chmod" && prompt.entry.permissions != null ? prompt.entry.permissions.toString(8).padStart(3, "0") : "";
  const [text, setText] = useState(initial);
  const { pending, error, run } = useAction();
  const [invalid, setInvalid] = useState<string | null>(null);
  /** Something was deleted before a later item failed: the folder needs listing again. */
  const deleted = useRef(false);

  async function submit() {
    setInvalid(null);
    let ok: unknown;
    switch (prompt.kind) {
      case "mkdir":
        ok = await run(() => filesApi.mkdir(sessionId, dir, text.trim()).then(() => true));
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
      case "delete": {
        // One after another; a failure stops there and says which item it was.
        const entries = prompt.entries;
        ok = await run(async () => {
          for (const entry of entries) {
            try {
              await filesApi.remove(sessionId, dir, entry.name);
            } catch (caught) {
              const e = toAppError(caught);
              throw entries.length > 1 ? new AppError({ code: e.code, message: `${visibleName(entry.name)}: ${e.message}` }) : e;
            }
            deleted.current = true;
          }
          return true;
        });
        break;
      }
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
    const only = prompt.kind === "delete" && prompt.entries.length === 1 ? prompt.entries[0] : undefined;
    const title =
      prompt.kind === "delete"
        ? only
          ? msg.files.deleteTitle(only.name)
          : msgFiles.deleteMany(prompt.entries.length)
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
      <Dialog title={title} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => onDone(deleted.current)}>
        <div className="stack">
          <p>{body}</p>
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onDone(deleted.current)} data-autofocus>
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

  const title = prompt.kind === "mkdir" ? msg.files.newFolderTitle : msg.files.permissionsTitle(prompt.entry.name);
  return (
    <Dialog title={title} icon={prompt.kind === "chmod" ? <IconSlidersHorizontal size={18} /> : <IconFolderPlus size={18} />} onDismiss={() => onDone(false)}>
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

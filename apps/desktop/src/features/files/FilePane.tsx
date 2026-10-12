import type { RemoteEntry } from "@tyrminal/contracts";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Menu, type MenuEntry } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { ErrorNotice, IconButton, Keys, Notice, TextField } from "../../components/ui/controls";
import {
  IconArrowLeftRight,
  IconChevronLeft,
  IconChevronRight,
  IconClipboardCopy,
  IconCopy,
  IconDownload,
  IconEllipsis,
  IconEye,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderUp,
  IconPencil,
  IconRefreshCw,
  IconSearch,
  IconShieldAlert,
  IconSlidersHorizontal,
  IconTrash2,
  IconTriangleAlert,
  IconUpload,
  IconX,
} from "../../components/ui/icons";
import { AppError, files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import {
  type Folder,
  type Loc,
  type Sort,
  type SortKey,
  childLoc,
  crumbs as crumbsOf,
  formatSize,
  localFolder,
  octal,
  parentLoc,
  remoteFolder,
  sameLoc,
  visibleEntries,
  visibleName,
} from "../sftp/model";
import { FileTable, type MenuAt } from "./FileTable";
import { msgFiles } from "./messages";
import { PathBar } from "./PathBar";
import { NO_SELECTION, type Selection, pruneSelection, selectionSummary, single } from "./selection";
import "./files.css";
import { LOADING_DELAY_MS } from "../../lib/useDelayed";

/** After this long, opening a folder shows a progress bar (the row shows it at once). */
const SLOW_MS = LOADING_DELAY_MS;

/** Drag payload between file panes (the Files panel's two panes, the SFTP tab's two panes). */
export const FILE_DRAG = "application/x-tyrminal-files";
export interface FileDrag {
  pane: string;
  entries: RemoteEntry[];
}

/** What a pane shows; its owner keeps it (per session, per location) so it survives unmounting. */
export interface PaneView {
  folder: Folder | null;
  back: Loc[];
  forward: Loc[];
  filter: string;
  sort: Sort;
  showHidden: boolean;
  selection: Selection;
  scrollTop: number;
}

export const emptyView = (): PaneView => ({
  folder: null,
  back: [],
  forward: [],
  filter: "",
  sort: { key: "name", ascending: true },
  showHidden: false,
  selection: NO_SELECTION,
  scrollTop: 0,
});

/** The file operations of one location: a server over SFTP, or a folder the user chose here. */
export interface PaneBackend {
  kind: "remote" | "local";
  /** "/srv on api-gateway", "Projects/photos on this computer" (for the list's name). */
  where: (loc: Loc) => string;
  /** Lists `loc`; null is where the location starts (a server's login folder). */
  list: (loc: Loc | null) => Promise<Folder>;
  mkdir: (loc: Loc, name: string) => Promise<void>;
  rename: (loc: Loc, from: string, to: string) => Promise<void>;
  chmod: (loc: Loc, name: string, mode: number) => Promise<void>;
  remove: (loc: Loc, name: string) => Promise<void>;
}

/** Operations on a server through one session's SFTP channel. */
export function remoteBackend(sessionId: string, label: string): PaneBackend {
  const path = (loc: Loc) => (loc.kind === "remote" ? loc.path : "/");
  return {
    kind: "remote",
    where: (loc) => `${path(loc)} on ${label}`,
    list: async (loc) => remoteFolder(await filesApi.list(sessionId, loc ? path(loc) : null)),
    mkdir: (loc, name) => filesApi.mkdir(sessionId, path(loc), name),
    rename: (loc, from, to) => filesApi.rename(sessionId, path(loc), from, to),
    chmod: (loc, name, mode) => filesApi.chmod(sessionId, path(loc), name, mode),
    remove: (loc, name) => filesApi.remove(sessionId, path(loc), name),
  };
}

/** Operations inside a folder the user chose on this computer (never outside it). */
export function localBackend(root: Loc & { kind: "local" }): PaneBackend {
  const at = (loc: Loc) => (loc.kind === "local" ? loc : root);
  return {
    kind: "local",
    where: (loc) => `${[at(loc).rootName, ...at(loc).path].join("/")} on this computer`,
    list: async (loc) => {
      const l = at(loc ?? root);
      return localFolder(await filesApi.localList(l.token, l.path));
    },
    mkdir: (loc, name) => filesApi.localMkdir(at(loc).token, at(loc).path, name),
    rename: (loc, from, to) => filesApi.localRename(at(loc).token, at(loc).path, from, to),
    chmod: (loc, name, mode) => filesApi.localChmod(at(loc).token, at(loc).path, name, mode),
    remove: (loc, name) => filesApi.localRemove(at(loc).token, at(loc).path, name),
  };
}

type Prompt = { kind: "mkdir" } | { kind: "chmod"; entry: RemoteEntry } | { kind: "delete"; entries: RemoteEntry[] };
type OpenMenu = { kind: "more" | "upload"; anchor: HTMLElement } | { kind: "folder"; at: MenuAt } | { kind: "row"; entries: RemoteEntry[]; at: MenuAt };

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: msgFiles.sortName },
  { key: "modified", label: msgFiles.sortModified },
  { key: "size", label: msgFiles.sortSize },
];

/**
 * One file browser pane, the same in the Files side panel and in each SFTP pane: a toolbar
 * (back, forward, up, the path, filter, refresh, then New folder, Upload and "…"), the table with
 * its row and folder menus, inline rename, a bar for actions on several items, and the empty,
 * loading, refused and failed states. Transfers are the owner's: the pane asks for them.
 */
export function FilePane({
  id,
  label,
  backend,
  view,
  setView,
  start = null,
  compact = false,
  inactive = false,
  autoFocus = false,
  refreshKey = 0,
  placeholder,
  menuExtras = [],
  rowExtras,
  onDownload,
  onUpload,
  onUploadFolder,
  onDownloadFolder,
  onDuplicate,
  copyOther,
  drop,
  emptyHint,
  tools,
  goRequest = null,
}: {
  /** Names this pane in drag payloads, so a drop knows where items came from. */
  id: string;
  /** The region's name ("Left pane", "Server"). */
  label: string;
  backend: PaneBackend | null;
  view: PaneView;
  setView: (change: (view: PaneView) => PaneView) => void;
  /** Where to start when nothing is shown yet (the shell's folder, a chosen local folder). */
  start?: Loc | null;
  /** The narrow side panel: fewer columns, the filter behind a button. */
  compact?: boolean;
  /** Another pane has focus: the selection shows in grey. */
  inactive?: boolean;
  autoFocus?: boolean;
  /** Bumped by the owner when a transfer into this folder finished. */
  refreshKey?: number;
  /** Shown instead of the browser while there is nothing to browse (connecting, choosing). */
  placeholder?: ReactNode;
  /** The owner's entries at the end of the "…" menu. */
  menuExtras?: MenuEntry[];
  /** The owner's entries in the row menu, after Open and Download (Edit, Copy to …). */
  rowExtras?: (entries: RemoteEntry[], loc: Loc) => MenuEntry[];
  onDownload?: ((entries: RemoteEntry[], loc: Loc) => void) | undefined;
  onUpload?: ((loc: Loc) => void) | undefined;
  onUploadFolder?: ((loc: Loc) => void) | undefined;
  onDownloadFolder?: ((folder: Folder) => void) | undefined;
  onDuplicate?: ((entries: RemoteEntry[], loc: Loc) => void) | undefined;
  /** Copies items to the other pane: F5, the row menu, the selection bar. */
  copyOther?: { label: string; run: (entries: RemoteEntry[], loc: Loc) => void } | null | undefined;
  /** What can be dropped here and what to do with it. */
  drop?: { accepts: (types: readonly string[]) => boolean; onDrop: (data: DataTransfer, loc: Loc) => void; hint: string } | null;
  /** Under "This folder is empty". */
  emptyHint?: string | undefined;
  /** The owner's buttons in the toolbar, before Refresh (the panel's "shell's folder"). */
  tools?: ReactNode;
  /** Goes to `loc` each time `seq` changes. */
  goRequest?: { loc: Loc; seq: number } | null;
}) {
  const { folder, back, forward, filter, sort, showHidden, selection } = view;
  const [opening, setOpening] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [slow, setSlow] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editPath, setEditPath] = useState(0);
  const [filtering, setFiltering] = useState(false);
  const [dropping, setDropping] = useState(false);
  const { pending, error, run, clearError } = useAction();
  const notify = useToast();
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const set = useCallback(<K extends keyof PaneView>(key: K, value: PaneView[K]) => setView((v) => ({ ...v, [key]: value })), [setView]);
  const setSelection = useCallback((next: Selection) => set("selection", next), [set]);

  /** Shows `loc`; `select` picks a name in it (the folder just left, a renamed item). */
  const go = useCallback(
    async (loc: Loc | null, history: "push" | "back" | "forward" | "none" = "push", select?: string) => {
      const b = backendRef.current;
      if (!b) return;
      setNavigating(true);
      let next: Folder | undefined;
      try {
        next = await run(() => b.list(loc));
      } finally {
        setNavigating(false);
        setOpening(null);
      }
      if (!next || backendRef.current !== b) return;
      const loaded = next;
      setView((v) => {
        const from = v.folder?.loc ?? null;
        const moved = !sameLoc(from, loaded.loc);
        let { back: b2, forward: f2 } = v;
        if (from && moved) {
          if (history === "push") {
            b2 = [...b2, from];
            f2 = [];
          } else if (history === "back") {
            b2 = b2.slice(0, -1);
            f2 = [...f2, from];
          } else if (history === "forward") {
            f2 = f2.slice(0, -1);
            b2 = [...b2, from];
          }
        }
        const names = loaded.entries.map((e) => e.name);
        const sel = select && names.includes(select) ? single(select) : moved ? NO_SELECTION : pruneSelection(v.selection, names);
        return { ...v, folder: loaded, back: b2, forward: f2, selection: sel, filter: moved ? "" : v.filter, scrollTop: moved ? 0 : v.scrollTop };
      });
    },
    [run, setView],
  );

  const refresh = useCallback(() => void go(view.folder?.loc ?? null, "none"), [go, view.folder]);

  // A pane with nothing shown lists where it starts as soon as it can.
  const startKey = start ? JSON.stringify(start) : "";
  // A server folder that cannot be listed (the shell's folder, gone since) falls back quietly to
  // where the server starts; anything else is listed with its errors shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed again only for a new backend or start.
  useEffect(() => {
    if (!backend || folder || error) return;
    if (start && backend.kind === "remote") {
      let live = true;
      backend.list(start).then(
        (f) => live && setView((v) => (v.folder ? v : { ...v, folder: f })),
        () => live && void go(null, "none"),
      );
      return () => {
        live = false;
      };
    }
    void go(start, "none");
  }, [backend, startKey]);

  const seenGo = useRef(goRequest?.seq ?? 0);
  useEffect(() => {
    if (!goRequest || goRequest.seq === seenGo.current) return;
    seenGo.current = goRequest.seq;
    void go(goRequest.loc);
  }, [goRequest, go]);

  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === seenRefresh.current) return;
    seenRefresh.current = refreshKey;
    refresh();
  }, [refreshKey, refresh]);

  // The scroll position comes back with the folder.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restored when the folder is shown.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = view.scrollTop;
  }, [folder]);

  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || focused.current || !folder) return;
    focused.current = true;
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(".ft-name[tabindex='0']")?.focus());
  }, [autoFocus, folder]);

  useEffect(() => {
    if (!navigating) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [navigating]);

  const entries = useMemo(() => (folder ? visibleEntries(folder.entries, showHidden, filter, sort) : []), [folder, showHidden, filter, sort]);
  const chosen = entries.filter((e) => selection.names.includes(e.name));
  const one = chosen.length === 1 ? (chosen[0] as RemoteEntry) : null;
  const movable = (items: RemoteEntry[]) => items.filter((e) => e.kind === "file" || e.kind === "dir");
  const loc = folder?.loc ?? null;
  const up = loc ? parentLoc(loc) : null;
  const remote = backend?.kind === "remote";

  function goUp() {
    if (!loc || !up) return;
    const name = loc.kind === "local" ? loc.path.at(-1) : loc.path.replace(/\/+$/, "").split("/").at(-1);
    void go(up, "push", name);
  }

  function activate(entry: RemoteEntry) {
    if (!loc) return;
    if (entry.kind === "dir" || (entry.kind === "symlink" && loc.kind === "remote")) {
      setOpening(entry.name);
      void go(childLoc(loc, entry.name));
    } else setSelection(single(entry.name));
  }

  async function rename(entry: RemoteEntry, name: string): Promise<string | null> {
    if (!backend || !loc) return null;
    try {
      await backend.rename(loc, entry.name, name);
    } catch (caught) {
      return toAppError(caught).message;
    }
    await go(loc, "none", name);
    return null;
  }

  function copyPath(entry: RemoteEntry | null) {
    if (!loc || loc.kind !== "remote") return;
    const path = entry ? `${loc.path.replace(/\/+$/, "")}/${entry.name}` : loc.path;
    void navigator.clipboard.writeText(path).then(
      () => notify("success", msgFiles.pathCopied),
      () => undefined,
    );
  }

  const sortBy = (key: SortKey) => set("sort", sort.key === key ? { ...sort, ascending: !sort.ascending } : { key, ascending: true });

  // ---------- menus ----------

  function rowItems(items: RemoteEntry[]): MenuEntry[] {
    if (!loc) return [];
    const first = items.length === 1 ? (items[0] as RemoteEntry) : null;
    const copyable = movable(items);
    const list: MenuEntry[] = [];
    if (first && (first.kind === "dir" || (first.kind === "symlink" && remote))) list.push({ label: msgFiles.open, icon: <IconFolderOpen size={15} />, onSelect: () => activate(first) });
    if (onDownload && copyable.length > 0) list.push({ label: msgFiles.download, icon: <IconDownload size={15} />, onSelect: () => onDownload(copyable, loc) });
    if (copyOther && copyable.length > 0)
      list.push({ label: copyOther.label, icon: <IconArrowLeftRight size={15} />, shortcut: <Keys caps={["F5"]} />, onSelect: () => copyOther.run(copyable, loc) });
    list.push(...(rowExtras?.(items, loc) ?? []));
    list.push("separator");
    if (first) list.push({ label: msgFiles.rename, icon: <IconPencil size={15} />, shortcut: <Keys caps={["F2"]} />, onSelect: () => setRenaming(first.name) });
    if (onDuplicate && copyable.length > 0) list.push({ label: msgFiles.duplicate, icon: <IconCopy size={15} />, onSelect: () => onDuplicate(copyable, loc) });
    if (first && remote) list.push({ label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, onSelect: () => copyPath(first) });
    if (first && first.kind !== "symlink") list.push({ label: msgFiles.permissions, icon: <IconSlidersHorizontal size={15} />, onSelect: () => setPrompt({ kind: "chmod", entry: first }) });
    list.push("separator");
    list.push({ label: msgFiles.delete, icon: <IconTrash2 size={15} />, tone: "danger", shortcut: <Keys caps={["Del"]} />, onSelect: () => setPrompt({ kind: "delete", entries: items }) });
    return tidy(list);
  }

  const uploadItems: MenuEntry[] = loc
    ? tidy([
        ...(onUpload ? [{ label: msgFiles.uploadFiles, icon: <IconUpload size={15} />, onSelect: () => onUpload(loc) }] : []),
        ...(onUploadFolder ? [{ label: msgFiles.uploadFolder, icon: <IconFolderUp size={15} />, onSelect: () => onUploadFolder(loc) }] : []),
        "separator",
        ...(onDownloadFolder && folder ? [{ label: msgFiles.downloadFolder, icon: <IconDownload size={15} />, disabled: !up, onSelect: () => onDownloadFolder(folder) }] : []),
      ])
    : [];

  const moreItems: MenuEntry[] = tidy([
    { label: msgFiles.showHidden, checked: showHidden, onSelect: () => set("showHidden", !showHidden) },
    "separator",
    ...SORTS.map((s) => ({ label: s.label, checked: sort.key === s.key, onSelect: () => set("sort", { ...sort, key: s.key }) })),
    { label: msgFiles.sortDescending, checked: !sort.ascending, onSelect: () => set("sort", { ...sort, ascending: !sort.ascending }) },
    "separator",
    ...(remote && loc ? [{ label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, onSelect: () => copyPath(null) }] : []),
    ...(compact && folder ? [{ label: msgFiles.forward, icon: <IconChevronRight size={15} />, disabled: forward.length === 0, onSelect: () => void go(forward.at(-1) as Loc, "forward") }] : []),
    ...(menuExtras.length > 0 ? (["separator", ...menuExtras] as MenuEntry[]) : []),
  ]);

  const folderItems: MenuEntry[] = loc
    ? tidy([
        { label: msgFiles.newFolder, icon: <IconFolderPlus size={15} />, onSelect: () => setPrompt({ kind: "mkdir" }) },
        ...uploadItems.filter((i) => i !== "separator" && i.label !== msgFiles.downloadFolder),
        "separator",
        { label: msgFiles.refresh, icon: <IconRefreshCw size={15} />, onSelect: refresh },
        ...(remote ? [{ label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, onSelect: () => copyPath(null) }] : []),
        { label: msgFiles.showHidden, checked: showHidden, onSelect: () => set("showHidden", !showHidden) },
      ])
    : [];

  // ---------- states ----------

  const denied = error?.code === "ACCESS_DENIED";
  const hiddenCount = folder ? folder.entries.filter((e) => e.name.startsWith(".")).length : 0;
  const empty = !folder ? null : folder.entries.length === 0 ? (
    <div className="ft-state">
      <IconFolderOpen size={24} />
      <strong>{msgFiles.emptyTitle}</strong>
      <span>{emptyHint ?? msgFiles.emptyBody}</span>
    </div>
  ) : filter.trim() ? (
    <div className="ft-state">
      <IconSearch size={22} />
      <span>{msgFiles.noMatch}</span>
      <button type="button" className="btn btn-sm" onClick={() => set("filter", "")}>
        {msgFiles.clearFilter}
      </button>
    </div>
  ) : (
    <div className="ft-state">
      <IconEye size={22} />
      <span>{msgFiles.onlyHidden(hiddenCount)}</span>
      <button type="button" className="btn btn-sm" onClick={() => set("showHidden", true)}>
        {msgFiles.showHidden}
      </button>
    </div>
  );

  /** Nothing could be listed yet: the reason in place of the list, with what to do. */
  const failure = error && !folder && (
    <div className="ft-state ft-state-error" role="alert">
      {denied ? <IconShieldAlert size={22} /> : <IconTriangleAlert size={22} />}
      <strong>{denied ? msgFiles.deniedTitle : msgFiles.loadFailed}</strong>
      <span>{denied ? msgFiles.deniedBody : error.message}</span>
      {denied && <span className="faint">{error.message}</span>}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          clearError();
          void go(start, "none");
        }}
      >
        <IconRefreshCw size={14} /> {msgFiles.retry}
      </button>
    </div>
  );

  /** A folder could not be opened from the one shown: said above the list, which stays. */
  const notice = error && folder && (
    <div className="fpane-notice" role="alert" data-tone={denied ? "warning" : "danger"}>
      {denied ? <IconShieldAlert size={15} /> : <IconTriangleAlert size={15} />}
      <span>
        {denied && <strong>{msgFiles.deniedTitle}. </strong>}
        {error.message}
      </span>
      <IconButton size="sm" data-tooltip-side="bottom-end" label={msg.common.close} onClick={clearError}>
        <IconX size={13} />
      </IconButton>
    </div>
  );

  // ---------- render ----------

  if (!backend) {
    return (
      <section className="fpane" aria-label={label} data-compact={compact || undefined}>
        {placeholder}
      </section>
    );
  }

  return (
    <section
      ref={rootRef}
      className="fpane"
      aria-label={label}
      data-compact={compact || undefined}
      data-drop={dropping || undefined}
      onDragOver={(event) => {
        if (loc && drop?.accepts(event.dataTransfer.types)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        if (!loc || !drop?.accepts(event.dataTransfer.types)) return;
        event.preventDefault();
        drop.onDrop(event.dataTransfer, loc);
      }}
    >
      <div className="fpane-bar" role="toolbar" aria-label={msgFiles.toolbar}>
        <IconButton size="sm" label={msgFiles.back} disabled={back.length === 0 || pending} onClick={() => void go(back.at(-1) as Loc, "back")}>
          <IconChevronLeft size={15} />
        </IconButton>
        {!compact && (
          <IconButton size="sm" label={msgFiles.forward} disabled={forward.length === 0 || pending} onClick={() => void go(forward.at(-1) as Loc, "forward")}>
            <IconChevronRight size={15} />
          </IconButton>
        )}
        <IconButton size="sm" label={msgFiles.up} disabled={!up || pending} onClick={goUp}>
          <IconFolderUp size={15} />
        </IconButton>
        {compact && filtering ? (
          <FilterField value={filter} onChange={(v) => set("filter", v)} onClose={() => (set("filter", ""), setFiltering(false))} autoFocus />
        ) : folder ? (
          <PathBar
            crumbs={crumbsOf(folder.loc).map((c) => ({ label: c.label, onGo: () => void go(c.loc) }))}
            opening={opening}
            busy={navigating}
            editable={folder.loc.kind === "remote" ? { value: folder.loc.path, onSubmit: (path) => void go({ kind: "remote", path }) } : null}
            editRequest={editPath}
          />
        ) : (
          <span className="pathbar" />
        )}
        {!compact && <FilterField value={filter} onChange={(v) => set("filter", v)} />}
        {compact && !filtering && (
          <IconButton size="sm" label={msgFiles.filter} disabled={!folder} onClick={() => setFiltering(true)}>
            <IconSearch size={14} />
          </IconButton>
        )}
        {tools}
        <IconButton size="sm" label={msgFiles.refresh} disabled={!folder || pending} onClick={refresh}>
          <IconRefreshCw size={14} />
        </IconButton>
        <span className="fpane-sep" aria-hidden="true" />
        <IconButton size="sm" label={msgFiles.newFolder} disabled={!loc} onClick={() => setPrompt({ kind: "mkdir" })}>
          <IconFolderPlus size={15} />
        </IconButton>
        {uploadItems.length > 0 && (
          <IconButton size="sm" label={msgFiles.uploadMenu} aria-haspopup="menu" disabled={!loc} onClick={(e) => setMenu({ kind: "upload", anchor: e.currentTarget })}>
            <IconUpload size={15} />
          </IconButton>
        )}
        <IconButton size="sm" data-tooltip-side="bottom-end" label={msgFiles.more} aria-haspopup="menu" onClick={(e) => setMenu({ kind: "more", anchor: e.currentTarget })}>
          <IconEllipsis size={16} />
        </IconButton>
      </div>

      <div
        ref={bodyRef}
        className="fpane-body"
        onScroll={(event) => {
          // Kept without drawing again (read back when the pane is shown again); a state update
          // per scrolled frame would redraw the whole list.
          view.scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {slow && <div className="list-progress" role="progressbar" aria-label={msg.files.loadingFolder} />}
        {folder?.truncated && <Notice tone="warning">{msg.files.truncated(folder.entries.length)}</Notice>}
        {notice}
        {failure}
        {!folder && !error && (
          <div className="ft-skeleton" aria-busy="true" aria-label={msg.files.loadingFolder}>
            {Array.from({ length: 7 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: still placeholders.
              <span key={i} />
            ))}
          </div>
        )}
        {folder && (
          <FileTable
            label={msg.files.listLabel(backend.where(folder.loc))}
            entries={entries}
            columns={["name", "size", "modified", "mode"]}
            sort={sort}
            onSort={sortBy}
            selection={selection}
            onSelection={setSelection}
            opening={opening}
            busy={navigating}
            inactive={inactive}
            renaming={renaming}
            onRename={rename}
            onRenameEnd={() => setRenaming(null)}
            onActivate={activate}
            onMenu={(items, at) => setMenu({ kind: "row", entries: items, at })}
            onBackgroundMenu={(at) => setMenu({ kind: "folder", at })}
            onKey={(key) => {
              if (key === "up") goUp();
              else if (key === "back" && back.length > 0) void go(back.at(-1) as Loc, "back");
              else if (key === "forward" && forward.length > 0) void go(forward.at(-1) as Loc, "forward");
              else if (key === "rename" && one) setRenaming(one.name);
              else if (key === "delete" && chosen.length > 0) setPrompt({ kind: "delete", entries: chosen });
              else if (key === "copyOther" && copyOther && loc && movable(chosen).length > 0) copyOther.run(movable(chosen), loc);
              else if (key === "editPath") setEditPath((n) => n + 1);
            }}
            canDrag={(entry) => drop !== undefined && (entry.kind === "file" || entry.kind === "dir")}
            onDragStart={(event, entry, isSelected) => {
              // Dragging a selected row takes the whole selection; another row goes alone.
              const dragged = isSelected && movable(chosen).length > 0 ? movable(chosen) : [entry];
              if (!isSelected) setSelection(single(entry.name));
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(FILE_DRAG, JSON.stringify({ pane: id, entries: dragged } satisfies FileDrag));
            }}
            empty={empty}
          />
        )}
        {dropping && loc && drop && (
          <div className="fpane-drop" aria-hidden="true">
            {drop.hint}
          </div>
        )}
      </div>

      {chosen.length > 1 && loc && (
        <div className="fpane-bulk" role="toolbar" aria-label={msgFiles.bulk(chosen.length)}>
          <span className="fpane-bulk-count">{msgFiles.selectedCount(chosen.length)}</span>
          <span className="spacer" />
          {onDownload && movable(chosen).length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onDownload(movable(chosen), loc)}>
              <IconDownload size={14} /> {msgFiles.bulkDownload}
            </button>
          )}
          {copyOther && movable(chosen).length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => copyOther.run(movable(chosen), loc)}>
              <IconArrowLeftRight size={14} /> {copyOther.label}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => setPrompt({ kind: "delete", entries: chosen })}>
            <IconTrash2 size={14} /> {msgFiles.bulkDelete}
          </button>
          <IconButton size="sm" data-tooltip-side="top" label={msgFiles.clearSelection} onClick={() => setSelection(NO_SELECTION)}>
            <IconX size={14} />
          </IconButton>
        </div>
      )}

      {folder && (
        <div className="fpane-footer" role="status" aria-label={msg.files.selectionStatus}>
          {selectionSummary(entries, selection.names, (n) => formatSize(n))}
        </div>
      )}

      {menu?.kind === "more" && <Menu anchor={menu.anchor} items={moreItems} label={msgFiles.more} onClose={() => setMenu(null)} />}
      {menu?.kind === "upload" && <Menu anchor={menu.anchor} items={uploadItems} label={msgFiles.uploadMenu} onClose={() => setMenu(null)} />}
      {(menu?.kind === "row" || menu?.kind === "folder") && (
        <Menu
          anchor={menu.at instanceof HTMLElement ? menu.at : undefined}
          point={menu.at instanceof HTMLElement ? undefined : menu.at}
          items={menu.kind === "row" ? rowItems(menu.entries) : folderItems}
          label={menu.kind === "folder" ? msgFiles.folderMenu : menu.entries.length === 1 ? msgFiles.rowMenu((menu.entries[0] as RemoteEntry).name) : msgFiles.bulk(menu.entries.length)}
          onClose={() => setMenu(null)}
        />
      )}

      {prompt && loc && (
        <ChangePrompt
          prompt={prompt}
          backend={backend}
          loc={loc}
          onDone={(changed) => {
            setPrompt(null);
            if (changed) refresh();
          }}
        />
      )}
    </section>
  );
}

/** Drops leading, trailing and doubled separators. */
function tidy(list: MenuEntry[]): MenuEntry[] {
  return list.filter((item, i) => item !== "separator" || (i > 0 && i < list.length - 1 && list[i - 1] !== "separator"));
}

function FilterField({ value, onChange, onClose, autoFocus = false }: { value: string; onChange: (v: string) => void; onClose?: () => void; autoFocus?: boolean }) {
  return (
    <label className="fpane-filter">
      <IconSearch size={13} aria-hidden="true" />
      <input
        className="input"
        type="search"
        aria-label={msgFiles.filter}
        placeholder={msgFiles.filterPlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onClose) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        // biome-ignore lint/a11y/noAutofocus: the field was just asked for.
        autoFocus={autoFocus}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </label>
  );
}

/** New folder, permissions and delete, for either kind of location. */
function ChangePrompt({ prompt, backend, loc, onDone }: { prompt: Prompt; backend: PaneBackend; loc: Loc; onDone: (changed: boolean) => void }) {
  const [text, setText] = useState(prompt.kind === "chmod" ? octal(prompt.entry.permissions) : "");
  const [invalid, setInvalid] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  /** Something was deleted before a later item failed: the folder needs listing again. */
  const deleted = useRef(false);

  async function submit() {
    setInvalid(null);
    const value = text.trim();
    let action: () => Promise<void>;
    switch (prompt.kind) {
      case "mkdir":
        action = () => backend.mkdir(loc, value);
        break;
      case "chmod":
        if (!/^[0-7]{3,4}$/.test(value)) {
          setInvalid(msg.files.modeInvalid);
          return;
        }
        action = () => backend.chmod(loc, prompt.entry.name, Number.parseInt(value, 8));
        break;
      case "delete": {
        // One after another; a failure stops there and says which item it was.
        const entries = prompt.entries;
        action = async () => {
          for (const entry of entries) {
            try {
              await backend.remove(loc, entry.name);
            } catch (caught) {
              const e = toAppError(caught);
              throw entries.length > 1 ? new AppError({ code: e.code, message: `${visibleName(entry.name)}: ${e.message}` }) : e;
            }
            deleted.current = true;
          }
        };
        break;
      }
    }
    if (await run(() => action().then(() => true))) onDone(true);
  }

  if (prompt.kind === "delete") {
    const only = prompt.entries.length === 1 ? prompt.entries[0] : undefined;
    return (
      <Dialog
        title={only ? msg.files.deleteTitle(only.name) : msgFiles.deleteMany(prompt.entries.length)}
        role="alertdialog"
        tone="danger"
        icon={<IconTrash2 size={18} />}
        onDismiss={() => onDone(deleted.current)}
      >
        <div className="stack">
          <p>{backend.kind === "local" ? msgFiles.deleteLocalBody : msgFiles.deleteRemoteBody}</p>
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onDone(deleted.current)} data-autofocus>
              {msg.common.cancel}
            </button>
            <button type="button" className="btn btn-danger-solid" onClick={() => void submit()} disabled={pending}>
              {msg.files.delete}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={prompt.kind === "mkdir" ? msg.files.newFolderTitle : msg.files.permissionsTitle(prompt.entry.name)}
      icon={prompt.kind === "chmod" ? <IconSlidersHorizontal size={18} /> : <IconFolderPlus size={18} />}
      onDismiss={() => onDone(false)}
    >
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

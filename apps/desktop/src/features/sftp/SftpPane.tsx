import type { HostSummary, RemoteEntry, SessionEvent, SessionState } from "@tyrminal/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Menu, type MenuEntry } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { EmptyState, ErrorNotice, IconButton, Keys, Notice, TextField } from "../../components/ui/controls";
import {
  IconArrowLeftRight,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClipboardCopy,
  IconEllipsis,
  IconEye,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderUp,
  IconHardDrive,
  IconPencil,
  IconRefreshCw,
  IconSearch,
  IconServer,
  IconShieldAlert,
  IconShieldCheck,
  IconSlidersHorizontal,
  IconTrash2,
  IconTriangleAlert,
  IconUnplug,
} from "../../components/ui/icons";
import { AppError, files as filesApi, sessions, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { FileTable, type MenuAt } from "../files/FileTable";
import { msgFiles } from "../files/messages";
import { PathBar } from "../files/PathBar";
import { NO_SELECTION, type Selection, pruneSelection, selectionSummary, single } from "../files/selection";
import { AuthDialog, Fingerprint } from "../terminal/TerminalView";
import { HopNotice } from "../tunnels/HopNotice";
import { msgSftp } from "./messages";
import {
  type Endpoint,
  type Folder,
  type Loc,
  type Sort,
  type SortKey,
  childLoc,
  crumbs,
  formatSize,
  localFolder,
  locText,
  octal,
  parentLoc,
  remoteFolder,
  sameLoc,
  visibleEntries,
  visibleName,
} from "./model";
import "../files/files.css";

/** After this long, opening a folder shows a progress bar (the row shows it at once). */
const SLOW_MS = 300;

export type Side = "left" | "right";

/** Drag payload between the panes of an SFTP tab. */
export const SFTP_DRAG = "application/x-tyrminal-sftp";

export type Source = { kind: "none" } | { kind: "local" } | { kind: "host"; hostId: string; label: string };

type Trust = Extract<SessionEvent, { type: "trust_prompt" }>;
type Auth = Extract<SessionEvent, { type: "auth_prompt" }>;
type Changed = Extract<SessionEvent, { type: "host_key_changed" }>;

interface Connection {
  sessionId: string | null;
  state: SessionState | "starting";
  trust: Trust | null;
  auth: Auth | null;
  changed: Changed | null;
  banner: string | null;
  error: { code: string; message: string } | null;
}

/** How a pane is doing, for the tab's indicator. */
export type PaneHealth = "idle" | "busy" | "ok" | "bad" | "attention";

type Prompt = { kind: "mkdir" } | { kind: "chmod"; entry: RemoteEntry } | { kind: "delete"; entries: RemoteEntry[] };

type OpenMenu = { kind: "source"; anchor: HTMLElement } | { kind: "folder"; at: MenuAt } | { kind: "row"; entries: RemoteEntry[]; at: MenuAt };

/**
 * One side of the SFTP tab: this computer (a folder the user chose) or a saved host over a
 * files-only connection. The connection belongs to this pane; it is closed when the pane changes
 * source or the tab closes.
 */
export function SftpPane({
  side,
  initial,
  hosts,
  visible,
  active,
  refreshKey,
  otherWhere,
  onFocusIn,
  onEndpoint,
  onHealth,
  onTransfer,
  onDropFrom,
  onOpenKnownHosts,
}: {
  side: Side;
  initial: Source;
  /** Saved SSH hosts, for the picker. */
  hosts: HostSummary[];
  /** Prompts appear only while the tab is in front. */
  visible: boolean;
  /** This pane has the keyboard (or was used last): it is marked, the other one is muted. */
  active: boolean;
  /** Bumped by the tab when a transfer into this pane's folder finished. */
  refreshKey: number;
  /** Where "Copy to …" sends the selection (the other pane), or null when it cannot. */
  otherWhere: string | null;
  onFocusIn: () => void;
  onEndpoint: (endpoint: Endpoint | null) => void;
  onHealth: (health: PaneHealth) => void;
  /** Copies `entry` from this pane's folder to the other pane's folder. */
  onTransfer: (entries: RemoteEntry[]) => void;
  /** An entry of the other pane was dropped here: copy it into this pane's folder. */
  onDropFrom: (entries: RemoteEntry[]) => void;
  onOpenKnownHosts: () => void;
}) {
  const sideLabel = side === "left" ? msgSftp.left : msgSftp.right;
  const [source, setSource] = useState<Source>(initial);
  const [conn, setConn] = useState<Connection | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [back, setBack] = useState<Loc[]>([]);
  const [forward, setForward] = useState<Loc[]>([]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", ascending: true });
  const [showHidden, setShowHidden] = useState(false);
  const [picked, setPicked] = useState<Selection>(NO_SELECTION);
  /** The folder being opened from a row, and whether that has taken long enough for a bar. */
  const [opening, setOpening] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [slow, setSlow] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editPath, setEditPath] = useState(0);
  const [dropping, setDropping] = useState(false);
  const { pending, error, run, clearError } = useAction();
  const notify = useToast();
  const sessionRef = useRef<string | null>(null);
  const attempt = useRef(0);

  // ---------- connection ----------

  const closeSession = useCallback(() => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void sessions.close(id).catch(() => undefined);
  }, []);

  // The connection lives as long as this pane shows its host.
  useEffect(() => closeSession, [closeSession]);

  const listRemote = useCallback(
    async (sessionId: string, path: string | null) => {
      const listing = await run(() => filesApi.list(sessionId, path));
      return listing ? remoteFolder(listing) : null;
    },
    [run],
  );

  const connect = useCallback(
    (hostId: string) => {
      closeSession();
      const mine = ++attempt.current;
      setFolder(null);
      setBack([]);
      setForward([]);
      setPicked(NO_SELECTION);
      clearError();
      setConn({ sessionId: null, state: "starting", trust: null, auth: null, changed: null, banner: null, error: null });
      const patch = (change: Partial<Connection>) => {
        if (mine === attempt.current) setConn((c) => (c ? { ...c, ...change } : c));
      };
      const onEvent = (event: SessionEvent) => {
        if (mine !== attempt.current) return;
        switch (event.type) {
          case "state":
            patch({ state: event.state });
            if (event.state === "connected" && sessionRef.current) {
              const id = sessionRef.current;
              void listRemote(id, null).then((f) => {
                if (f && mine === attempt.current) setFolder(f);
              });
            }
            break;
          case "trust_prompt":
            patch({ trust: event });
            break;
          case "auth_prompt":
            patch({ auth: event });
            break;
          case "host_key_changed":
            patch({ changed: event });
            break;
          case "banner":
            patch({ banner: event.text });
            break;
          case "closed":
            sessionRef.current = null;
            setConn((c) =>
              c && mine === attempt.current
                ? { ...c, sessionId: null, state: event.error ? "failed" : "closed", trust: null, auth: null, error: event.error }
                : c,
            );
            setFolder(null);
            break;
          default:
            break;
        }
      };
      sessions
        .openFiles(hostId, onEvent)
        .then((opened) => {
          if (mine !== attempt.current) {
            void sessions.close(opened.sessionId).catch(() => undefined);
            return;
          }
          sessionRef.current = opened.sessionId;
          setConn((c) => (c ? { ...c, sessionId: opened.sessionId } : c));
        })
        .catch((caught) => {
          const e = toAppError(caught);
          patch({ state: "failed", error: { code: e.code, message: e.message } });
        });
    },
    [closeSession, clearError, listRemote],
  );

  function choose(next: Source) {
    attempt.current += 1;
    closeSession();
    setConn(null);
    setFolder(null);
    setBack([]);
    setForward([]);
    setPicked(NO_SELECTION);
    setFilter("");
    clearError();
    setSource(next);
    if (next.kind === "host") connect(next.hostId);
  }

  // A host given at the start connects at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first source.
  useEffect(() => {
    if (initial.kind === "host") connect(initial.hostId);
  }, []);

  async function chooseLocalFolder() {
    const pick = await run(() => filesApi.pickFolder());
    if (!pick) return;
    const listing = await run(() => filesApi.localList(pick.token, []));
    if (listing) {
      setFolder(localFolder(listing));
      setBack([]);
      setForward([]);
      setPicked(NO_SELECTION);
    }
  }

  // ---------- folders ----------

  const load = useCallback(
    async (loc: Loc): Promise<Folder | null> => {
      if (loc.kind === "local") {
        const listing = await run(() => filesApi.localList(loc.token, loc.path));
        return listing ? localFolder(listing) : null;
      }
      const id = sessionRef.current;
      return id ? listRemote(id, loc.path) : null;
    },
    [run, listRemote],
  );

  /** Shows `loc`; `select` picks a name in it (the folder just left, or a renamed item). */
  async function go(loc: Loc, history: "push" | "back" | "forward" | "none" = "push", select?: string) {
    setNavigating(true);
    let next: Folder | null;
    try {
      next = await load(loc);
    } finally {
      setNavigating(false);
      setOpening(null);
    }
    if (!next) return;
    const from = folder?.loc ?? null;
    if (from && !sameLoc(from, next.loc)) {
      if (history === "push") {
        setBack((b) => [...b, from]);
        setForward([]);
      } else if (history === "back") {
        setBack((b) => b.slice(0, -1));
        setForward((f) => [...f, from]);
      } else if (history === "forward") {
        setForward((f) => f.slice(0, -1));
        setBack((b) => [...b, from]);
      }
    }
    setFolder(next);
    const loaded = next;
    const names = loaded.entries.map((e) => e.name);
    setPicked((p) => (select && names.includes(select) ? single(select) : sameLoc(from, loaded.loc) ? pruneSelection(p, names) : NO_SELECTION));
    if (!sameLoc(from, next.loc)) setFilter("");
  }

  const refresh = useCallback(async () => {
    if (!folder) return;
    const next = await load(folder.loc);
    if (next) {
      setFolder(next);
      setPicked((p) => pruneSelection(p, next.entries.map((e) => e.name)));
    }
  }, [folder, load]);

  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === seenRefresh.current) return;
    seenRefresh.current = refreshKey;
    void refresh();
  }, [refreshKey, refresh]);

  // ---------- what the tab sees ----------

  const endpoint: Endpoint | null = useMemo(() => {
    if (!folder) return null;
    if (folder.loc.kind === "local") return { kind: "local", token: folder.loc.token, rootName: folder.loc.rootName, path: folder.loc.path };
    if (source.kind === "host" && conn?.sessionId && conn.state === "connected")
      return { kind: "remote", sessionId: conn.sessionId, label: source.label, path: folder.loc.path };
    return null;
  }, [folder, source, conn]);

  useEffect(() => onEndpoint(endpoint), [endpoint, onEndpoint]);

  const health: PaneHealth =
    source.kind !== "host"
      ? "idle"
      : !conn
        ? "idle"
        : conn.trust || conn.auth
          ? "attention"
          : conn.state === "connected"
            ? "ok"
            : conn.state === "failed"
              ? "bad"
              : conn.state === "closed"
                ? "idle"
                : "busy";
  useEffect(() => onHealth(health), [health, onHealth]);

  const entries = useMemo(() => (folder ? visibleEntries(folder.entries, showHidden, filter, sort) : []), [folder, showHidden, filter, sort]);
  const chosen = entries.filter((e) => picked.names.includes(e.name));
  /** The one selected entry, for actions that take a single item. */
  const selection = chosen.length === 1 ? (chosen[0] as RemoteEntry) : null;
  const movable = (items: RemoteEntry[]) => items.filter((e) => e.kind === "file" || e.kind === "dir");

  useEffect(() => {
    if (!navigating) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [navigating]);
  const where = folder ? (folder.loc.kind === "local" ? msgSftp.localWhere(locText(folder.loc)) : msgSftp.remoteWhere(source.kind === "host" ? source.label : "", folder.loc.path)) : "";
  const up = folder ? parentLoc(folder.loc) : null;
  const canChange = folder !== null && endpoint !== null;

  function goUp() {
    if (!folder || !up) return;
    const name = folder.loc.kind === "local" ? folder.loc.path.at(-1) : folder.loc.path.replace(/\/+$/, "").split("/").at(-1);
    void go(up, "push", name);
  }

  function activate(entry: RemoteEntry) {
    if (!folder) return;
    if (entry.kind === "dir" || (entry.kind === "symlink" && folder.loc.kind === "remote")) {
      setOpening(entry.name);
      void go(childLoc(folder.loc, entry.name));
    } else setPicked(single(entry.name));
  }

  /** Renames in place; a refusal (a name already there) is shown under the field. */
  async function rename(entry: RemoteEntry, name: string): Promise<string | null> {
    if (!endpoint || !folder) return null;
    try {
      if (endpoint.kind === "local") await filesApi.localRename(endpoint.token, endpoint.path, entry.name, name);
      else await filesApi.rename(endpoint.sessionId, endpoint.path, entry.name, name);
    } catch (caught) {
      return toAppError(caught).message;
    }
    await go(folder.loc, "none", name);
    return null;
  }

  function copyPath(entry: RemoteEntry | null) {
    if (!folder || folder.loc.kind !== "remote") return;
    const path = entry ? `${folder.loc.path.replace(/\/+$/, "")}/${entry.name}` : folder.loc.path;
    void navigator.clipboard.writeText(path).then(
      () => notify("success", msgFiles.pathCopied),
      () => undefined,
    );
  }

  // ---------- menus ----------

  const sshHosts = hosts.filter((h) => h.protocol.type === "ssh");
  const sourceItems: MenuEntry[] = [
    { label: msgSftp.thisComputer, icon: <IconHardDrive size={15} />, onSelect: () => choose({ kind: "local" }) },
    ...(sshHosts.length > 0 ? (["separator"] as MenuEntry[]) : []),
    ...sshHosts.map((h) => ({ label: h.label, icon: <IconServer size={15} />, onSelect: () => choose({ kind: "host", hostId: h.id, label: h.label }) })),
  ];

  function rowItems(items: RemoteEntry[]): MenuEntry[] {
    const one = items.length === 1 ? (items[0] as RemoteEntry) : null;
    const copyable = movable(items);
    const remote = folder?.loc.kind === "remote";
    const list: MenuEntry[] = [];
    if (one && (one.kind === "dir" || (one.kind === "symlink" && remote))) list.push({ label: msgFiles.open, icon: <IconFolderOpen size={15} />, onSelect: () => activate(one) });
    if (copyable.length > 0 && otherWhere)
      list.push({ label: msgFiles.copyToOther(otherWhere), icon: <IconArrowLeftRight size={15} />, shortcut: <Keys caps={["F5"]} />, onSelect: () => onTransfer(copyable) });
    list.push("separator");
    if (one) {
      list.push({ label: msgFiles.rename, icon: <IconPencil size={15} />, shortcut: <Keys caps={["F2"]} />, disabled: !canChange, onSelect: () => setRenaming(one.name) });
      if (one.kind !== "symlink")
        list.push({ label: msgFiles.permissions, icon: <IconSlidersHorizontal size={15} />, disabled: !canChange, onSelect: () => setPrompt({ kind: "chmod", entry: one }) });
      if (remote) list.push({ label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, onSelect: () => copyPath(one) });
      list.push("separator");
    }
    list.push({ label: msgFiles.delete, icon: <IconTrash2 size={15} />, tone: "danger", shortcut: <Keys caps={["Del"]} />, disabled: !canChange, onSelect: () => setPrompt({ kind: "delete", entries: items }) });
    return list[0] === "separator" ? list.slice(1) : list;
  }

  const folderItems: MenuEntry[] = [
    { label: msgFiles.newFolder, icon: <IconFolderPlus size={15} />, disabled: !canChange, onSelect: () => setPrompt({ kind: "mkdir" }) },
    { label: msgFiles.refresh, icon: <IconRefreshCw size={15} />, disabled: !folder, onSelect: () => void refresh() },
    ...(folder?.loc.kind === "remote" ? [{ label: msgFiles.copyPath, icon: <IconClipboardCopy size={15} />, onSelect: () => copyPath(null) }] : []),
    { label: msgFiles.showHidden, checked: showHidden, onSelect: () => setShowHidden((v) => !v) },
    ...(source.kind === "local" ? (["separator", { label: msgSftp.localChange, icon: <IconFolderOpen size={15} />, onSelect: () => void chooseLocalFolder() }] as MenuEntry[]) : []),
    ...(source.kind === "host" && conn?.sessionId
      ? (["separator", { label: msgSftp.closeConnection, icon: <IconUnplug size={15} />, onSelect: () => choose({ kind: "none" }) }] as MenuEntry[])
      : []),
  ];

  const sourceLabel = source.kind === "local" ? msgSftp.thisComputer : source.kind === "host" ? source.label : msgSftp.connectTitle;
  const hiddenCount = folder ? folder.entries.filter((e) => e.name.startsWith(".")).length : 0;
  const empty = !folder ? null : folder.entries.length === 0 ? (
    <div className="ft-state">
      <IconFolderOpen size={24} />
      <strong>{msgFiles.emptyTitle}</strong>
      <span>{otherWhere ? msgSftp.emptyDrop : msgFiles.emptyBodyReadOnly}</span>
    </div>
  ) : filter.trim() ? (
    <div className="ft-state">
      <IconSearch size={22} />
      <span>{msgSftp.noMatch}</span>
    </div>
  ) : (
    <div className="ft-state">
      <IconEye size={22} />
      <span>{msgFiles.onlyHidden(hiddenCount)}</span>
      <button type="button" className="btn btn-sm" onClick={() => setShowHidden(true)}>
        {msgFiles.showHidden}
      </button>
    </div>
  );

  // ---------- render ----------

  return (
    <section
      className="sftp-pane"
      aria-label={sideLabel}
      data-active={active || undefined}
      data-drop={dropping || undefined}
      onFocus={onFocusIn}
      onPointerDown={onFocusIn}
      onDragOver={(event) => {
        if (endpoint && event.dataTransfer.types.includes(SFTP_DRAG)) {
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
        const raw = event.dataTransfer.getData(SFTP_DRAG);
        if (!raw) return;
        event.preventDefault();
        const data = JSON.parse(raw) as { side: Side; entries: RemoteEntry[] };
        if (data.side !== side) onDropFrom(data.entries);
      }}
    >
      <header className="sftp-head">
        <button type="button" className="sftp-source" aria-haspopup="menu" aria-label={`${msgSftp.source}: ${sourceLabel}`} onClick={(e) => setMenu({ kind: "source", anchor: e.currentTarget })}>
          <span className="sftp-source-icon" data-kind={source.kind} aria-hidden="true">
            {source.kind === "host" ? <IconServer size={15} /> : source.kind === "local" ? <IconHardDrive size={15} /> : <IconArrowLeftRight size={15} />}
          </span>
          <span className="sftp-source-label">{sourceLabel}</span>
          {source.kind === "host" && conn && (
            <span className="status-dot" data-tone={health === "ok" ? "ok" : health === "bad" ? "bad" : health === "attention" ? "attention" : "busy"} aria-hidden="true" />
          )}
          <IconChevronDown size={14} />
        </button>
        <span className="spacer" />
        {folder && (
          <label className="sftp-filter">
            <IconSearch size={13} aria-hidden="true" />
            <input
              className="input"
              type="search"
              aria-label={msgSftp.filter}
              placeholder={msgSftp.filterPlaceholder}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
        )}
        <IconButton size="sm" data-tooltip-side="bottom-end" label={msgSftp.actionsFor(sideLabel)} aria-haspopup="menu" onClick={(e) => setMenu({ kind: "folder", at: e.currentTarget })}>
          <IconEllipsis size={16} />
        </IconButton>
      </header>

      {folder && (
        <div className="sftp-nav">
          <IconButton size="sm" label={msgSftp.back} disabled={back.length === 0 || pending} onClick={() => void go(back[back.length - 1] as Loc, "back")}>
            <IconChevronLeft size={15} />
          </IconButton>
          <IconButton size="sm" label={msgSftp.forward} disabled={forward.length === 0 || pending} onClick={() => void go(forward[forward.length - 1] as Loc, "forward")}>
            <IconChevronRight size={15} />
          </IconButton>
          <IconButton size="sm" label={msgSftp.up} disabled={!up || pending} onClick={goUp}>
            <IconFolderUp size={15} />
          </IconButton>
          <PathBar
            crumbs={crumbs(folder.loc).map((crumb) => ({ label: crumb.label, onGo: () => void go(crumb.loc) }))}
            opening={opening}
            busy={navigating}
            editable={folder.loc.kind === "remote" ? { value: folder.loc.path, onSubmit: (path) => void go({ kind: "remote", path }) } : null}
            editRequest={editPath}
          />
          <IconButton size="sm" data-tooltip-side="bottom-end" label={msgSftp.refresh} disabled={pending} onClick={() => void refresh()}>
            <IconRefreshCw size={14} />
          </IconButton>
        </div>
      )}

      <div className="sftp-body">
        {source.kind === "none" && <HostPicker hosts={sshHosts} onLocal={() => choose({ kind: "local" })} onHost={(h) => choose({ kind: "host", hostId: h.id, label: h.label })} />}
        {source.kind === "local" && !folder && (
          <>
            <ErrorNotice error={error} />
            <EmptyState icon={<IconHardDrive size={28} />} title={msgSftp.localTitle} body={msgSftp.localBody} headingLevel={3}>
              <button type="button" className="btn btn-primary" onClick={() => void chooseLocalFolder()} disabled={pending}>
                <IconFolderOpen size={15} /> {msgSftp.localChoose}
              </button>
            </EmptyState>
          </>
        )}
        {source.kind === "host" && conn && !folder && (
          <>
            {conn.state === "connected" && error ? (
              <div className="ft-state" role="alert">
                <IconTriangleAlert size={22} />
                <strong>{msgFiles.loadFailed}</strong>
                <span>{error.message}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    clearError();
                    const id = sessionRef.current;
                    if (id) void listRemote(id, null).then((f) => f && setFolder(f));
                  }}
                >
                  <IconRefreshCw size={14} /> {msgFiles.retry}
                </button>
              </div>
            ) : (
              <ConnectionState
                label={source.label}
                conn={conn}
                onReconnect={() => connect(source.hostId)}
                onOther={() => choose({ kind: "none" })}
                onOpenKnownHosts={onOpenKnownHosts}
              />
            )}
          </>
        )}
        {folder && (
          <>
            {slow && <div className="list-progress sftp-progress" role="progressbar" aria-label={msg.files.loadingFolder} />}
            <ErrorNotice error={error} />
            {folder.truncated && <Notice tone="warning">{msgSftp.truncated(folder.entries.length)}</Notice>}
            <FileTable
              label={msgSftp.listLabel(where)}
              entries={entries}
              columns={["name", "modified", "size", "mode"]}
              sort={sort}
              onSort={(key: SortKey) => setSort((s) => (s.key === key ? { ...s, ascending: !s.ascending } : { key, ascending: true }))}
              selection={picked}
              onSelection={setPicked}
              opening={opening}
              busy={navigating}
              inactive={!active}
              renaming={renaming}
              onRename={rename}
              onRenameEnd={() => setRenaming(null)}
              onActivate={activate}
              onMenu={(items, at) => setMenu({ kind: "row", entries: items, at })}
              onBackgroundMenu={(at) => setMenu({ kind: "folder", at })}
              onKey={(key) => {
                if (key === "up") goUp();
                else if (key === "back" && back.length > 0) void go(back[back.length - 1] as Loc, "back");
                else if (key === "forward" && forward.length > 0) void go(forward[forward.length - 1] as Loc, "forward");
                else if (key === "rename" && selection && canChange) setRenaming(selection.name);
                else if (key === "delete" && chosen.length > 0 && canChange) setPrompt({ kind: "delete", entries: chosen });
                else if (key === "copyOther" && movable(chosen).length > 0) onTransfer(movable(chosen));
                else if (key === "editPath") setEditPath((n) => n + 1);
              }}
              canDrag={(entry) => endpoint !== null && (entry.kind === "file" || entry.kind === "dir")}
              onDragStart={(event, entry, isSelected) => {
                // Dragging a selected row takes the whole selection; another row goes alone.
                const dragged = isSelected && movable(chosen).length > 0 ? movable(chosen) : [entry];
                if (!isSelected) setPicked(single(entry.name));
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(SFTP_DRAG, JSON.stringify({ side, entries: dragged }));
              }}
              empty={empty}
            />
          </>
        )}
        {dropping && endpoint && (
          <div className="sftp-drop-hint" aria-hidden="true">
            {msgSftp.dropHere(where)}
          </div>
        )}
      </div>

      {folder && (
        <div className="sftp-footer" role="status" aria-label={msg.files.selectionStatus}>
          {selectionSummary(entries, picked.names, (n) => formatSize(n))}
        </div>
      )}

      {menu?.kind === "source" && <Menu anchor={menu.anchor} items={sourceItems} label={msgSftp.source} onClose={() => setMenu(null)} />}
      {menu?.kind === "folder" && (
        <Menu
          anchor={menu.at instanceof HTMLElement ? menu.at : undefined}
          point={menu.at instanceof HTMLElement ? undefined : menu.at}
          items={folderItems}
          label={msgSftp.actions}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === "row" && (
        <Menu
          anchor={menu.at instanceof HTMLElement ? menu.at : undefined}
          point={menu.at instanceof HTMLElement ? undefined : menu.at}
          items={rowItems(menu.entries)}
          label={menu.entries.length === 1 ? msgFiles.rowMenu((menu.entries[0] as RemoteEntry).name) : msg.files.selectionStatus}
          onClose={() => setMenu(null)}
        />
      )}

      {prompt && folder && endpoint && (
        <ChangePrompt
          prompt={prompt}
          endpoint={endpoint}
          onDone={(changed) => {
            setPrompt(null);
            if (changed) void refresh();
          }}
        />
      )}

      {visible && conn?.trust && (
        <TrustDialog
          trust={conn.trust}
          onAnswer={(decision) => {
            const id = conn.sessionId ?? sessionRef.current;
            const promptId = conn.trust?.promptId;
            setConn((c) => (c ? { ...c, trust: null } : c));
            if (id && promptId) void sessions.answerTrust(id, promptId, decision).catch(() => undefined);
          }}
        />
      )}
      {visible && conn?.auth && !conn.trust && (
        <AuthDialog
          key={conn.auth.promptId}
          prompt={conn.auth}
          banner={conn.banner}
          onAnswer={(secret) => {
            const id = conn.sessionId ?? sessionRef.current;
            const promptId = conn.auth?.promptId;
            setConn((c) => (c ? { ...c, auth: null } : c));
            if (id && promptId) void sessions.answerAuth(id, promptId, secret).catch(() => undefined);
          }}
        />
      )}
    </section>
  );
}

function HostPicker({ hosts, onLocal, onHost }: { hosts: HostSummary[]; onLocal: () => void; onHost: (host: HostSummary) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = hosts.filter((h) => !needle || h.label.toLowerCase().includes(needle) || h.address.toLowerCase().includes(needle));
  return (
    <div className="sftp-picker">
      <div className="sftp-picker-head">
        <span className="sftp-picker-art" aria-hidden="true">
          <IconArrowLeftRight size={22} />
        </span>
        <h3>{msgSftp.connectTitle}</h3>
        <p>{msgSftp.connectBody}</p>
      </div>
      <div className="sftp-picker-list" role="group" aria-label={msgSftp.selectHost}>
        {hosts.length > 6 && (
          <label className="sftp-filter sftp-picker-search">
            <IconSearch size={13} aria-hidden="true" />
            <input className="input" type="search" aria-label={msgSftp.searchHosts} placeholder={msgSftp.searchHosts} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        <button type="button" className="sftp-host" onClick={onLocal}>
          <span className="sftp-host-icon" data-kind="local" aria-hidden="true">
            <IconHardDrive size={15} />
          </span>
          <span className="sftp-host-text">
            <span>{msgSftp.thisComputer}</span>
          </span>
        </button>
        {hosts.length === 0 && <p className="muted sftp-empty">{msgSftp.noHosts}</p>}
        {shown.map((h) => (
          <button key={h.id} type="button" className="sftp-host" onClick={() => onHost(h)}>
            <span className="sftp-host-icon" aria-hidden="true">
              <IconServer size={15} />
            </span>
            <span className="sftp-host-text">
              <span>{h.label}</span>
              <span className="faint mono">{msg.hosts.destination(h.username, h.address, h.port)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectionState({
  label,
  conn,
  onReconnect,
  onOther,
  onOpenKnownHosts,
}: {
  label: string;
  conn: Connection;
  onReconnect: () => void;
  onOther: () => void;
  onOpenKnownHosts: () => void;
}) {
  if (conn.state !== "failed" && conn.state !== "closed") {
    const step = conn.state === "starting" ? msgSftp.state.connecting : (msgSftp.state[conn.state] ?? "");
    return (
      <div className="sftp-status" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>
          {msgSftp.connecting(label)}
          <span className="faint"> · {step}</span>
        </span>
      </div>
    );
  }
  if (conn.changed) {
    return (
      <div className="sftp-card" role="alert">
        <div className="dialog-head">
          <span className="dialog-icon" data-tone="danger" aria-hidden="true">
            <IconShieldAlert size={18} />
          </span>
          <h3>{msgSftp.changedTitle}</h3>
        </div>
        <HopNotice hop={conn.changed.hop} />
        <p>{msgSftp.changedBody}</p>
        <div className="stack-xs">
          <span className="label">{msg.terminal.changedPresented}</span>
          <Fingerprint value={conn.changed.presentedFingerprint} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onOther}>
            {msgSftp.otherHost}
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpenKnownHosts}>
            {msgSftp.openKnownHosts}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sftp-card" role={conn.error ? "alert" : "status"}>
      <div className="dialog-head">
        <span className="dialog-icon" data-tone={conn.error ? "warning" : "accent"} aria-hidden="true">
          <IconTriangleAlert size={18} />
        </span>
        <h3>{conn.error ? msgSftp.failedTitle : msgSftp.endedTitle}</h3>
      </div>
      {conn.error && <p>{conn.error.message}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onOther}>
          {msgSftp.otherHost}
        </button>
        <button type="button" className="btn btn-primary" onClick={onReconnect}>
          <IconRefreshCw size={15} /> {msgSftp.reconnect}
        </button>
      </div>
    </div>
  );
}

/** Host-key decision for a new server. The safe choice has initial focus. */
function TrustDialog({ trust, onAnswer }: { trust: Trust; onAnswer: (decision: "cancel" | "once" | "always") => void }) {
  return (
    <Dialog title={msg.terminal.trustTitle} role="alertdialog" icon={<IconShieldCheck size={18} />} onDismiss={() => onAnswer("cancel")}>
      <HopNotice hop={trust.hop} />
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msg.terminal.trustIntro}
      </p>
      <dl className="kv">
        <dt>{msg.terminal.host}</dt>
        <dd>
          {trust.host} : {trust.port}
        </dd>
        {trust.resolvedAddress && trust.resolvedAddress !== trust.host && (
          <>
            <dt>{msg.terminal.resolved}</dt>
            <dd>{trust.resolvedAddress}</dd>
          </>
        )}
        <dt>{msg.terminal.algorithm}</dt>
        <dd>{trust.algorithm}</dd>
      </dl>
      <div className="stack-xs">
        <span className="label">{msg.terminal.fingerprint}</span>
        <Fingerprint value={trust.fingerprint} />
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => onAnswer("cancel")} autoFocus data-autofocus>
          {msg.terminal.trustCancel}
        </button>
        <button type="button" className="btn" onClick={() => onAnswer("once")}>
          {msg.terminal.trustOnce}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onAnswer("always")}>
          {msg.terminal.trustAlways}
        </button>
      </div>
    </Dialog>
  );
}

/** New folder, rename, permissions and delete, on either kind of pane. */
function ChangePrompt({ prompt, endpoint, onDone }: { prompt: Prompt; endpoint: Endpoint; onDone: (changed: boolean) => void }) {
  const initial = prompt.kind === "chmod" ? octal(prompt.entry.permissions) : "";
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  /** Something was deleted before a later item failed: the folder needs listing again. */
  const deleted = useRef(false);

  function call(): Promise<void> | null {
    const value = text.trim();
    const local = endpoint.kind === "local";
    switch (prompt.kind) {
      case "mkdir":
        return local ? filesApi.localMkdir(endpoint.token, endpoint.path, value) : filesApi.mkdir(endpoint.sessionId, endpoint.path, value);
      case "chmod": {
        if (!/^[0-7]{3,4}$/.test(value)) {
          setInvalid(msg.files.modeInvalid);
          return null;
        }
        const mode = Number.parseInt(value, 8);
        return local
          ? filesApi.localChmod(endpoint.token, endpoint.path, prompt.entry.name, mode)
          : filesApi.chmod(endpoint.sessionId, endpoint.path, prompt.entry.name, mode);
      }
      case "delete": {
        // One after another; a failure stops there and says which item it was.
        const entries = prompt.entries;
        return (async () => {
          for (const entry of entries) {
            try {
              await (local ? filesApi.localRemove(endpoint.token, endpoint.path, entry.name) : filesApi.remove(endpoint.sessionId, endpoint.path, entry.name));
            } catch (caught) {
              const e = toAppError(caught);
              throw entries.length > 1 ? new AppError({ code: e.code, message: `${visibleName(entry.name)}: ${e.message}` }) : e;
            }
            deleted.current = true;
          }
        })();
      }
    }
  }

  async function submit() {
    setInvalid(null);
    const action = call();
    if (!action) return;
    const ok = await run(() => action.then(() => true));
    if (ok) onDone(true);
  }

  if (prompt.kind === "delete") {
    const only = prompt.entries.length === 1 ? prompt.entries[0] : undefined;
    return (
      <Dialog
        title={only ? msg.files.deleteTitle(only.name) : msgSftp.deleteMany(prompt.entries.length)}
        role="alertdialog"
        tone="danger"
        icon={<IconTrash2 size={18} />}
        onDismiss={() => onDone(deleted.current)}
      >
        <div className="stack">
          <p>{endpoint.kind === "local" ? msgSftp.deleteLocalBody : msgSftp.deleteRemoteBody}</p>
          <ErrorNotice error={error as AppError | null} />
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

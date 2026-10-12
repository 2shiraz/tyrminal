import type { HostSummary, RemoteEntry, SessionEvent, SessionState } from "@tyrminal/contracts";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Menu, type MenuEntry } from "../../components/ui/Menu";
import { EmptyState, ErrorNotice, IconButton, Notice, TextField } from "../../components/ui/controls";
import {
  IconArrowLeftRight,
  IconArrowUpDown,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconEllipsis,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderUp,
  IconHardDrive,
  IconLink2,
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
import { type AppError, files as filesApi, sessions, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
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
  formatModified,
  formatSize,
  localFolder,
  locText,
  modeString,
  octal,
  parentLoc,
  remoteFolder,
  sameLoc,
  visibleEntries,
  visibleName,
} from "./model";

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

type Prompt =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete"; entry: RemoteEntry };

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: msgSftp.columns.name },
  { key: "modified", label: msgSftp.columns.modified },
  { key: "size", label: msgSftp.columns.size },
  { key: "kind", label: msgSftp.columns.kind },
];

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "dir") return <IconFolder size={16} />;
  if (entry.kind === "symlink") return <IconLink2 size={16} />;
  return <IconFile size={16} />;
}

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
  refreshKey,
  otherWhere,
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
  /** Bumped by the tab when a transfer into this pane's folder finished. */
  refreshKey: number;
  /** Where "Copy to …" sends the selection (the other pane), or null when it cannot. */
  otherWhere: string | null;
  onEndpoint: (endpoint: Endpoint | null) => void;
  onHealth: (health: PaneHealth) => void;
  /** Copies `entry` from this pane's folder to the other pane's folder. */
  onTransfer: (entry: RemoteEntry) => void;
  /** An entry of the other pane was dropped here: copy it into this pane's folder. */
  onDropFrom: (entry: RemoteEntry) => void;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [sourceMenu, setSourceMenu] = useState<HTMLElement | null>(null);
  const [actionsMenu, setActionsMenu] = useState<HTMLElement | null>(null);
  const [dropping, setDropping] = useState(false);
  const { pending, error, run, clearError } = useAction();
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
      setSelected(null);
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
    setSelected(null);
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
      setSelected(null);
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

  async function go(loc: Loc, history: "push" | "back" | "forward" | "none" = "push") {
    const next = await load(loc);
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
    setSelected((name) => (sameLoc(from, next.loc) && next.entries.some((e) => e.name === name) ? name : null));
    if (!sameLoc(from, next.loc)) setFilter("");
  }

  const refresh = useCallback(async () => {
    if (!folder) return;
    const next = await load(folder.loc);
    if (next) {
      setFolder(next);
      setSelected((name) => (next.entries.some((e) => e.name === name) ? name : null));
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
  const selection = entries.find((e) => e.name === selected) ?? null;
  const where = folder ? (folder.loc.kind === "local" ? msgSftp.localWhere(locText(folder.loc)) : msgSftp.remoteWhere(source.kind === "host" ? source.label : "", folder.loc.path)) : "";
  const up = folder ? parentLoc(folder.loc) : null;

  function activate(entry: RemoteEntry) {
    if (!folder) return;
    if (entry.kind === "dir" || (entry.kind === "symlink" && folder.loc.kind === "remote")) void go(childLoc(folder.loc, entry.name));
    else setSelected(entry.name);
  }

  function onListKey(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest("input, select, textarea")) return;
    if (event.altKey && event.key === "ArrowLeft" && back.length > 0) {
      event.preventDefault();
      void go(back[back.length - 1] as Loc, "back");
    } else if (event.altKey && event.key === "ArrowRight" && forward.length > 0) {
      event.preventDefault();
      void go(forward[forward.length - 1] as Loc, "forward");
    } else if (event.altKey && event.key === "ArrowUp" && up) {
      event.preventDefault();
      void go(up);
    } else if (event.key === "Delete" && selection) {
      event.preventDefault();
      setPrompt({ kind: "delete", entry: selection });
    } else if (event.key === "F2" && selection) {
      event.preventDefault();
      setPrompt({ kind: "rename", entry: selection });
    }
  }

  // ---------- menus ----------

  const sshHosts = hosts.filter((h) => h.protocol.type === "ssh");
  const sourceItems: MenuEntry[] = [
    { label: msgSftp.thisComputer, icon: <IconHardDrive size={15} />, onSelect: () => choose({ kind: "local" }) },
    ...(sshHosts.length > 0 ? (["separator"] as MenuEntry[]) : []),
    ...sshHosts.map((h) => ({ label: h.label, icon: <IconServer size={15} />, onSelect: () => choose({ kind: "host", hostId: h.id, label: h.label }) })),
  ];

  const canChange = folder !== null && endpoint !== null;
  const actionItems: MenuEntry[] = [
    ...(selection && otherWhere && (selection.kind === "file" || selection.kind === "dir")
      ? ([{ label: msgSftp.transferTo(otherWhere), icon: <IconArrowLeftRight size={15} />, onSelect: () => onTransfer(selection) }, "separator"] as MenuEntry[])
      : []),
    { label: msgSftp.newFolder, icon: <IconFolderPlus size={15} />, disabled: !canChange, onSelect: () => setPrompt({ kind: "mkdir" }) },
    { label: msgSftp.rename, icon: <IconPencil size={15} />, disabled: !canChange || !selection, onSelect: () => selection && setPrompt({ kind: "rename", entry: selection }) },
    {
      label: msgSftp.permissions,
      icon: <IconSlidersHorizontal size={15} />,
      disabled: !canChange || !selection || selection.kind === "symlink",
      onSelect: () => selection && setPrompt({ kind: "chmod", entry: selection }),
    },
    { label: msgSftp.delete, icon: <IconTrash2 size={15} />, tone: "danger", disabled: !canChange || !selection, onSelect: () => selection && setPrompt({ kind: "delete", entry: selection }) },
    "separator",
    { label: msgSftp.refresh, icon: <IconRefreshCw size={15} />, disabled: !folder, onSelect: () => void refresh() },
    {
      label: showHidden ? msgSftp.hideHidden : msgSftp.showHidden,
      icon: showHidden ? <IconEyeOff size={15} /> : <IconEye size={15} />,
      onSelect: () => setShowHidden((v) => !v),
    },
    ...(source.kind === "local" ? (["separator", { label: msgSftp.localChange, icon: <IconFolderOpen size={15} />, onSelect: () => void chooseLocalFolder() }] as MenuEntry[]) : []),
    ...(source.kind === "host" && conn?.sessionId
      ? (["separator", { label: msgSftp.closeConnection, icon: <IconUnplug size={15} />, onSelect: () => choose({ kind: "none" }) }] as MenuEntry[])
      : []),
  ];

  const sourceLabel = source.kind === "local" ? msgSftp.thisComputer : source.kind === "host" ? source.label : msgSftp.connectTitle;

  // ---------- render ----------

  return (
    <section
      className="sftp-pane"
      aria-label={sideLabel}
      data-drop={dropping || undefined}
      onKeyDown={onListKey}
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
        const data = JSON.parse(raw) as { side: Side; entry: RemoteEntry };
        if (data.side !== side) onDropFrom(data.entry);
      }}
    >
      <header className="sftp-head">
        <button type="button" className="sftp-source" aria-haspopup="menu" aria-label={`${msgSftp.source}: ${sourceLabel}`} onClick={(e) => setSourceMenu(e.currentTarget)}>
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
        <IconButton size="sm" label={msgSftp.actionsFor(sideLabel)} aria-haspopup="menu" onClick={(e) => setActionsMenu(e.currentTarget)}>
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
          <IconButton size="sm" label={msgSftp.up} disabled={!up || pending} onClick={() => up && void go(up)}>
            <IconFolderUp size={15} />
          </IconButton>
          <nav className="sftp-crumbs" aria-label={msgSftp.breadcrumbs}>
            <ol>
              {crumbs(folder.loc).map((crumb, index, all) => {
                const last = index === all.length - 1;
                return (
                  // Positions identify the crumbs: the same name can appear twice in a path.
                  <li key={`${index}-${crumb.label}`}>
                    {last ? (
                      <span aria-current="location" className="sftp-crumb sftp-crumb-current" title={visibleName(crumb.label)}>
                        {visibleName(crumb.label)}
                      </span>
                    ) : (
                      <button type="button" className="sftp-crumb" onClick={() => void go(crumb.loc)} title={visibleName(crumb.label)}>
                        {visibleName(crumb.label)}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
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
          <IconButton size="sm" label={msgSftp.refresh} disabled={pending} onClick={() => void refresh()}>
            <IconRefreshCw size={14} />
          </IconButton>
        </div>
      )}

      <div className="sftp-body">
        <ErrorNotice error={error} />
        {source.kind === "none" && <HostPicker hosts={sshHosts} onLocal={() => choose({ kind: "local" })} onHost={(h) => choose({ kind: "host", hostId: h.id, label: h.label })} />}
        {source.kind === "local" && !folder && (
          <EmptyState icon={<IconHardDrive size={28} />} title={msgSftp.localTitle} body={msgSftp.localBody} headingLevel={3}>
            <button type="button" className="btn btn-primary" onClick={() => void chooseLocalFolder()} disabled={pending}>
              <IconFolderOpen size={15} /> {msgSftp.localChoose}
            </button>
          </EmptyState>
        )}
        {source.kind === "host" && conn && !folder && (
          <ConnectionState
            label={source.label}
            conn={conn}
            onReconnect={() => connect(source.hostId)}
            onOther={() => choose({ kind: "none" })}
            onOpenKnownHosts={onOpenKnownHosts}
          />
        )}
        {folder && (
          <>
            {folder.truncated && <Notice tone="warning">{msgSftp.truncated(folder.entries.length)}</Notice>}
            <table className="sftp-table" aria-label={msgSftp.listLabel(where)}>
              <thead>
                <tr>
                  {SORT_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={`sftp-col-${column.key}`}
                      aria-sort={sort.key === column.key ? (sort.ascending ? "ascending" : "descending") : "none"}
                    >
                      <button
                        type="button"
                        className="sftp-sort"
                        aria-label={msgSftp.sortBy(column.label)}
                        onClick={() => setSort((s) => (s.key === column.key ? { ...s, ascending: !s.ascending } : { key: column.key, ascending: true }))}
                      >
                        {column.label}
                        {sort.key === column.key ? (
                          <IconChevronDown size={12} className={sort.ascending ? "" : "sftp-sort-desc"} />
                        ) : (
                          <IconArrowUpDown size={12} className="sftp-sort-idle" />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const isSelected = entry.name === selected;
                  const name = visibleName(entry.name);
                  return (
                    <tr
                      key={entry.name}
                      aria-selected={isSelected}
                      data-kind={entry.kind}
                      draggable={endpoint !== null && (entry.kind === "file" || entry.kind === "dir")}
                      onDragStart={(event) => {
                        setSelected(entry.name);
                        event.dataTransfer.effectAllowed = "copy";
                        event.dataTransfer.setData(SFTP_DRAG, JSON.stringify({ side, entry }));
                      }}
                      onClick={() => setSelected(entry.name)}
                      onDoubleClick={() => activate(entry)}
                    >
                      <td className="sftp-col-name">
                        <button
                          type="button"
                          className="sftp-name"
                          aria-label={entry.kind === "dir" ? msg.files.open(entry.name) : msg.files.select(entry.name)}
                          aria-pressed={isSelected}
                          onFocus={() => setSelected(entry.name)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              activate(entry);
                            }
                          }}
                        >
                          <span className={`files-icon files-icon-${entry.kind}`}>
                            <EntryIcon entry={entry} />
                          </span>
                          <span className="sftp-name-text">
                            <span className="sftp-name-main" title={name}>
                              {name}
                            </span>
                            <span className="sftp-perm mono">{modeString(entry)}</span>
                          </span>
                        </button>
                      </td>
                      <td className="sftp-col-modified">{formatModified(entry.modified)}</td>
                      <td className="sftp-col-size mono">{entry.kind === "dir" ? "" : formatSize(entry.size)}</td>
                      <td className="sftp-col-kind">{msgSftp.kind[entry.kind]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {entries.length === 0 && <p className="muted sftp-empty">{folder.entries.length === 0 ? msgSftp.empty : filter.trim() ? msgSftp.noMatch : msgSftp.onlyHidden}</p>}
          </>
        )}
        {dropping && endpoint && (
          <div className="sftp-drop-hint" aria-hidden="true">
            {msgSftp.dropHere(where)}
          </div>
        )}
      </div>

      {sourceMenu && <Menu anchor={sourceMenu} items={sourceItems} label={msgSftp.source} onClose={() => setSourceMenu(null)} />}
      {actionsMenu && <Menu anchor={actionsMenu} items={actionItems} label={msgSftp.actions} onClose={() => setActionsMenu(null)} />}

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
  const initial = prompt.kind === "rename" ? prompt.entry.name : prompt.kind === "chmod" ? octal(prompt.entry.permissions) : "";
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  function call(): Promise<void> | null {
    const value = text.trim();
    const local = endpoint.kind === "local";
    switch (prompt.kind) {
      case "mkdir":
        return local ? filesApi.localMkdir(endpoint.token, endpoint.path, value) : filesApi.mkdir(endpoint.sessionId, endpoint.path, value);
      case "rename":
        return local
          ? filesApi.localRename(endpoint.token, endpoint.path, prompt.entry.name, value)
          : filesApi.rename(endpoint.sessionId, endpoint.path, prompt.entry.name, value);
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
      case "delete":
        return local ? filesApi.localRemove(endpoint.token, endpoint.path, prompt.entry.name) : filesApi.remove(endpoint.sessionId, endpoint.path, prompt.entry.name);
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
    return (
      <Dialog title={msg.files.deleteTitle(prompt.entry.name)} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => onDone(false)}>
        <div className="stack">
          <p>{endpoint.kind === "local" ? msgSftp.deleteLocalBody : msgSftp.deleteRemoteBody}</p>
          <ErrorNotice error={error as AppError | null} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onDone(false)} data-autofocus>
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

  const title =
    prompt.kind === "mkdir" ? msg.files.newFolderTitle : prompt.kind === "rename" ? msg.files.renameTitle(prompt.entry.name) : msg.files.permissionsTitle(prompt.entry.name);
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

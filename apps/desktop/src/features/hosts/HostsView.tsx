import type { BulkHostChange, GroupSummary, HostOs, HostSummary, IdentityAssignment, KeySummary, SettingsTarget } from "@tyrminal/contracts";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { MAX_PANES, type Workspace, paneCount, panesOf } from "../../app/workspace";
import { Dialog } from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { Avatar, EmptyState, ErrorNotice, IconButton, Segmented, SkeletonRows, TextField, relativeTime } from "../../components/ui/controls";
import {
  IconCopy,
  IconEllipsis,
  IconFolder,
  IconFolderPlus,
  IconKeyRound,
  IconLayoutGrid,
  IconList,
  IconLock,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconSlidersHorizontal,
  IconTextCursorInput,
  IconTrash2,
  IconUpload,
  IconUser,
  IconX,
} from "../../components/ui/icons";
import { appearance as appearanceApi, groups as groupsApi, hosts as hostsApi, identities as identitiesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";
import { GroupEditor, descendantsOf } from "./GroupEditor";
import { HostPanel, type PanelTarget } from "./HostPanel";
import { groupPath } from "./hostForm";
import { ImportDialog } from "./ImportDialog";
import { ConnectAllDialog, SetOsDialog } from "./InventoryDialogs";
import { OsIcon } from "./OsIcon";
import { identityEvents, useIdentities } from "../credentials/IdentitiesSection";
import { AssignIdentityDialog } from "./AssignIdentityDialog";
import { EnvironmentDialog } from "./EnvironmentDialog";

export function authSummary(host: HostSummary, keys: KeySummary[]): string {
  switch (host.auth.kind) {
    case "ask_password":
      return msg.hosts.authAsk;
    case "stored_password":
      return msg.hosts.authStored;
    case "key": {
      const keyId = host.auth.keyId;
      const key = keys.find((k) => k.id === keyId);
      const text = key ? msg.hosts.authKey(key.label) : msg.hosts.authKeyMissing;
      return host.inherited.auth ? msg.hosts.authInherited(text) : text;
    }
  }
}

/** Groups as a depth-first tree with their nesting level, siblings by name. */
function groupTree(groups: GroupSummary[]): { group: GroupSummary; depth: number }[] {
  const children = new Map<string | null, GroupSummary[]>();
  for (const g of groups) {
    const list = children.get(g.parentId) ?? [];
    list.push(g);
    children.set(g.parentId, list);
  }
  const out: { group: GroupSummary; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const g of list) {
      out.push({ group: g, depth });
      if (depth < 16) walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

type GroupFilter = { kind: "all" } | { kind: "none" } | { kind: "group"; id: string };

function AuthBadge({ host, keys }: { host: HostSummary; keys: KeySummary[] }) {
  const Icon = host.auth.kind === "key" ? IconKeyRound : host.auth.kind === "stored_password" ? IconLock : IconTextCursorInput;
  const tone = host.auth.kind === "key" && !keys.some((k) => host.auth.kind === "key" && k.id === host.auth.keyId) ? "badge-danger" : "";
  return (
    <span className={`badge ${tone}`}>
      <Icon size={12} />
      {authSummary(host, keys)}
    </span>
  );
}

type Layout = "grid" | "list";
type Sort = "name" | "recent" | "address" | "group";

/** Hosts this view can mark: a checkbox click with Shift selects the range since the last click. */
function rangeBetween(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function HostsView({ ws, onConnect }: { ws: Workspace; onConnect: (host: HostSummary) => void }) {
  const { hosts, keys, recent, groups } = useVaultData();
  const notify = useToast();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<{ query: string; ids: Set<string> } | null>(null);
  const [layout, setLayout] = useState<Layout>("grid");
  const [sort, setSort] = useState<Sort>("name");
  const [filter, setFilter] = useState<GroupFilter>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Host details panel: what it shows, a counter that rebuilds it after a save, and the guard state.
  const [panel, setPanel] = useState<{ target: PanelTarget; version: number; justSaved: boolean } | null>(null);
  const [discarding, setDiscarding] = useState<(() => void) | null>(null);
  const panelDirty = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [deleting, setDeleting] = useState<HostSummary | null>(null);
  const [menu, setMenu] = useState<{ host: HostSummary; anchor: HTMLElement } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ group: GroupSummary; anchor: HTMLElement } | null>(null);
  const [editingGroup, setEditingGroup] = useState<{ group: GroupSummary | null; parentId?: string | null } | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<GroupSummary | null>(null);
  const [bulk, setBulk] = useState<"move" | "add_tag" | "remove_tag" | "delete" | null>(null);
  const [importing, setImporting] = useState(false);
  const [osOf, setOsOf] = useState<Map<string, HostOs>>(new Map());
  const [settingOs, setSettingOs] = useState<{ ids: string[]; initial: HostOs | null } | null>(null);
  const [connectAll, setConnectAll] = useState<{ hosts: HostSummary[]; groupName: string | null } | null>(null);
  // Identities (KEY-17): which one every host and group uses.
  const identityList = useIdentities();
  const [assignments, setAssignments] = useState<Map<string, IdentityAssignment>>(new Map());
  const [assigning, setAssigning] = useState<{ target: SettingsTarget; name: string } | null>(null);
  const [environmentFor, setEnvironmentFor] = useState<{ target: SettingsTarget; name: string } | null>(null);
  const anchor = useRef<string | null>(null);
  const version = useRef(0);
  const remove = useAction();
  const action = useAction();
  const keyList = keys.value ?? [];
  const groupList = groups.value ?? [];
  const tree = useMemo(() => groupTree(groupList), [groupList]);

  // Hosts with an open session, from the user's own tabs (no probing of servers).
  const connected = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of ws.tabs) {
      for (const id of panesOf(tab.layout)) {
        const pane = ws.panes[id];
        if (pane?.target.kind === "ssh" && pane.indicator === "ok") ids.add(pane.target.hostId);
      }
    }
    return ids;
  }, [ws]);

  // OS icons live in their own records; reload them with the host list.
  useEffect(() => {
    if (!hosts.value) return;
    let live = true;
    appearanceApi
      .list()
      .then((list) => {
        if (live) setOsOf(new Map(list.map((a) => [a.hostId, a.os])));
      })
      .catch(() => {
        if (live) setOsOf(new Map());
      });
    return () => {
      live = false;
    };
  }, [hosts.value]);

  useEffect(() => {
    if (!hosts.value) return;
    let live = true;
    const load = () =>
      identitiesApi
        .assignments()
        .then((list) => {
          const key = (t: SettingsTarget) => (t.kind === "host" ? `host:${t.hostId}` : `group:${t.groupId}`);
          if (live) setAssignments(new Map(list.map((a) => [key(a.target), a])));
        })
        .catch(() => {
          if (live) setAssignments(new Map());
        });
    void load();
    const unsubscribe = identityEvents.subscribe(() => void load());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [hosts.value, groups.value]);
  const identityOf = (hostId: string) => {
    const id = assignments.get(`host:${hostId}`)?.effectiveIdentityId;
    const label = id ? identityList?.find((i) => i.id === id)?.label : undefined;
    return label ? msgD.identities.badge(label) : null;
  };

  // Search runs in the core (names, addresses, users, tags, group paths; tag:/group: terms).
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setSearched(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      hostsApi
        .search(text)
        .then((found) => {
          if (live) setSearched({ query: text, ids: new Set(found.map((h) => h.id)) });
        })
        .catch(() => {
          if (live) setSearched({ query: text, ids: new Set() });
        });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, hosts.value]);

  const filtered = useMemo(() => {
    let all = [...(hosts.value ?? [])];
    if (filter.kind === "none") all = all.filter((h) => !h.groupId);
    if (filter.kind === "group") {
      const inside = descendantsOf(groupList, filter.id);
      all = all.filter((h) => h.groupId !== null && inside.has(h.groupId));
    }
    if (query.trim() && searched) all = all.filter((h) => searched.ids.has(h.id));
    const byLabel = (a: HostSummary, b: HostSummary) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
    const path = (h: HostSummary) => (h.groupId ? groupPath(groupList, h.groupId) : "");
    if (sort === "name") all.sort(byLabel);
    if (sort === "recent") all.sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || byLabel(a, b));
    if (sort === "address") all.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }) || a.port - b.port || byLabel(a, b));
    // Hosts without a group last.
    if (sort === "group") all.sort((a, b) => Number(!a.groupId) - Number(!b.groupId) || path(a).localeCompare(path(b)) || byLabel(a, b));
    return all;
  }, [hosts.value, query, searched, sort, filter, groupList]);

  const total = hosts.value?.length ?? 0;
  const reload = () => {
    void hosts.reload();
    void recent.reload();
    void keys.reload();
    void groups.reload();
  };
  const selectedIds = [...selected].filter((id) => hosts.value?.some((h) => h.id === id));
  const toggle = (id: string, event?: MouseEvent) => {
    const from = anchor.current;
    anchor.current = id;
    setSelected((current) => {
      const next = new Set(current);
      const on = !next.has(id);
      const ids = event?.shiftKey && from ? rangeBetween(filtered.map((h) => h.id), from, id) : [id];
      for (const x of ids) {
        if (on) next.add(x);
        else next.delete(x);
      }
      return next;
    });
  };
  const shownSelected = filtered.filter((h) => selected.has(h.id)).length;
  const toggleAllShown = () =>
    setSelected((current) => {
      const next = new Set(current);
      const all = filtered.length > 0 && filtered.every((h) => next.has(h.id));
      for (const h of filtered) {
        if (all) next.delete(h.id);
        else next.add(h.id);
      }
      return next;
    });
  const free = Math.max(0, MAX_PANES - paneCount(ws));
  const hostsInGroup = (id: string) => {
    const inside = descendantsOf(groupList, id);
    return [...(hosts.value ?? [])]
      .filter((h) => h.groupId !== null && inside.has(h.groupId))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  };

  async function duplicate(host: HostSummary) {
    const copy = await action.run(() => hostsApi.duplicate(host.id));
    if (copy) {
      notify("success", msg.hosts.duplicated(copy.label));
      reload();
    }
  }

  const actions = (host: HostSummary, anchor: HTMLElement) => setMenu({ host, anchor });

  // The panel takes the whole view when the list and the panel do not both fit.
  useEffect(() => {
    const el = layoutRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 0) < NARROW_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Runs `then` now, or after the user agrees to discard the panel's unsaved changes. */
  const guard = (then: () => void) => {
    if (panel && panelDirty.current) setDiscarding(() => then);
    else then();
  };
  const show = (target: PanelTarget, justSaved = false) => {
    version.current += 1;
    panelDirty.current = false;
    setPanel({ target, version: version.current, justSaved });
  };
  const openPanel = (target: PanelTarget) => {
    if (target.kind === "edit" && panel?.target.kind === "edit" && panel.target.host.id === target.host.id) return;
    // Remember what opened the panel (the latest host name or button outside it) to return focus there.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest(".host-panel")) opener.current = active;
    guard(() => show(target));
  };
  /** Closes the panel and puts focus back where it was opened from (or on "Add host"). */
  const closePanel = useCallback(() => {
    const back = opener.current;
    opener.current = null;
    panelDirty.current = false;
    setPanel(null);
    requestAnimationFrame(() => (back?.isConnected ? back : addButton.current)?.focus());
  }, []);
  const panelHostId = panel?.target.kind === "edit" ? panel.target.host.id : null;
  const currentGroupId = filter.kind === "group" ? filter.id : null;
  const groupName = (id: string | null) => (id ? groupPath(groupList, id) : null);

  return (
    <div className="hosts-layout" ref={layoutRef} data-narrow={narrow} data-panel={panel !== null}>
      <div className="page hosts-main" inert={narrow && panel !== null}>
        <section className="page-inner" aria-labelledby="hosts-title">
          <div className="page-header">
            <div className="page-title">
              <h1 id="hosts-title">{msg.hosts.title}</h1>
              {total > 0 && <p>{msg.hosts.subtitle(total)}</p>}
            </div>
            <div className="row-flex">
              <button type="button" className="btn" onClick={() => setImporting(true)}>
                <IconUpload size={15} />
                {msg.hosts.import}
              </button>
              <button
                ref={addButton}
                type="button"
                className="btn btn-primary"
                aria-expanded={panel?.target.kind === "new"}
                onClick={() => openPanel({ kind: "new" })}
              >
                <IconPlus size={16} />
                {msg.hosts.add}
              </button>
            </div>
          </div>

          {(total > 0 || groupList.length > 0) && (
            <div className="group-bar" role="navigation" aria-label={msg.hosts.groupsLabel} data-testid="group-bar">
              <button type="button" className="chip" aria-pressed={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
                {msg.hosts.allHosts}
              </button>
              {groupList.length > 0 && (
                <button type="button" className="chip" aria-pressed={filter.kind === "none"} onClick={() => setFilter({ kind: "none" })}>
                  {msg.hosts.ungrouped}
                </button>
              )}
              {tree.map(({ group, depth }) => (
                <span key={group.id} className="chip-group" style={{ marginInlineStart: depth > 0 ? 4 : 0 }}>
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={filter.kind === "group" && filter.id === group.id}
                    title={groupPath(groupList, group.id)}
                    onClick={() => setFilter({ kind: "group", id: group.id })}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setGroupMenu({ group, anchor: event.currentTarget });
                    }}
                  >
                    <IconFolder size={13} />
                    {depth > 0 ? `${"› ".repeat(Math.min(depth, 3))}${group.name}` : group.name}
                  </button>
                  <IconButton size="sm" label={msg.hosts.groupActions(group.name)} aria-haspopup="menu" onClick={(event) => setGroupMenu({ group, anchor: event.currentTarget })}>
                    <IconEllipsis size={14} />
                  </IconButton>
                </span>
              ))}
              <button type="button" className="chip chip-ghost" onClick={() => setEditingGroup({ group: null, parentId: currentGroupId })}>
                <IconFolderPlus size={13} />
                {msg.hosts.newGroup}
              </button>
            </div>
          )}

          {selectedIds.length > 0 && (
            <div className="bulk-bar" role="toolbar" aria-label={msg.hosts.selected(selectedIds.length)} data-testid="bulk-bar">
              <strong>{msg.hosts.selected(selectedIds.length)}</strong>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setConnectAll({ hosts: (hosts.value ?? []).filter((h) => selected.has(h.id)), groupName: null })}
              >
                <IconPlay size={13} />
                {msgD.inventory.connectSelected}
              </button>
              {groupList.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => setBulk("move")}>
                  <IconFolder size={13} />
                  {msg.hosts.moveTo}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => setSettingOs({ ids: selectedIds, initial: null })}>
                <IconServer size={13} />
                {msgD.inventory.setOs}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setBulk("add_tag")}>
                {msg.hosts.addTag}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setBulk("remove_tag")}>
                {msg.hosts.removeTag}
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setBulk("delete")}>
                <IconTrash2 size={13} />
                {msg.common.delete}
              </button>
              <span className="spacer" />
              <IconButton size="sm" label={msg.hosts.clearSelection} onClick={() => setSelected(new Set())}>
                <IconX size={14} />
              </IconButton>
            </div>
          )}

          {total > 0 && (
            <div className="toolbar">
              <input
                type="checkbox"
                className="select-all"
                aria-label={msgD.inventory.selectAll}
                title={msgD.inventory.selectAll}
                checked={filtered.length > 0 && shownSelected === filtered.length}
                ref={(el) => {
                  if (el) el.indeterminate = shownSelected > 0 && shownSelected < filtered.length;
                }}
                disabled={filtered.length === 0}
                onChange={toggleAllShown}
              />
              <div className="input-with-icon">
                <IconSearch size={15} />
                <input
                  className="input"
                  type="search"
                  placeholder={msg.common.search}
                  aria-label={msg.hosts.searchLabel}
                  title={msg.hosts.searchHelp}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <span className="spacer" />
              <Segmented<Sort>
                label={msg.hosts.sort}
                value={sort}
                onChange={setSort}
                options={[
                  { value: "name", label: msg.hosts.sortName },
                  { value: "recent", label: msg.hosts.sortRecent },
                  { value: "address", label: msgD.inventory.sortAddress },
                  { value: "group", label: msgD.inventory.sortGroup },
                ]}
              />
              <Segmented<Layout>
                label={msg.hosts.view}
                value={layout}
                onChange={setLayout}
                options={[
                  { value: "grid", label: msg.hosts.viewGrid, icon: <IconLayoutGrid size={14} /> },
                  { value: "list", label: msg.hosts.viewList, icon: <IconList size={14} /> },
                ]}
              />
            </div>
          )}

          <ErrorNotice error={hosts.error ?? remove.error ?? action.error} />

          {hosts.value === null && !hosts.error && <SkeletonRows count={4} height={64} />}

          {hosts.value && total === 0 && (
            <EmptyState icon={<IconServer size={28} />} title={msg.hosts.emptyTitle} body={msg.hosts.emptyBody}>
              <button type="button" className="btn btn-primary" onClick={() => openPanel({ kind: "new" })}>
                <IconPlus size={16} />
                {msg.hosts.add}
              </button>
            </EmptyState>
          )}

          {total > 0 && filtered.length === 0 && <p className="muted">{msg.hosts.noMatch}</p>}

          {layout === "grid" ? (
            <ul className="tile-grid host-grid" aria-label={msg.hosts.title} data-testid="host-list">
              {filtered.map((host) => {
                const isConnected = connected.has(host.id);
                return (
                  <li key={host.id}>
                    <article
                      className="host-card"
                      data-connected={isConnected}
                      data-active={panelHostId === host.id}
                      aria-label={host.label}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("button, input, a, select, label")) return;
                        openPanel({ kind: "edit", host });
                      }}
                      onDoubleClick={() => onConnect(host)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        actions(host, event.currentTarget);
                      }}
                    >
                      <input
                        type="checkbox"
                        className="host-select"
                        aria-label={msg.hosts.select(host.label)}
                        checked={selected.has(host.id)}
                        data-visible={selected.size > 0}
                        onClick={(event) => toggle(host.id, event)}
                        readOnly
                      />
                      {osOf.has(host.id) ? <OsIcon os={osOf.get(host.id) as HostOs} /> : <Avatar label={host.label} />}
                      <div className="host-card-main">
                        <span className="host-card-title">
                          <button
                            type="button"
                            className="host-open truncate"
                            aria-current={panelHostId === host.id ? true : undefined}
                            onClick={() => openPanel({ kind: "edit", host })}
                          >
                            {host.label}
                          </button>
                        </span>
                        <span className="host-card-dest truncate">{msg.hosts.destination(host.username, host.address, host.port)}</span>
                        {(host.groupId || host.tags.length > 0) && (
                          <span className="host-card-tags">
                            {host.groupId && (
                              <span className="tag tag-group">
                                <IconFolder size={11} />
                                {groupName(host.groupId)}
                              </span>
                            )}
                            {host.tags.map((tag) => (
                              <span key={tag} className="tag">
                                {tag}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      <div className="host-card-meta">
                        <div className="host-card-badges">
                        {identityOf(host.id) ? (
                          <span className="badge">
                            <IconUser size={12} />
                            {identityOf(host.id)}
                          </span>
                        ) : (
                          <AuthBadge host={host} keys={keyList} />
                        )}
                        {isConnected ? (
                          <span className="badge badge-success">
                            <span className="status-dot" data-tone="ok" aria-hidden="true" />
                            {msg.hosts.connectedNow}
                          </span>
                        ) : (
                          <span className="badge">
                            {host.lastConnectedAt ? msg.hosts.lastConnected(relativeTime(host.lastConnectedAt)) : msg.hosts.neverConnected}
                          </span>
                        )}
                        </div>
                        <button type="button" className="btn btn-primary btn-sm" aria-label={msg.hosts.connectTo(host.label)} onClick={() => onConnect(host)}>
                          <IconPlay size={13} />
                          {msg.hosts.connect}
                        </button>
                      </div>
                      <div className="host-card-actions">
                        <IconButton size="sm" label={msg.hosts.more(host.label)} aria-haspopup="menu" onClick={(event) => actions(host, event.currentTarget)}>
                          <IconEllipsis size={16} />
                        </IconButton>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="list" aria-label={msg.hosts.title} data-testid="host-list">
              {filtered.map((host) => (
                <li key={host.id} data-active={panelHostId === host.id}>
                  <input type="checkbox" aria-label={msg.hosts.select(host.label)} checked={selected.has(host.id)} onClick={(event) => toggle(host.id, event)} readOnly />
                  {osOf.has(host.id) ? <OsIcon os={osOf.get(host.id) as HostOs} /> : <Avatar label={host.label} />}
                  <div className="row-main">
                    <button
                      type="button"
                      className="host-open row-title"
                      aria-current={panelHostId === host.id ? true : undefined}
                      onClick={() => openPanel({ kind: "edit", host })}
                    >
                      {host.label}
                    </button>
                    <span className="row-sub">
                      {msg.hosts.destination(host.username, host.address, host.port)} · {identityOf(host.id) ?? authSummary(host, keyList)}
                      {host.groupId ? ` · ${groupName(host.groupId)}` : ""}
                      {host.tags.length > 0 ? ` · ${host.tags.join(", ")}` : ""}
                    </span>
                  </div>
                  {connected.has(host.id) && (
                    <span className="badge badge-success">
                      <span className="status-dot" data-tone="ok" aria-hidden="true" />
                      {msg.hosts.connectedNow}
                    </span>
                  )}
                  <div className="row-actions">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => onConnect(host)}>
                      <IconPlay size={13} />
                      {msg.hosts.connect}
                    </button>
                    <IconButton size="sm" label={msg.hosts.more(host.label)} aria-haspopup="menu" onClick={(event) => actions(host, event.currentTarget)}>
                      <IconEllipsis size={16} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {panel && (
        <HostPanel
          key={`${panelHostId ?? "new"}:${panel.version}`}
          target={panel.target}
          keys={keyList}
          groups={groupList}
          defaultGroupId={currentGroupId}
          os={panelHostId ? (osOf.get(panelHostId) ?? null) : null}
          identity={identityList ? { list: identityList, current: panelHostId ? (assignments.get(`host:${panelHostId}`)?.identityId ?? null) : null } : undefined}
          justSaved={panel.justSaved}
          dirtyRef={panelDirty}
          onRequestClose={() => guard(closePanel)}
          onCancel={closePanel}
          onSaved={(saved) => {
            show({ kind: "edit", host: saved }, true);
            reload();
          }}
          onConnect={onConnect}
          onDuplicate={(host) => void duplicate(host)}
          onCopyAddress={(host) => {
            // A user-initiated copy of non-secret data.
            void navigator.clipboard
              .writeText(host.address)
              .then(() => notify("success", msgD.hostPanel.addressCopied))
              .catch(() => undefined);
          }}
          onDelete={setDeleting}
          onEnvironment={(host) => setEnvironmentFor({ target: { kind: "host", hostId: host.id }, name: host.label })}
        />
      )}

      {menu && (
        <Menu
          label={msg.hosts.more(menu.host.label)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            { label: msg.hosts.connect, icon: <IconPlay size={15} />, onSelect: () => onConnect(menu.host) },
            { label: msg.common.edit, icon: <IconPencil size={15} />, onSelect: () => openPanel({ kind: "edit", host: menu.host }) },
            {
              label: msg.hosts.duplicate,
              icon: <IconCopy size={15} />,
              onSelect: () => void duplicate(menu.host),
            },
            {
              label: msgD.inventory.setOs,
              icon: <IconServer size={15} />,
              onSelect: () => setSettingOs({ ids: [menu.host.id], initial: osOf.get(menu.host.id) ?? null }),
            },
            "separator",
            {
              label: msgD.identities.assign,
              icon: <IconUser size={15} />,
              onSelect: () => setAssigning({ target: { kind: "host", hostId: menu.host.id }, name: menu.host.label }),
            },
            {
              label: msgD.env.menu,
              icon: <IconSlidersHorizontal size={15} />,
              onSelect: () => setEnvironmentFor({ target: { kind: "host", hostId: menu.host.id }, name: menu.host.label }),
            },
            { label: msg.common.delete, icon: <IconTrash2 size={15} />, tone: "danger", onSelect: () => setDeleting(menu.host) },
          ]}
        />
      )}

      {groupMenu && (
        <Menu
          label={msg.hosts.groupActions(groupMenu.group.name)}
          anchor={groupMenu.anchor}
          onClose={() => setGroupMenu(null)}
          items={[
            {
              label: msgD.inventory.connectGroup,
              icon: <IconPlay size={15} />,
              onSelect: () => setConnectAll({ hosts: hostsInGroup(groupMenu.group.id), groupName: groupPath(groupList, groupMenu.group.id) }),
            },
            { label: msg.common.edit, icon: <IconPencil size={15} />, onSelect: () => setEditingGroup({ group: groupMenu.group }) },
            {
              label: msg.hosts.newGroup,
              icon: <IconFolderPlus size={15} />,
              onSelect: () => setEditingGroup({ group: null, parentId: groupMenu.group.id }),
            },
            "separator",
            {
              label: msgD.identities.assign,
              icon: <IconUser size={15} />,
              onSelect: () => setAssigning({ target: { kind: "group", groupId: groupMenu.group.id }, name: groupMenu.group.name }),
            },
            {
              label: msgD.env.menu,
              icon: <IconSlidersHorizontal size={15} />,
              onSelect: () => setEnvironmentFor({ target: { kind: "group", groupId: groupMenu.group.id }, name: groupMenu.group.name }),
            },
            { label: msg.common.delete, icon: <IconTrash2 size={15} />, tone: "danger", onSelect: () => setDeletingGroup(groupMenu.group) },
          ]}
        />
      )}

      {editingGroup && (
        <GroupEditor
          group={editingGroup.group}
          parentId={editingGroup.parentId ?? null}
          groups={groupList}
          keys={keyList}
          onClose={() => setEditingGroup(null)}
          onSaved={(saved) => {
            setEditingGroup(null);
            setFilter({ kind: "group", id: saved.id });
            reload();
          }}
        />
      )}

      {deletingGroup && (
        <Dialog
          title={msg.hosts.deleteGroupTitle(deletingGroup.name)}
          role="alertdialog"
          icon={<IconTrash2 size={18} />}
          tone="danger"
          onDismiss={() => setDeletingGroup(null)}
        >
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.hosts.deleteGroupBody}
          </p>
          <ErrorNotice error={action.error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeletingGroup(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={action.pending}
              onClick={async () => {
                const target = deletingGroup;
                const done = await action.run(async () => {
                  await groupsApi.remove(target.id);
                  return true;
                });
                if (done) {
                  setDeletingGroup(null);
                  setFilter({ kind: "all" });
                  reload();
                }
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}

      {bulk && (
        <BulkDialog
          kind={bulk}
          count={selectedIds.length}
          groups={groupList}
          onClose={() => setBulk(null)}
          onApply={async (change) => {
            const changed = await action.run(() => hostsApi.bulk(selectedIds, change));
            setBulk(null);
            if (changed !== undefined && changed !== null) {
              notify("success", msg.hosts.bulkDone(changed));
              setSelected(new Set());
              reload();
            }
          }}
        />
      )}

      {connectAll && (
        <ConnectAllDialog
          hosts={connectAll.hosts}
          groupName={connectAll.groupName}
          free={free}
          onClose={() => setConnectAll(null)}
          onConfirm={(list) => {
            setConnectAll(null);
            notify("success", msgD.inventory.connectAllDone(list.length));
            for (const host of list) onConnect(host);
          }}
        />
      )}

      {environmentFor && (
        <EnvironmentDialog
          target={environmentFor.target}
          name={environmentFor.name}
          onClose={() => setEnvironmentFor(null)}
          onDone={() => {
            setEnvironmentFor(null);
            notify("success", msgD.env.saved);
          }}
        />
      )}

      {assigning && (
        <AssignIdentityDialog
          target={assigning.target}
          name={assigning.name}
          current={assignments.get(assigning.target.kind === "host" ? `host:${assigning.target.hostId}` : `group:${assigning.target.groupId}`) ?? null}
          list={identityList ?? []}
          onClose={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null);
            notify("success", msgD.identities.assigned);
            identityEvents.changed();
          }}
        />
      )}

      {settingOs && (
        <SetOsDialog
          count={settingOs.ids.length}
          initial={settingOs.initial}
          onClose={() => setSettingOs(null)}
          onApply={async (os) => {
            const ids = settingOs.ids;
            setSettingOs(null);
            const changed = await action.run(() => appearanceApi.setOs(ids, os));
            if (changed !== undefined && changed !== null) {
              notify("success", msgD.inventory.osChanged(ids.length));
              reload();
            }
          }}
        />
      )}

      {importing && (
        <ImportDialog
          groups={groupList}
          intoGroup={currentGroupId}
          onClose={() => setImporting(false)}
          onImported={(count) => {
            setImporting(false);
            notify("success", msg.hosts.importDone(count));
            reload();
          }}
          onTrusted={(count) => {
            setImporting(false);
            notify("success", msgD.import.trustDone(count));
          }}
        />
      )}

      {deleting && (
        <Dialog title={msg.hosts.deleteTitle(deleting.label)} role="alertdialog" icon={<IconTrash2 size={18} />} tone="danger" onDismiss={() => setDeleting(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.hosts.deleteBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={remove.pending}
              onClick={async () => {
                const target = deleting;
                setDeleting(null);
                const done = await remove.run(async () => {
                  await hostsApi.remove(target.id);
                  return true;
                });
                if (done && panelHostId === target.id) {
                  opener.current = null;
                  closePanel();
                }
                reload();
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}

      {discarding && (
        <Dialog
          title={msgD.hostPanel.discardTitle(panel?.target.kind === "edit" ? panel.target.host.label : msgD.hostPanel.newTitle)}
          role="alertdialog"
          icon={<IconTrash2 size={18} />}
          tone="warning"
          onDismiss={() => setDiscarding(null)}
        >
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msgD.hostPanel.discardBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDiscarding(null)} autoFocus data-autofocus>
              {msgD.hostPanel.keepEditing}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const then = discarding;
                setDiscarding(null);
                panelDirty.current = false;
                then();
              }}
            >
              {msgD.hostPanel.discard}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Below this width the list and the Host details panel do not fit side by side. */
const NARROW_WIDTH = 760;

/** Confirms one bulk change: the target group, the tag, or the deletion. */
function BulkDialog({
  kind,
  count,
  groups,
  onClose,
  onApply,
}: {
  kind: "move" | "add_tag" | "remove_tag" | "delete";
  count: number;
  groups: GroupSummary[];
  onClose: () => void;
  onApply: (change: BulkHostChange) => void;
}) {
  const [group, setGroup] = useState("");
  const [tag, setTag] = useState("");
  const title =
    kind === "move" ? msg.hosts.moveTo : kind === "add_tag" ? msg.hosts.addTag : kind === "remove_tag" ? msg.hosts.removeTag : msg.hosts.bulkDeleteTitle(count);
  const ready = kind === "delete" || kind === "move" || tag.trim() !== "";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    if (kind === "move") onApply({ kind: "move_to_group", groupId: group || null });
    else if (kind === "add_tag") onApply({ kind: "add_tag", tag: tag.trim() });
    else if (kind === "remove_tag") onApply({ kind: "remove_tag", tag: tag.trim() });
    else onApply({ kind: "delete" });
  }
  return (
    <Dialog
      title={title}
      {...(kind === "delete" ? { role: "alertdialog" as const, tone: "danger" as const } : {})}
      icon={kind === "delete" ? <IconTrash2 size={18} /> : <IconFolder size={18} />}
      onDismiss={onClose}
    >
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.hosts.selected(count)}
          {kind === "delete" ? `. ${msg.hosts.deleteBody}` : ""}
        </p>
        {kind === "move" && (
          <label className="field">
            <span className="label">{msg.hosts.group}</span>
            <select className="select" value={group} onChange={(event) => setGroup(event.target.value)} data-autofocus>
              <option value="">{msg.hosts.noGroup}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {groupPath(groups, g.id)}
                </option>
              ))}
            </select>
          </label>
        )}
        {(kind === "add_tag" || kind === "remove_tag") && <TextField label={msg.hosts.tagName} value={tag} onChange={setTag} autoFocus maxLength={32} />}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} autoFocus={kind === "delete"} data-autofocus={kind === "delete" || undefined}>
            {msg.common.cancel}
          </button>
          <button type="submit" className={kind === "delete" ? "btn btn-danger-solid" : "btn btn-primary"} disabled={!ready}>
            {kind === "delete" ? msg.common.delete : msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

import type {
  QuickConnectInput,
  BulkHostChange,
  GroupSummary,
  HostOs,
  HostSummary,
  HostsFilter,
  HostsLayout,
  HostsSort,
  HostsViewPreferences,
  IdentityAssignment,
  KeySummary,
  SettingsTarget,
} from "@tyrminal/contracts";
import { type FormEvent, type KeyboardEvent, type MouseEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { useVaultData } from "../../app/vaultData";
import { MAX_PANES, type Workspace, paneCount, panesOf } from "../../app/workspace";
import { Dialog } from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { Avatar, EmptyState, ErrorNotice, IconButton, Segmented, SkeletonRows, TextField, relativeTime } from "../../components/ui/controls";
import {
  IconArrowLeftRight,
  IconColumns2,
  IconCopy,
  IconEllipsis,
  IconFolder,
  IconFolderPlus,
  IconKeyRound,
  IconLayoutGrid,
  IconList,
  IconLock,
  IconNetwork,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconSlidersHorizontal,
  IconStar,
  IconTextCursorInput,
  IconTrash2,
  IconUpload,
  IconUser,
  IconX,
} from "../../components/ui/icons";
import { msgSftp } from "../sftp/messages";
import { type AppError, appearance as appearanceApi, groups as groupsApi, hosts as hostsApi, identities as identitiesApi, toAppError } from "../../lib/ipc";
import { msgC } from "../../lib/messages-c";
import { msg } from "../../lib/messages";
import { type Unsaved, discardWording, msgAutosave } from "../../lib/messages-autosave";
import { msgD } from "../../lib/messages-d";
import { msgDiscovery } from "../../lib/messages-discovery";
import { msgProduction } from "../../lib/messages-production";
import { flashSaved, useFlip } from "../../lib/motion";
import { msgSelect } from "../../lib/messages-select";
import { isMac } from "../../lib/platform";
import { type OpenLayout } from "../../app/multiOpen";
import { useAction } from "../../lib/useAsync";
import { DiscoveryDialog } from "./DiscoveryDialog";
import { GroupEditor, descendantsOf } from "./GroupEditor";
import { HostPanel, type PanelTarget } from "./HostPanel";
import { groupPath } from "./hostForm";
import { ImportDialog } from "./ImportDialog";
import { ConnectAllDialog, SetOsDialog } from "./InventoryDialogs";
import { OsIcon } from "./OsIcon";
import { MAX_LOCATIONS } from "../sftp/SftpPane";
import { useIsProduction } from "./production";
import { identityEvents, useIdentities } from "../credentials/IdentitiesSection";
import { AssignIdentityDialog } from "./AssignIdentityDialog";
import { EnvironmentDialog } from "./EnvironmentDialog";
// quick connect
import { msgQuick } from "../../lib/messages-quick";
import { parseAddress } from "../../lib/quickConnect";
import { QuickConnectDialog } from "./QuickConnectDialog";

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

/** How Hosts is shown until the user changes it; the choice is kept in preferences. */
const DEFAULT_VIEW: HostsViewPreferences = { layout: "list", sort: "name", filter: { kind: "all" } };

/** What an optimistic bulk change looks like before the vault answers (the reload brings the exact result). */
function applyBulkChange(host: HostSummary, change: Exclude<BulkHostChange, { kind: "delete" }>): HostSummary {
  if (change.kind === "move_to_group") return { ...host, groupId: change.groupId };
  if (change.kind === "add_tag") return { ...host, tags: [...new Set([...host.tags, change.tag])].sort() };
  return { ...host, tags: host.tags.filter((t) => t.toLowerCase() !== change.tag.toLowerCase()) };
}

/** Hosts this view can mark: a checkbox click with Shift selects the range since the last click. */
function rangeBetween(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** How long after a click a second one still makes a double-click (the common system default). */
const DOUBLE_CLICK_MS = 300;

/** Times a host is connected from Hosts by double-click or Enter before the hint stops showing. */
const HINT_UNTIL = 3;

/**
 * Connections made from Hosts by double-click or Enter in this run of the app. Kept in memory only:
 * app code never uses browser storage (scripts/check-release.mjs), so the hint shows again for the
 * first few connections after each start.
 */
let hintUses = 0;

/** The "Double-click to connect" hint on host names, for the first few connections from Hosts. */
function useDoubleClickHint() {
  const [count, setCount] = useState(hintUses);
  return {
    show: count < HINT_UNTIL,
    used: () => {
      hintUses += 1;
      setCount(hintUses);
    },
  };
}

/** Ctrl on Windows and Linux, Cmd on macOS: the "add to the selection" modifier. */
const toggleKey = (event: { ctrlKey: boolean; metaKey: boolean }) => (isMac ? event.metaKey : event.ctrlKey);

function HostsViewImpl({
  ws,
  onConnect,
  onQuickConnect,
  onConnectMany,
  onConnectSplit,
  onOpenSftp,
  onOpenSftpMany,
}: {
  ws: Workspace;
  onConnect: (host: HostSummary) => void;
  /** Quick connect: an address typed in the search that matches no host (nothing is saved). */
  onQuickConnect?: (input: QuickConnectInput) => void;
  /** Several hosts at once, one tab each or one split tab; each still asks for trust and sign-in. */
  onConnectMany?: (hosts: HostSummary[], layout: OpenLayout) => void;
  /** Connect in split: beside the focused pane of the terminal tab in front. */
  onConnectSplit?: (host: HostSummary) => void;
  /** Open in SFTP: the host in an SFTP tab (SSH hosts). */
  onOpenSftp?: (host: HostSummary) => void;
  /** Open in SFTP for a selection: one SFTP tab, each host a location of it. */
  onOpenSftpMany?: (hosts: HostSummary[]) => void;
}) {
  const { hosts, keys, recent, groups } = useVaultData();
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef);
  const notify = useToast();
  const isProduction = useIsProduction();
  const [query, setQuery] = useState("");
  // quick connect: the address the sheet is open for.
  const [quick, setQuick] = useState<{ username: string; address: string; port: number | null } | null>(null);
  const [searched, setSearched] = useState<{ query: string; ids: Set<string> } | null>(null);
  // Layout, sort and group filter live in preferences, so they survive other views and restarts.
  const { prefs, update } = usePreferences();
  const view = prefs.hostsView ?? DEFAULT_VIEW;
  const { layout, sort } = view;
  const setView = useCallback(
    (change: Partial<HostsViewPreferences>) => update((p) => ({ ...p, hostsView: { ...(p.hostsView ?? DEFAULT_VIEW), ...change } })),
    [update],
  );
  const setLayout = (next: HostsLayout) => setView({ layout: next });
  const setSort = (next: HostsSort) => setView({ sort: next });
  const setFilter = (next: HostsFilter) => setView({ filter: next });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Host details panel: what it shows, a counter that rebuilds it for another host, and the guard
  // state (what is not autosaved: a password typed but not set, note edits).
  const [panel, setPanel] = useState<{ target: PanelTarget; version: number; takeFocus: boolean } | null>(null);
  const [discarding, setDiscarding] = useState<{ then: () => void; wording: NonNullable<ReturnType<typeof discardWording>> } | null>(null);
  const panelUnsaved = useRef<Unsaved>({ password: false, note: false });
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Selection is shown by the row tint and edge; assistive technology hears "Selected" after the name.
  const selectedNoteId = useId();
  const hint = useDoubleClickHint();
  const [narrow, setNarrow] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState<HostSummary | null>(null);
  const [menu, setMenu] = useState<{ host: HostSummary; anchor: HTMLElement } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ group: GroupSummary; anchor: HTMLElement } | null>(null);
  const [editingGroup, setEditingGroup] = useState<{ group: GroupSummary | null; parentId?: string | null } | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<GroupSummary | null>(null);
  const [bulk, setBulk] = useState<"move" | "add_tag" | "remove_tag" | "delete" | null>(null);
  const [importing, setImporting] = useState(false);
  const [osOf, setOsOf] = useState<Map<string, HostOs>>(new Map());
  // Hosts whose icon comes from a group default (HST-05) rather than their own setting.
  const [osInherited, setOsInherited] = useState<Set<string>>(new Set());
  const [settingOs, setSettingOs] = useState<{ ids: string[]; initial: HostOs | null } | null>(null);
  const [connectAll, setConnectAll] = useState<{ hosts: HostSummary[]; groupName: string | null; layout?: OpenLayout } | null>(null);
  // Identities (KEY-17): which one every host and group uses.
  const identityList = useIdentities();
  const [assignments, setAssignments] = useState<Map<string, IdentityAssignment>>(new Map());
  const [assigning, setAssigning] = useState<{ target: SettingsTarget; name: string } | null>(null);
  const [environmentFor, setEnvironmentFor] = useState<{ target: SettingsTarget; name: string } | null>(null);
  const anchor = useRef<string | null>(null);
  const version = useRef(0);
  const remove = useAction();
  const action = useAction();
  // Optimistic edits: hosts whose change is still being saved, and the error of one that failed.
  const [pendingIds, setPending] = useState<ReadonlySet<string>>(new Set());
  const [editError, setEditError] = useState<AppError | null>(null);
  const keyList = keys.value ?? [];
  const groupList = groups.value ?? [];
  // A remembered group that no longer exists shows every host.
  const savedFilter = view.filter;
  const filter: HostsFilter =
    savedFilter.kind === "group" && groups.value && !groups.value.some((g) => g.id === savedFilter.id) ? { kind: "all" } : savedFilter;
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
        if (!live) return;
        setOsOf(new Map(list.map((a) => [a.hostId, a.os])));
        setOsInherited(new Set(list.filter((a) => a.inherited).map((a) => a.hostId)));
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
  // quick connect: offered once the search for this exact text found no host.
  const quickTarget = query.trim() && searched?.query === query.trim() && filtered.length === 0 ? parseAddress(query) : null;
  /**
   * A local, reversible edit (move to a group, add or remove a tag) shows at once; the vault call
   * runs behind it. On failure the hosts go back to exactly what they were, the selection comes
   * back for a retry, and an inline error says so. Never used for deletes, connecting, trust or
   * secrets.
   */
  async function applyOptimistic(ids: string[], change: Exclude<BulkHostChange, { kind: "delete" }>) {
    const chosen = new Set(ids);
    const before = new Map((hosts.value ?? []).filter((h) => chosen.has(h.id)).map((h) => [h.id, h]));
    setEditError(null);
    hosts.mutate((list) => list.map((h) => (chosen.has(h.id) ? applyBulkChange(h, change) : h)));
    setPending((current) => new Set([...current, ...ids]));
    setSelected(new Set());
    try {
      const changed = await hostsApi.bulk(ids, change);
      notify("success", msg.hosts.bulkDone(changed));
      reload();
    } catch (error) {
      hosts.mutate((list) => list.map((h) => before.get(h.id) ?? h));
      setSelected(new Set(ids));
      setEditError({ ...toAppError(error), message: `${msgC.optimistic.reverted(ids.length)} ${toAppError(error).message}` });
    } finally {
      setPending((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }

  const reload = () => {
    void hosts.reload();
    void recent.reload();
    void keys.reload();
    void groups.reload();
  };
  const selectedIds = [...selected].filter((id) => hosts.value?.some((h) => h.id === id));
  // Finder-style selection on the rows themselves: the row tint and accent edge show it.
  // The selection a plain click just replaced, when the clicked host was part of it: the first
  // click of a double-click must not shrink what the double-click opens.
  const replaced = useRef<{ id: string; ids: Set<string> } | null>(null);
  const shownIds = filtered.map((h) => h.id);
  const selectWith = (id: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const additive = toggleKey(event);
    const from = anchor.current;
    if (event.shiftKey && from && shownIds.includes(from)) {
      const range = rangeBetween(shownIds, from, id);
      setSelected((current) => new Set(additive ? [...current, ...range] : range));
    } else if (additive) {
      anchor.current = id;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      replaced.current = selected.has(id) && selected.size > 1 ? { id, ids: new Set(selected) } : null;
      anchor.current = id;
      setSelected(new Set([id]));
    }
  };
  // Opening the details panel narrows the list and can move the rows; when it is not open yet it
  // opens once a double-click is no longer possible, so the second click lands on the same host.
  const pendingPanel = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pendingPanel.current), []);
  const rowClick = (host: HostSummary, event: MouseEvent) => {
    // The second click of a double-click: the double-click handler decides.
    if (event.detail > 1) return;
    selectWith(host.id, event);
    if (event.shiftKey || toggleKey(event)) return;
    window.clearTimeout(pendingPanel.current);
    if (panel) openPanel({ kind: "edit", host });
    else pendingPanel.current = window.setTimeout(() => openPanel({ kind: "edit", host }), DOUBLE_CLICK_MS);
  };
  const selectedHosts = filtered.filter((h) => selected.has(h.id));
  // Open in SFTP for a selection: each SSH host becomes a location of the SFTP tab (at most
  // MAX_LOCATIONS; each still asks for its own trust and sign-in).
  const sftpSelection = selectedHosts.filter((h) => h.protocol.type === "ssh");
  const openSelectionInSftp =
    onOpenSftpMany && sftpSelection.length > 0 && sftpSelection.length <= MAX_LOCATIONS ? () => onOpenSftpMany(sftpSelection) : undefined;
  /**
   * Double-click or Enter (Cmd/Ctrl+Enter: in a split; Shift+Enter: in SFTP): the whole selection
   * when the host is part of one, else that host. Several hosts are reviewed first.
   */
  const connectFrom = (host: HostSummary, how: "connect" | "split" | "sftp" = "connect", fromDoubleClick = false) => {
    window.clearTimeout(pendingPanel.current);
    const before = fromDoubleClick && replaced.current?.id === host.id ? replaced.current.ids : null;
    const ids = before ?? selected;
    const chosen = filtered.filter((h) => ids.has(h.id));
    if (before) {
      setSelected(new Set(before));
    }
    replaced.current = null;
    const many = ids.has(host.id) && chosen.length > 1;
    if (how === "sftp") {
      if (many) openSelectionInSftp?.();
      else if (host.protocol.type === "ssh") onOpenSftp?.(host);
      return;
    }
    hint.used();
    if (many) setConnectAll({ hosts: chosen, groupName: null, layout: how === "split" ? "split" : "tabs" });
    else if (how === "split" && onConnectSplit) onConnectSplit(host);
    else onConnect(host);
  };
  const focusHost = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-host-id="${CSS.escape(id)}"] .host-open`)?.focus();
  /** Hosts per row in the card grid (1 in the list), from where the cards are laid out. */
  const perRow = () => {
    const items = [...(listRef.current?.children ?? [])] as HTMLElement[];
    const top = items[0]?.offsetTop;
    const n = items.filter((el) => el.offsetTop === top).length;
    return layout === "grid" ? Math.max(1, n) : 1;
  };
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input:not([type=checkbox]), textarea, select")) return;
    const current = target.closest<HTMLElement>("[data-host-id]")?.dataset.hostId ?? null;
    // Working in the list from the keyboard: a click's details panel that has not opened yet stays closed.
    window.clearTimeout(pendingPanel.current);
    if (toggleKey(event) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(shownIds));
      return;
    }
    if (event.key === "Escape" && selected.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      setSelected(new Set());
      return;
    }
    if (!current) return;
    // Home and End jump to the ends; the arrows move by one host (a row of cards up and down).
    const steps: Record<string, number> = { ArrowDown: perRow(), ArrowUp: -perRow(), ArrowRight: 1, ArrowLeft: -1, Home: -shownIds.length, End: shownIds.length };
    const step = steps[event.key];
    if (step !== undefined) {
      if (layout === "list" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) return;
      event.preventDefault();
      const index = shownIds.indexOf(current);
      const nextId = shownIds[Math.min(shownIds.length - 1, Math.max(0, index + step))];
      if (!nextId) return;
      if (toggleKey(event) && !event.shiftKey) {
        // Cmd/Ctrl+arrow moves without changing the selection (Space then adds or removes).
      } else if (event.shiftKey) {
        anchor.current ??= current;
        const range = rangeBetween(shownIds, anchor.current, nextId);
        setSelected(new Set(range));
      } else {
        anchor.current = nextId;
        setSelected(new Set([nextId]));
        // Host details follow the selection (edits there are saved as they are made).
        const host = filtered.find((h) => h.id === nextId);
        if (host) openPanel({ kind: "edit", host }, { takeFocus: false });
      }
      focusHost(nextId);
      return;
    }
    const host = filtered.find((h) => h.id === current);
    // Enter, Space and typing act on the host name; other controls in the row keep their keys.
    if (!host || !target.classList.contains("host-open")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      connectFrom(host, toggleKey(event) ? "split" : event.shiftKey ? "sftp" : "connect");
      return;
    }
    // Space adds the host to the selection or takes it out, like Cmd/Ctrl-click.
    if (event.key === " " && !event.altKey && !toggleKey(event)) {
      event.preventDefault();
      selectWith(host.id, { shiftKey: event.shiftKey, ctrlKey: !isMac, metaKey: isMac });
      return;
    }
    // Typing a character filters: it goes to the search field.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      event.preventDefault();
      setQuery((q) => q + event.key);
      searchRef.current?.focus();
    }
  };
  /** The selection strip shows from two selected hosts on. */
  const bulkCount = selectedIds.length >= 2 ? selectedIds.length : 0;
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

  async function favourite(host: HostSummary) {
    const saved = await action.run(() => hostsApi.setFavourite(host.id, !host.favourite));
    if (!saved) return;
    // The open panel shows the same host: keep its copy current.
    setPanel((current) =>
      current && current.target.kind === "edit" && current.target.host.id === saved.id ? { ...current, target: { kind: "edit", host: saved } } : current,
    );
    reload();
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

  /** Runs `then` now, or after the user agrees to discard what the panel has not saved (a typed password, note edits). */
  const guard = (then: () => void) => {
    const wording = panel ? discardWording(panelUnsaved.current) : null;
    if (wording) setDiscarding({ then, wording });
    else then();
  };
  const show = (target: PanelTarget, takeFocus: boolean) => {
    version.current += 1;
    panelUnsaved.current = { password: false, note: false };
    setPanel({ target, version: version.current, takeFocus });
  };
  const openPanel = (target: PanelTarget, { takeFocus = true } = {}) => {
    if (target.kind === "edit" && panel?.target.kind === "edit" && panel.target.host.id === target.host.id) return;
    // Remember what opened the panel (the latest host name or button outside it) to return focus there.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest(".host-panel")) opener.current = active;
    guard(() => show(target, takeFocus));
  };
  /** Closes the panel and puts focus back where it was opened from (or on "Add host"). */
  const closePanel = useCallback(() => {
    const back = opener.current;
    opener.current = null;
    panelUnsaved.current = { password: false, note: false };
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
              <button type="button" className="btn" onClick={() => setDiscovering(true)}>
                <IconNetwork size={15} />
                {msgDiscovery.open}
              </button>
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

          {total > 0 && (
            <div className="toolbar">
              <div className="input-with-icon">
                <IconSearch size={15} />
                <input
                  className="input"
                  type="search"
                  placeholder={msg.common.search}
                  aria-label={msg.hosts.searchLabel}
                  title={msg.hosts.searchHelp}
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // quick connect: Enter on an address that matches no host.
                    if (event.key === "Enter" && quickTarget && onQuickConnect) {
                      event.preventDefault();
                      setQuick(quickTarget);
                    }
                  }}
                />
              </div>
              <span className="spacer" />
              <Segmented<HostsSort>
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
              <Segmented<HostsLayout>
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
          <ErrorNotice error={editError} />

          {hosts.value === null && !hosts.error && <SkeletonRows count={4} height={64} />}

          {hosts.value && total === 0 && (
            <EmptyState icon={<IconServer size={28} />} title={msg.hosts.emptyTitle} body={msg.hosts.emptyBody}>
              <button type="button" className="btn btn-primary" onClick={() => openPanel({ kind: "new" })}>
                <IconPlus size={16} />
                {msg.hosts.add}
              </button>
            </EmptyState>
          )}

          {total > 0 && filtered.length === 0 && (
            <p className="muted">
              {msg.hosts.noMatch}
              {quickTarget && onQuickConnect && (
                <>
                  {" "}
                  <button type="button" className="btn btn-sm" onClick={() => setQuick(quickTarget)}>
                    {msgQuick.option(query.trim())}
                  </button>
                </>
              )}
            </p>
          )}
          {quick && onQuickConnect && (
            <QuickConnectDialog
              address={quick.address}
              initialUser={quick.username}
              initialPort={quick.port}
              onConnect={(input) => {
                setQuick(null);
                setQuery("");
                onQuickConnect(input);
              }}
              onConnectSaved={(host) => {
                setQuick(null);
                setQuery("");
                onConnect(host);
              }}
              onClose={() => setQuick(null)}
            />
          )}

          {bulkCount > 0 && (
            <div className="bulk-bar box-strip" role="toolbar" aria-label={msg.hosts.selected(selectedIds.length)} data-testid="bulk-bar">
              <strong>{msg.hosts.selected(selectedIds.length)}</strong>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setConnectAll({ hosts: (hosts.value ?? []).filter((h) => selected.has(h.id)), groupName: null })}
              >
                <IconPlay size={13} />
                {msgSelect.connectN(selectedIds.length)}
              </button>
              {openSelectionInSftp && (
                <button type="button" className="btn btn-sm" onClick={openSelectionInSftp}>
                  <IconArrowLeftRight size={13} />
                  {msgSelect.openInSftp(sftpSelection.length)}
                </button>
              )}
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
              <button type="button" className="btn btn-sm btn-ghost" aria-label={msg.hosts.clearSelection} onClick={() => setSelected(new Set())}>
                <IconX size={13} />
                {msgSelect.clear}
              </button>
            </div>
          )}

          <span id={selectedNoteId} className="visually-hidden">
            {msgSelect.selectedNote}
          </span>
          {layout === "grid" ? (
            <ul className="tile-grid host-grid" aria-label={msg.hosts.title} data-testid="host-list" ref={listRef} onKeyDown={onListKey}>
              {filtered.map((host) => {
                const isConnected = connected.has(host.id);
                return (
                  <li key={host.id} data-flip-key={host.id}>
                    <article
                      className="host-card"
                      data-connected={isConnected}
                      data-active={panelHostId === host.id}
                      data-pending={pendingIds.has(host.id) || undefined}
                      data-selected={selected.has(host.id) || undefined}
                      data-host-id={host.id}
                      aria-label={host.label}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("button, input, a, select, label")) return;
                        rowClick(host, event);
                      }}
                      onDoubleClick={(event) => {
                        if ((event.target as HTMLElement).closest("input, .btn, .icon-button")) return;
                        connectFrom(host, "connect", true);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        actions(host, event.currentTarget);
                      }}
                    >
                      {osOf.has(host.id) ? <OsIcon os={osOf.get(host.id) as HostOs} /> : <Avatar label={host.label} />}
                      <div className="host-card-main">
                        <span className="host-card-title">
                          <button
                            type="button"
                            className="host-open truncate"
                            aria-current={panelHostId === host.id ? true : undefined}
                            data-tooltip={hint.show ? msgSelect.doubleClickHint : undefined}
                            aria-describedby={selected.has(host.id) ? selectedNoteId : undefined}
                            onClick={(event) => {
                              event.stopPropagation();
                              rowClick(host, event);
                            }}
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
                        {isProduction(host) && <span className="badge badge-production">{msgProduction.label}</span>}
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
            <ul className="list" aria-label={msg.hosts.title} data-testid="host-list" ref={listRef} onKeyDown={onListKey}>
              {filtered.map((host) => (
                <li
                  key={host.id}
                  data-flip-key={host.id}
                  data-active={panelHostId === host.id}
                  data-pending={pendingIds.has(host.id) || undefined}
                  data-selected={selected.has(host.id) || undefined}
                  data-host-id={host.id}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, input, a, select, label")) return;
                    rowClick(host, event);
                  }}
                  onDoubleClick={(event) => {
                    if ((event.target as HTMLElement).closest("input, .btn, .icon-button")) return;
                    connectFrom(host, "connect", true);
                  }}
                >
                  {osOf.has(host.id) ? <OsIcon os={osOf.get(host.id) as HostOs} /> : <Avatar label={host.label} />}
                  <div className="row-main">
                    <button
                      type="button"
                      className="host-open row-title"
                      aria-current={panelHostId === host.id ? true : undefined}
                      data-tooltip={hint.show ? msgSelect.doubleClickHint : undefined}
                      aria-describedby={selected.has(host.id) ? selectedNoteId : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        rowClick(host, event);
                      }}
                    >
                      {host.label}
                    </button>
                    <span className="row-sub">
                      {msg.hosts.destination(host.username, host.address, host.port)} · {identityOf(host.id) ?? authSummary(host, keyList)}
                      {host.groupId ? ` · ${groupName(host.groupId)}` : ""}
                      {host.tags.length > 0 ? ` · ${host.tags.join(", ")}` : ""}
                    </span>
                  </div>
                  {isProduction(host) && <span className="badge badge-production">{msgProduction.label}</span>}
                  {connected.has(host.id) && (
                    <span className="badge badge-success">
                      <span className="status-dot" data-tone="ok" aria-hidden="true" />
                      {msg.hosts.connectedNow}
                    </span>
                  )}
                  <div className="row-actions">
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
          // Not keyed by the host: creating the host on its first save keeps the same panel.
          key={panel.version}
          target={panel.target}
          takeFocus={panel.takeFocus}
          keys={keyList}
          groups={groupList}
          defaultGroupId={currentGroupId}
          os={panelHostId ? (osOf.get(panelHostId) ?? null) : null}
          identity={identityList ? { list: identityList, current: panelHostId ? (assignments.get(`host:${panelHostId}`)?.identityId ?? null) : null } : undefined}
          unsavedRef={panelUnsaved}
          onRequestClose={() => guard(closePanel)}
          onSaved={(saved) => {
            // Only the panel that saved: a write that finishes after switching hosts updates the list only.
            const mine = panel.version;
            setPanel((current) => (current && current.version === mine ? { ...current, target: { kind: "edit", host: saved } } : current));
            reload();
            // The saved row tints once, so the change is seen in the list as well as the panel.
            requestAnimationFrame(() => flashSaved(listRef.current?.querySelector<HTMLElement>(`[data-flip-key="${CSS.escape(saved.id)}"]`)));
          }}
          onConnect={(host) => guard(() => onConnect(host))}
          onOpenSftp={onOpenSftp}
          onDuplicate={(host) => void duplicate(host)}
          onFavourite={(host) => void favourite(host)}
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
            // On a host of a multi-selection the menu acts on the whole selection first.
            ...(selected.has(menu.host.id) && selectedHosts.length > 1
              ? [
                  {
                    label: msgSelect.connectN(selectedHosts.length),
                    icon: <IconPlay size={15} />,
                    onSelect: () => setConnectAll({ hosts: selectedHosts, groupName: null }),
                  },
                  ...(openSelectionInSftp ? [{ label: msgSelect.openInSftp(sftpSelection.length), icon: <IconArrowLeftRight size={15} />, onSelect: openSelectionInSftp }] : []),
                  "separator" as const,
                ]
              : []),
            { label: msg.hosts.connect, icon: <IconPlay size={15} />, onSelect: () => onConnect(menu.host) },
            ...(onConnectSplit ? [{ label: msgSelect.connectInSplit, icon: <IconColumns2 size={15} />, onSelect: () => onConnectSplit(menu.host) }] : []),
            ...(onOpenSftp && menu.host.protocol.type === "ssh"
              ? [{ label: msgSftp.openIn, icon: <IconArrowLeftRight size={15} />, onSelect: () => onOpenSftp(menu.host) }]
              : []),
            { label: msg.common.edit, icon: <IconPencil size={15} />, onSelect: () => openPanel({ kind: "edit", host: menu.host }) },
            {
              label: menu.host.favourite ? msg.hosts.unfavourite : msg.hosts.favourite,
              icon: <IconStar size={15} fill={menu.host.favourite ? "currentColor" : "none"} />,
              onSelect: () => void favourite(menu.host),
            },
            {
              label: msg.hosts.duplicate,
              icon: <IconCopy size={15} />,
              onSelect: () => void duplicate(menu.host),
            },
            {
              label: msgD.inventory.setOs,
              icon: <IconServer size={15} />,
              onSelect: () => setSettingOs({ ids: [menu.host.id], initial: osInherited.has(menu.host.id) ? null : (osOf.get(menu.host.id) ?? null) }),
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
          onClose={(created) => {
            setEditingGroup(null);
            // A group created here opens once the editor closes.
            if (created) setFilter({ kind: "group", id: created.id });
          }}
          onSaved={() => reload()}
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
            if (change.kind !== "delete") {
              setBulk(null);
              await applyOptimistic(selectedIds, change);
              return;
            }
            // Deleting is never optimistic: the hosts stay until the vault confirms.
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
          initialLayout={connectAll.layout ?? "tabs"}
          onClose={() => setConnectAll(null)}
          onConfirm={(list, layout) => {
            setConnectAll(null);
            notify("success", msgD.inventory.connectAllDone(list.length));
            if (onConnectMany) onConnectMany(list, layout);
            else for (const host of list) onConnect(host);
          }}
        />
      )}

      {environmentFor && (
        <EnvironmentDialog
          target={environmentFor.target}
          name={environmentFor.name}
          onClose={() => setEnvironmentFor(null)}
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

      {discovering && (
        <DiscoveryDialog
          onClose={() => setDiscovering(false)}
          onAdd={(service) => {
            setDiscovering(false);
            // The panel shows the announced values for review; the host is saved on the first edit (or Connect).
            openPanel({
              kind: "new",
              initial: { label: service.name, address: service.addresses[0] ?? service.host, port: service.port, username: "" },
            });
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
          title={discarding.wording.title}
          role="alertdialog"
          icon={<IconTrash2 size={18} />}
          tone="warning"
          onDismiss={() => setDiscarding(null)}
        >
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {discarding.wording.body}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDiscarding(null)} autoFocus data-autofocus>
              {msgAutosave.keepEditing}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const { then } = discarding;
                setDiscarding(null);
                panelUnsaved.current = { password: false, note: false };
                then();
              }}
            >
              {discarding.wording.action}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Memoized: re-renders only when its own props change, not for every state change of the shell. */
export const HostsView = memo(HostsViewImpl);

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

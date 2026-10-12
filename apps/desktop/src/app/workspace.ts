// Tabs and split panes as plain data. Each pane owns one terminal session; the layout is a binary
// tree of splits. Panes are rendered flat and positioned from `paneRects`, so changing the tree
// never remounts a terminal (its session survives splits, closes and moves).

import type { DetachTabInput, LayoutNode, LayoutTab, LayoutTarget } from "@tyrminal/contracts";

import type { TerminalTarget } from "../features/terminal/TerminalController";

export const MAX_PANES = 16;

export type Direction = "row" | "column";

export type Layout =
  | { kind: "leaf"; pane: number }
  | { kind: "split"; dir: Direction; ratio: number; a: Layout; b: Layout };

export interface Pane {
  id: number;
  target: TerminalTarget;
  /** The user's own name for the destination (host label or "Local terminal"). */
  label: string;
  /** `user@host port N`, from the saved host, never from the server. */
  identity: string;
  /** Title requested by the remote side, already sanitized. Shown after the label. */
  remoteTitle: string;
  indicator: Indicator;
  /** Output arrived while this pane's tab was in the background. Cleared when the tab is shown. */
  unread: boolean;
  /** Restored from a layout template: no session until the user chooses Connect. */
  pending: boolean;
  /** In a detached window: the single-use token for taking over this pane's session. */
  attachToken?: string;
}

/**
 * Session state shown beside a pane or tab: connecting (busy), connected (ok), dropped or failed
 * (bad), waiting for the user to answer a prompt (attention), ended normally (idle).
 */
export type Indicator = "busy" | "ok" | "bad" | "attention" | "idle";

export interface Tab {
  id: number;
  /** Set when the user renamed the tab; otherwise the focused pane's label is shown. */
  customTitle: string | null;
  layout: Layout;
  focused: number;
  /** Focus layout: the focused pane fills the tab and the others are listed beside it. */
  focusMode: boolean;
}

export interface Workspace {
  tabs: Tab[];
  panes: Record<number, Pane>;
  /** `null` shows the navigation page instead of a terminal tab. */
  active: number | null;
  nextId: number;
  /** The named layout this workspace was opened from or last saved as, with what was saved. */
  template: { id: string; name: string; saved: string } | null;
}

export const emptyWorkspace: Workspace = { tabs: [], panes: {}, active: null, nextId: 1, template: null };

export function panesOf(layout: Layout): number[] {
  return layout.kind === "leaf" ? [layout.pane] : [...panesOf(layout.a), ...panesOf(layout.b)];
}

export function paneCount(ws: Workspace): number {
  return Object.keys(ws.panes).length;
}

export function tabTitle(ws: Workspace, tab: Tab): string {
  return tab.customTitle ?? ws.panes[tab.focused]?.label ?? "";
}

export function activeTab(ws: Workspace): Tab | null {
  return ws.tabs.find((t) => t.id === ws.active) ?? null;
}

export function activePane(ws: Workspace): Pane | null {
  const tab = activeTab(ws);
  return tab ? (ws.panes[tab.focused] ?? null) : null;
}

export type PaneSeed = Pick<Pane, "target" | "label" | "identity">;

function newPane(ws: Workspace, seed: PaneSeed, pending = false): [Workspace, number] {
  const id = ws.nextId;
  const pane: Pane = { id, ...seed, remoteTitle: "", indicator: pending ? "idle" : "busy", unread: false, pending };
  return [{ ...ws, panes: { ...ws.panes, [id]: pane }, nextId: id + 1 }, id];
}

export function openTab(ws: Workspace, seed: PaneSeed): Workspace {
  if (paneCount(ws) >= MAX_PANES) return ws;
  const [next, paneId] = newPane(ws, seed);
  const tabId = next.nextId;
  const tab: Tab = { id: tabId, customTitle: null, layout: { kind: "leaf", pane: paneId }, focused: paneId, focusMode: false };
  return { ...next, tabs: [...next.tabs, tab], active: tabId, nextId: tabId + 1 };
}

function replaceLeaf(layout: Layout, pane: number, make: (leaf: Layout) => Layout): Layout {
  if (layout.kind === "leaf") return layout.pane === pane ? make(layout) : layout;
  return { ...layout, a: replaceLeaf(layout.a, pane, make), b: replaceLeaf(layout.b, pane, make) };
}

function tabOfPane(ws: Workspace, pane: number): Tab | undefined {
  return ws.tabs.find((t) => panesOf(t.layout).includes(pane));
}

/**
 * Splits `pane` and opens a new pane beside it: with the same destination, or with `seed` (a
 * different host or a local shell, for a workspace of several sessions).
 */
export function splitPane(ws: Workspace, pane: number, dir: Direction, seed?: PaneSeed): Workspace {
  const tab = tabOfPane(ws, pane);
  const source = ws.panes[pane];
  if (!tab || !source || paneCount(ws) >= MAX_PANES) return ws;
  const [next, created] = newPane(ws, seed ?? { target: source.target, label: source.label, identity: source.identity });
  const layout = replaceLeaf(tab.layout, pane, (leaf) => ({ kind: "split", dir, ratio: 0.5, a: leaf, b: { kind: "leaf", pane: created } }));
  return { ...next, tabs: next.tabs.map((t) => (t.id === tab.id ? { ...t, layout, focused: created } : t)) };
}

function removeLeaf(layout: Layout, pane: number): Layout | null {
  if (layout.kind === "leaf") return layout.pane === pane ? null : layout;
  const a = removeLeaf(layout.a, pane);
  const b = removeLeaf(layout.b, pane);
  if (a === null) return b;
  if (b === null) return a;
  return { ...layout, a, b };
}

/** Closes one pane; a tab whose last pane closes goes away. */
export function closePane(ws: Workspace, pane: number): Workspace {
  const tab = tabOfPane(ws, pane);
  if (!tab) return ws;
  const panes = { ...ws.panes };
  delete panes[pane];
  const layout = removeLeaf(tab.layout, pane);
  if (layout === null) return removeTab({ ...ws, panes }, tab.id);
  const remaining = panesOf(layout);
  const focused = remaining.includes(tab.focused) ? tab.focused : (remaining[0] as number);
  const next = { ...ws, panes, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, layout, focused } : t)) };
  // In focus layout another pane comes on screen: its output is now seen.
  return next.active === tab.id ? activate(next, tab.id) : next;
}

function removeTab(ws: Workspace, tabId: number): Workspace {
  const index = ws.tabs.findIndex((t) => t.id === tabId);
  const tabs = ws.tabs.filter((t) => t.id !== tabId);
  let active = ws.active;
  if (active === tabId) {
    // Focus moves to the neighbour, as in browsers; with no tabs left, the page shows.
    active = (tabs[Math.min(index, tabs.length - 1)] ?? null)?.id ?? null;
    return activate({ ...ws, tabs }, active);
  }
  return { ...ws, tabs, active };
}

export function closeTab(ws: Workspace, tabId: number): Workspace {
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!tab) return ws;
  const panes = { ...ws.panes };
  for (const p of panesOf(tab.layout)) delete panes[p];
  return removeTab({ ...ws, panes }, tabId);
}

export function closeOtherTabs(ws: Workspace, keep: number): Workspace {
  return ws.tabs.filter((t) => t.id !== keep).reduce<Workspace>((acc, t) => closeTab(acc, t.id), { ...ws, active: keep });
}

export function renameTab(ws: Workspace, tabId: number, title: string): Workspace {
  const trimmed = title.trim().slice(0, 80);
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, customTitle: trimmed === "" ? null : trimmed } : t)) };
}

/** Moves the tab at `from` to index `to` (both clamped). */
export function moveTab(ws: Workspace, from: number, to: number): Workspace {
  if (from < 0 || from >= ws.tabs.length) return ws;
  const tabs = [...ws.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, moved as Tab);
  return { ...ws, tabs };
}

/** Makes `tabId` the tab in front and marks its panes' output as seen. */
function activate(ws: Workspace, tabId: number | null): Workspace {
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!tab) return { ...ws, active: null };
  const ids = (tab.focusMode ? [tab.focused] : panesOf(tab.layout)).filter((id) => ws.panes[id]?.unread);
  if (ids.length === 0) return { ...ws, active: tab.id };
  const panes = { ...ws.panes };
  for (const id of ids) panes[id] = { ...(panes[id] as Pane), unread: false };
  return { ...ws, panes, active: tab.id };
}

export function selectTab(ws: Workspace, tabId: number | null): Workspace {
  if (tabId === null) return { ...ws, active: null };
  return ws.tabs.some((t) => t.id === tabId) ? activate(ws, tabId) : ws;
}

export function cycleTab(ws: Workspace, delta: 1 | -1): Workspace {
  if (ws.tabs.length === 0) return ws;
  const index = ws.tabs.findIndex((t) => t.id === ws.active);
  const next = index < 0 ? (delta > 0 ? 0 : ws.tabs.length - 1) : (index + delta + ws.tabs.length) % ws.tabs.length;
  return activate(ws, (ws.tabs[next] as Tab).id);
}

export function focusPane(ws: Workspace, pane: number): Workspace {
  const tab = tabOfPane(ws, pane);
  if (!tab) return ws;
  return activate({ ...ws, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, focused: pane } : t)) }, tab.id);
}

/**
 * Moves keyboard focus to `pane` within its tab, only if that tab is the one in front. Focus
 * events from a hidden pane (for example one that was just navigated away from) never bring its
 * tab back.
 */
export function focusPaneInActiveTab(ws: Workspace, pane: number): Workspace {
  const tab = tabOfPane(ws, pane);
  if (!tab || tab.id !== ws.active || tab.focused === pane) return ws;
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, focused: pane } : t)) };
}

/** Output arrived in `pane`: marked unread unless it is on screen. */
export function markUnread(ws: Workspace, pane: number): Workspace {
  const current = ws.panes[pane];
  if (!current || current.unread || paneVisible(ws, pane)) return ws;
  return { ...ws, panes: { ...ws.panes, [pane]: { ...current, unread: true } } };
}

const PRIORITY: Indicator[] = ["attention", "bad", "busy", "ok", "idle"];

/**
 * What a tab shows for all of its panes: the most urgent pane state (a prompt waiting for an
 * answer first, then a dropped connection), whether any pane has unseen output, and how many
 * panes are in each state that needs the user.
 */
export function tabStatus(ws: Workspace, tab: Tab): { indicator: Indicator; unread: boolean; attention: number; bad: number } {
  const panes = panesOf(tab.layout)
    .map((id) => ws.panes[id])
    .filter((p): p is Pane => p !== undefined);
  let best = PRIORITY.length - 1;
  for (const p of panes) best = Math.min(best, PRIORITY.indexOf(p.indicator));
  return {
    indicator: PRIORITY[best] as Indicator,
    unread: panes.some((p) => p.unread),
    attention: panes.filter((p) => p.indicator === "attention").length,
    bad: panes.filter((p) => p.indicator === "bad").length,
  };
}

function remapLayout(layout: Layout, map: Map<number, number>): Layout {
  if (layout.kind === "leaf") return { kind: "leaf", pane: map.get(layout.pane) as number };
  return { ...layout, a: remapLayout(layout.a, map), b: remapLayout(layout.b, map) };
}

/**
 * Opens a copy of a tab right after it: the same arrangement and destinations, each pane with a
 * new session of its own (nothing typed in the original is repeated). Refused (unchanged) when the
 * copy would exceed MAX_PANES.
 */
export function duplicateTab(ws: Workspace, tabId: number): Workspace {
  const index = ws.tabs.findIndex((t) => t.id === tabId);
  const tab = ws.tabs[index];
  if (!tab) return ws;
  const ids = panesOf(tab.layout);
  if (paneCount(ws) + ids.length > MAX_PANES) return ws;
  let next = ws;
  const map = new Map<number, number>();
  for (const id of ids) {
    const source = ws.panes[id] as Pane;
    const [after, created] = newPane(next, { target: source.target, label: source.label, identity: source.identity }, source.pending);
    next = after;
    map.set(id, created);
  }
  const copy: Tab = {
    id: next.nextId,
    customTitle: tab.customTitle,
    layout: remapLayout(tab.layout, map),
    focused: map.get(tab.focused) as number,
    focusMode: tab.focusMode,
  };
  const tabs = [...next.tabs];
  tabs.splice(index + 1, 0, copy);
  return { ...next, tabs, active: copy.id, nextId: copy.id + 1 };
}

// ---------- arrangement ----------

export type Arrangement = "grid" | "columns" | "rows";

/** Panes side by side (or stacked) in equal shares, as a balanced tree. */
function line(ids: number[], dir: Direction): Layout {
  if (ids.length === 1) return { kind: "leaf", pane: ids[0] as number };
  const mid = Math.floor(ids.length / 2);
  return { kind: "split", dir, ratio: mid / ids.length, a: line(ids.slice(0, mid), dir), b: line(ids.slice(mid), dir) };
}

/** An even layout of `ids` in reading order: a near-square grid, one row, or one column. */
export function evenLayout(ids: number[], arrangement: Arrangement): Layout {
  if (arrangement === "columns") return line(ids, "row");
  if (arrangement === "rows") return line(ids, "column");
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: Layout[] = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(line(ids.slice(i, i + cols), "row"));
  const stack = (items: Layout[]): Layout => {
    if (items.length === 1) return items[0] as Layout;
    const mid = Math.floor(items.length / 2);
    return { kind: "split", dir: "column", ratio: mid / items.length, a: stack(items.slice(0, mid)), b: stack(items.slice(mid)) };
  };
  return stack(rows);
}

/** Rearranges a tab's panes evenly; sessions are untouched (panes are never remounted). */
export function arrangeTab(ws: Workspace, tabId: number, arrangement: Arrangement): Workspace {
  return {
    ...ws,
    tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, layout: evenLayout(panesOf(t.layout), arrangement), focusMode: false } : t)),
  };
}

export function setFocusMode(ws: Workspace, tabId: number, on: boolean): Workspace {
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId && t.focusMode !== on ? { ...t, focusMode: on } : t)) };
}

function swapLeaves(layout: Layout, a: number, b: number): Layout {
  if (layout.kind === "leaf") return layout.pane === a ? { kind: "leaf", pane: b } : layout.pane === b ? { kind: "leaf", pane: a } : layout;
  return { ...layout, a: swapLeaves(layout.a, a, b), b: swapLeaves(layout.b, a, b) };
}

/** Exchanges the positions of two panes of the same tab. Focus stays with the moved pane. */
export function swapPanes(ws: Workspace, a: number, b: number): Workspace {
  const tab = tabOfPane(ws, a);
  if (!tab || a === b || !panesOf(tab.layout).includes(b)) return ws;
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, layout: swapLeaves(t.layout, a, b) } : t)) };
}

/** Moves `pane` one place towards a side by exchanging it with its neighbour there. */
export function movePane(ws: Workspace, pane: number, towards: "left" | "right" | "up" | "down"): Workspace {
  const tab = tabOfPane(ws, pane);
  if (!tab) return ws;
  const other = neighbour(tab.layout, pane, towards);
  return other === null ? ws : swapPanes(ws, pane, other);
}

/** Takes `pane` out of its tab into a new tab right after it (its session keeps running). */
export function paneToNewTab(ws: Workspace, pane: number): Workspace {
  const index = ws.tabs.findIndex((t) => panesOf(t.layout).includes(pane));
  const tab = ws.tabs[index];
  if (!tab || panesOf(tab.layout).length < 2) return ws;
  const layout = removeLeaf(tab.layout, pane) as Layout;
  const remaining = panesOf(layout);
  const rest: Tab = { ...tab, layout, focused: remaining.includes(tab.focused) ? tab.focused : (remaining[0] as number) };
  const created: Tab = { id: ws.nextId, customTitle: null, layout: { kind: "leaf", pane }, focused: pane, focusMode: false };
  const tabs = [...ws.tabs];
  tabs.splice(index, 1, rest, created);
  return activate({ ...ws, tabs, nextId: ws.nextId + 1 }, created.id);
}

/** Panes that are on screen: all panes of the tab in front, or only its focused one in focus layout. */
export function paneVisible(ws: Workspace, pane: number): boolean {
  const tab = tabOfPane(ws, pane);
  if (!tab || tab.id !== ws.active) return false;
  return !tab.focusMode || tab.focused === pane;
}

export function patchPane(ws: Workspace, pane: number, patch: Partial<Pick<Pane, "remoteTitle" | "indicator">>): Workspace {
  const current = ws.panes[pane];
  if (!current) return ws;
  if (Object.entries(patch).every(([k, v]) => current[k as keyof Pane] === v)) return ws;
  return { ...ws, panes: { ...ws.panes, [pane]: { ...current, ...patch } } };
}

// ---------- geometry ----------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitterInfo {
  /** Path of a/b choices from the root to this split. */
  path: ("a" | "b")[];
  dir: Direction;
  ratio: number;
  /** The split's whole area, for converting pointer positions to ratios. */
  area: Rect;
  /** Where the divider line is. */
  line: Rect;
}

/** Fractional rectangles (0..1) for every pane, plus the splitters between them. */
export function paneRects(layout: Layout): { panes: Map<number, Rect>; splitters: SplitterInfo[] } {
  const panes = new Map<number, Rect>();
  const splitters: SplitterInfo[] = [];
  const walk = (node: Layout, area: Rect, path: ("a" | "b")[]) => {
    if (node.kind === "leaf") {
      panes.set(node.pane, area);
      return;
    }
    const r = node.ratio;
    if (node.dir === "row") {
      const wa = area.w * r;
      walk(node.a, { ...area, w: wa }, [...path, "a"]);
      walk(node.b, { ...area, x: area.x + wa, w: area.w - wa }, [...path, "b"]);
      splitters.push({ path, dir: "row", ratio: r, area, line: { x: area.x + wa, y: area.y, w: 0, h: area.h } });
    } else {
      const ha = area.h * r;
      walk(node.a, { ...area, h: ha }, [...path, "a"]);
      walk(node.b, { ...area, y: area.y + ha, h: area.h - ha }, [...path, "b"]);
      splitters.push({ path, dir: "column", ratio: r, area, line: { x: area.x, y: area.y + ha, w: area.w, h: 0 } });
    }
  };
  walk(layout, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { panes, splitters };
}

export function setRatio(ws: Workspace, tabId: number, path: ("a" | "b")[], ratio: number): Workspace {
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  const update = (node: Layout, rest: ("a" | "b")[]): Layout => {
    if (node.kind === "leaf") return node;
    if (rest.length === 0) return { ...node, ratio: clamped };
    const [head, ...tail] = rest;
    return head === "a" ? { ...node, a: update(node.a, tail) } : { ...node, b: update(node.b, tail) };
  };
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, layout: update(t.layout, path) } : t)) };
}

/** The nearest pane in a direction from the focused one, by rectangle centers. */
export function neighbour(layout: Layout, from: number, towards: "left" | "right" | "up" | "down"): number | null {
  const { panes } = paneRects(layout);
  const origin = panes.get(from);
  if (!origin) return null;
  const cx = origin.x + origin.w / 2;
  const cy = origin.y + origin.h / 2;
  let best: { id: number; distance: number } | null = null;
  for (const [id, r] of panes) {
    if (id === from) continue;
    const ok =
      (towards === "left" && r.x + r.w <= origin.x + 1e-9) ||
      (towards === "right" && r.x >= origin.x + origin.w - 1e-9) ||
      (towards === "up" && r.y + r.h <= origin.y + 1e-9) ||
      (towards === "down" && r.y >= origin.y + origin.h - 1e-9);
    if (!ok) continue;
    const distance = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (!best || distance < best.distance) best = { id, distance };
  }
  return best?.id ?? null;
}

// ---------- layout templates ----------

function toNode(layout: Layout, index: Map<number, number>): LayoutNode {
  if (layout.kind === "leaf") return { kind: "leaf", pane: index.get(layout.pane) as number };
  return { kind: "split", dir: layout.dir, ratio: layout.ratio, a: toNode(layout.a, index), b: toNode(layout.b, index) };
}

function toTarget(target: TerminalTarget): LayoutTarget {
  return target.kind === "ssh" ? { kind: "ssh", hostId: target.hostId } : { kind: "local" };
}

/**
 * The open tabs as a template: arrangement, destinations, tab names and focus. Only that: no
 * session, output, command or directory is part of a template.
 */
export function templateTabs(ws: Workspace): LayoutTab[] {
  return ws.tabs.map((tab) => {
    const ids = panesOf(tab.layout);
    const index = new Map(ids.map((id, i) => [id, i]));
    return {
      title: tab.customTitle,
      panes: ids.map((id) => toTarget((ws.panes[id] as Pane).target)),
      layout: toNode(tab.layout, index),
      focused: index.get(tab.focused) ?? 0,
      focusMode: tab.focusMode,
    };
  });
}

/** A canonical text form (sorted keys) for comparing what is open with what was saved. */
export function snapshot(tabs: LayoutTab[]): string {
  return JSON.stringify(tabs, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}

/** The open tabs differ from the template they came from (or were last saved as). */
export function templateDirty(ws: Workspace): boolean {
  return ws.template !== null && snapshot(templateTabs(ws)) !== ws.template.saved;
}

/** Records that the workspace now follows `template`, whose saved contents are `tabs`. */
export function markSaved(ws: Workspace, template: { id: string; name: string; tabs: LayoutTab[] }): Workspace {
  return { ...ws, template: { id: template.id, name: template.name, saved: snapshot(template.tabs) } };
}

function fromNode(node: LayoutNode, ids: number[]): Layout {
  if (node.kind === "leaf") return { kind: "leaf", pane: ids[node.pane] as number };
  return { kind: "split", dir: node.dir, ratio: node.ratio, a: fromNode(node.a, ids), b: fromNode(node.b, ids) };
}

/**
 * Opens a template's tabs after the open ones. Every pane starts *pending*: nothing connects until
 * the user chooses Connect, and nothing is run in it. Refused (unchanged) past MAX_PANES.
 */
export function restoreTemplate(ws: Workspace, tabs: LayoutTab[], seed: (target: LayoutTarget) => PaneSeed): Workspace {
  const total = tabs.reduce((n, t) => n + t.panes.length, 0);
  if (tabs.length === 0 || paneCount(ws) + total > MAX_PANES) return ws;
  let next = ws;
  let first: number | null = null;
  for (const t of tabs) {
    const ids: number[] = [];
    for (const target of t.panes) {
      const [after, id] = newPane(next, seed(target), true);
      next = after;
      ids.push(id);
    }
    const tab: Tab = {
      id: next.nextId,
      customTitle: t.title,
      layout: fromNode(t.layout, ids),
      focused: ids[t.focused] ?? (ids[0] as number),
      focusMode: t.focusMode,
    };
    first ??= tab.id;
    next = { ...next, tabs: [...next.tabs, tab], nextId: tab.id + 1 };
  }
  return activate(next, first);
}

/** The user chose Connect for these panes (one, or every pending pane of a tab). */
export function connectPanes(ws: Workspace, ids: number[]): Workspace {
  const pending = ids.filter((id) => ws.panes[id]?.pending);
  if (pending.length === 0) return ws;
  const panes = { ...ws.panes };
  for (const id of pending) panes[id] = { ...(panes[id] as Pane), pending: false, indicator: "busy" };
  return { ...ws, panes };
}

// ---------- detaching a tab into its own window ----------

/** The request that moves `tab` (every pane with its live session) into a new window. */
export function detachInput(ws: Workspace, tab: Tab, sessionOf: (pane: number) => string): DetachTabInput {
  const ids = panesOf(tab.layout);
  const index = new Map(ids.map((id, i) => [id, i]));
  return {
    title: tab.customTitle,
    layout: toNode(tab.layout, index),
    panes: ids.map((id) => {
      const p = ws.panes[id] as Pane;
      return { sessionId: sessionOf(id), label: p.label, identity: p.identity, target: toTarget(p.target) };
    }),
    focused: index.get(tab.focused) ?? 0,
  };
}

/** A detached window's workspace: the one tab it was given, each pane taking over its session. */
export function detachedWorkspace(tab: import("@tyrminal/contracts").DetachedTab): Workspace {
  let ws: Workspace = { ...emptyWorkspace };
  const ids: number[] = [];
  for (const p of tab.panes) {
    const target: TerminalTarget = p.target.kind === "ssh" ? { kind: "ssh", hostId: p.target.hostId } : { kind: "local" };
    const [next, id] = newPane(ws, { target, label: p.label, identity: p.identity });
    ws = { ...next, panes: { ...next.panes, [id]: { ...(next.panes[id] as Pane), attachToken: p.token } } };
    ids.push(id);
  }
  const t: Tab = { id: ws.nextId, customTitle: tab.title, layout: fromNode(tab.layout, ids), focused: ids[tab.focused] ?? (ids[0] as number), focusMode: false };
  return { ...ws, tabs: [t], active: t.id, nextId: t.id + 1 };
}

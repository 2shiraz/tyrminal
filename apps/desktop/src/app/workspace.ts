// Tabs and split panes as plain data. Each pane owns one terminal session; the layout is a binary
// tree of splits. Panes are rendered flat and positioned from `paneRects`, so changing the tree
// never remounts a terminal (its session survives splits, closes and moves).

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
  indicator: "busy" | "ok" | "bad" | "attention" | "idle";
}

export interface Tab {
  id: number;
  /** Set when the user renamed the tab; otherwise the focused pane's label is shown. */
  customTitle: string | null;
  layout: Layout;
  focused: number;
}

export interface Workspace {
  tabs: Tab[];
  panes: Record<number, Pane>;
  /** `null` shows the navigation page instead of a terminal tab. */
  active: number | null;
  nextId: number;
}

export const emptyWorkspace: Workspace = { tabs: [], panes: {}, active: null, nextId: 1 };

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

type PaneSeed = Pick<Pane, "target" | "label" | "identity">;

function newPane(ws: Workspace, seed: PaneSeed): [Workspace, number] {
  const id = ws.nextId;
  const pane: Pane = { id, ...seed, remoteTitle: "", indicator: "busy" };
  return [{ ...ws, panes: { ...ws.panes, [id]: pane }, nextId: id + 1 }, id];
}

export function openTab(ws: Workspace, seed: PaneSeed): Workspace {
  if (paneCount(ws) >= MAX_PANES) return ws;
  const [next, paneId] = newPane(ws, seed);
  const tabId = next.nextId;
  const tab: Tab = { id: tabId, customTitle: null, layout: { kind: "leaf", pane: paneId }, focused: paneId };
  return { ...next, tabs: [...next.tabs, tab], active: tabId, nextId: tabId + 1 };
}

function replaceLeaf(layout: Layout, pane: number, make: (leaf: Layout) => Layout): Layout {
  if (layout.kind === "leaf") return layout.pane === pane ? make(layout) : layout;
  return { ...layout, a: replaceLeaf(layout.a, pane, make), b: replaceLeaf(layout.b, pane, make) };
}

function tabOfPane(ws: Workspace, pane: number): Tab | undefined {
  return ws.tabs.find((t) => panesOf(t.layout).includes(pane));
}

/** Splits `pane` and opens a new pane beside it with the same destination. */
export function splitPane(ws: Workspace, pane: number, dir: Direction): Workspace {
  const tab = tabOfPane(ws, pane);
  const source = ws.panes[pane];
  if (!tab || !source || paneCount(ws) >= MAX_PANES) return ws;
  const [next, created] = newPane(ws, { target: source.target, label: source.label, identity: source.identity });
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
  return { ...ws, panes, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, layout, focused } : t)) };
}

function removeTab(ws: Workspace, tabId: number): Workspace {
  const index = ws.tabs.findIndex((t) => t.id === tabId);
  const tabs = ws.tabs.filter((t) => t.id !== tabId);
  let active = ws.active;
  if (active === tabId) {
    // Focus moves to the neighbour, as in browsers; with no tabs left, the page shows.
    active = (tabs[Math.min(index, tabs.length - 1)] ?? null)?.id ?? null;
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

export function selectTab(ws: Workspace, tabId: number | null): Workspace {
  return { ...ws, active: tabId === null || ws.tabs.some((t) => t.id === tabId) ? tabId : ws.active };
}

export function cycleTab(ws: Workspace, delta: 1 | -1): Workspace {
  if (ws.tabs.length === 0) return ws;
  const index = ws.tabs.findIndex((t) => t.id === ws.active);
  const next = index < 0 ? (delta > 0 ? 0 : ws.tabs.length - 1) : (index + delta + ws.tabs.length) % ws.tabs.length;
  return { ...ws, active: (ws.tabs[next] as Tab).id };
}

export function focusPane(ws: Workspace, pane: number): Workspace {
  const tab = tabOfPane(ws, pane);
  if (!tab) return ws;
  return { ...ws, active: tab.id, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, focused: pane } : t)) };
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

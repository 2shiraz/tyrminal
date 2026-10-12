// Opening several hosts at once (multi-select on Hosts): one tab each, or one tab with the panes
// split in an even grid. Pure workspace changes; every pane still connects through the normal
// trust and sign-in prompts of its own session.

import { MAX_PANES, type PaneSeed, type Workspace, activeTab, arrangeTab, openTab, paneCount, selectTab, splitPane } from "./workspace";

export type OpenLayout = "tabs" | "split";

/** Opens `seeds` as tabs or as one split tab; refuses (returns `ws` unchanged) past the pane limit. */
export function openMany(ws: Workspace, seeds: PaneSeed[], layout: OpenLayout): Workspace {
  if (seeds.length === 0 || paneCount(ws) + seeds.length > MAX_PANES) return ws;
  if (layout === "tabs") return seeds.reduce((current, seed) => openTab(current, seed), ws);
  const [first, ...rest] = seeds as [PaneSeed, ...PaneSeed[]];
  let next = openTab(ws, first);
  const tab = activeTab(next);
  if (!tab) return ws;
  for (const seed of rest) {
    const focused = next.tabs.find((t) => t.id === tab.id)?.focused ?? tab.focused;
    next = splitPane(next, focused, "row", seed);
  }
  return rest.length > 0 ? arrangeTab(next, tab.id, "grid") : next;
}

/**
 * Connect in split: `seed` as a new pane beside the focused pane of the terminal tab in front (or
 * of the last terminal tab when a page is shown), selecting that tab; a new tab when there is no
 * terminal tab. Refuses (returns `ws` unchanged) at the pane limit.
 */
export function openBeside(ws: Workspace, seed: PaneSeed): Workspace {
  if (paneCount(ws) >= MAX_PANES) return ws;
  // SFTP tabs are never split.
  const terminal = ws.tabs.filter((t) => ws.panes[t.focused]?.target.kind !== "sftp");
  const tab = terminal.find((t) => t.id === ws.active) ?? terminal.at(-1);
  if (!tab) return openTab(ws, seed);
  return splitPane(selectTab(ws, tab.id), tab.focused, "row", seed);
}

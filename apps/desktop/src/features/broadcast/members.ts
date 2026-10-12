// Broadcast receivers (P-13). A tab broadcasts only among the panes the user confirmed in the
// review, each bound to the session it had then. A pane that was left out, joins the tab later
// or has since reconnected never receives input and its own typing is never relayed.

/** Per broadcasting tab: confirmed pane id → the session that pane had when confirmed. */
export type BroadcastMembers = ReadonlyMap<number, ReadonlyMap<number, string>>;

/** The current session of a pane that can take part right now, or null. */
export type LiveSession = (paneId: number) => string | null;

export function withTab(members: BroadcastMembers, tabId: number, panes: ReadonlyMap<number, string>): BroadcastMembers {
  const next = new Map(members);
  next.set(tabId, new Map(panes));
  return next;
}

export function withoutTab(members: BroadcastMembers, tabId: number): BroadcastMembers {
  if (!members.has(tabId)) return members;
  const next = new Map(members);
  next.delete(tabId);
  return next;
}

/**
 * Stops broadcast in every tab where a confirmed pane left the tab, is not live, has another
 * session than the one reviewed, or fewer than two confirmed panes remain. Returns `members`
 * itself when nothing changes.
 */
export function pruneMembers(members: BroadcastMembers, panesOfTab: (tabId: number) => readonly number[] | null, live: LiveSession): BroadcastMembers {
  let next: Map<number, ReadonlyMap<number, string>> | null = null;
  for (const [tabId, panes] of members) {
    const inTab = panesOfTab(tabId);
    const ok = inTab !== null && panes.size >= 2 && [...panes].every(([paneId, session]) => inTab.includes(paneId) && live(paneId) === session);
    if (!ok) {
      next ??= new Map(members);
      next.delete(tabId);
    }
  }
  return next ?? members;
}

/** Panes that receive input typed in `from`; none when `from` is not a confirmed pane. */
export function relayTargets(members: BroadcastMembers, tabId: number, from: number, live: LiveSession): number[] {
  const panes = members.get(tabId);
  if (!panes?.has(from)) return [];
  return [...panes].filter(([paneId, session]) => paneId !== from && live(paneId) === session).map(([paneId]) => paneId);
}

/** Every confirmed pane across tabs (for the per-pane marker). */
export function memberPanes(members: BroadcastMembers): ReadonlySet<number> {
  const all = new Set<number>();
  for (const panes of members.values()) for (const id of panes.keys()) all.add(id);
  return all;
}

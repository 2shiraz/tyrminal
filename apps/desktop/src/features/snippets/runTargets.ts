// Which hosts a snippet run targets (SNP-05/06): hosts chosen one by one and groups chosen whole.
// A group stands for its hosts and every subgroup's hosts as they are when the run starts.

import type { GroupSummary, HostSummary } from "@tyrminal/contracts";

/** The group and all its subgroups, at any depth (a loop in the data is not followed twice). */
export function groupAndDescendants(groupId: string, groups: readonly GroupSummary[]): Set<string> {
  const out = new Set<string>([groupId]);
  for (let added = true; added; ) {
    added = false;
    for (const g of groups) {
      if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        added = true;
      }
    }
  }
  return out;
}

/** Hosts in a group or any of its subgroups. */
export function hostsOfGroup(groupId: string, groups: readonly GroupSummary[], hosts: readonly HostSummary[]): HostSummary[] {
  const inside = groupAndDescendants(groupId, groups);
  return hosts.filter((h) => h.groupId !== null && inside.has(h.groupId));
}

/** Host ids a saved target stands for now: its hosts plus its groups' current hosts, once each. */
export function resolveTarget(
  target: { hostIds: readonly string[]; groupIds: readonly string[] },
  groups: readonly GroupSummary[],
  hosts: readonly HostSummary[],
): Set<string> {
  const known = new Set(hosts.map((h) => h.id));
  const out = new Set(target.hostIds.filter((id) => known.has(id)));
  for (const g of target.groupIds) for (const h of hostsOfGroup(g, groups, hosts)) out.add(h.id);
  return out;
}

export type GroupSelection = "all" | "some" | "none";

/** Whether all, some or none of a group's hosts are selected (a group without hosts is "none"). */
export function groupSelection(groupId: string, selected: ReadonlySet<string>, groups: readonly GroupSummary[], hosts: readonly HostSummary[]): GroupSelection {
  const members = hostsOfGroup(groupId, groups, hosts);
  const chosen = members.filter((h) => selected.has(h.id)).length;
  if (chosen === 0) return "none";
  return chosen === members.length ? "all" : "some";
}

/**
 * The selection as a saved target. A group is kept as a group (so hosts added to it later are
 * included) only when the user picked the group itself and all its hosts are still selected; the
 * outermost such group stands for its subgroups. Every other selected host is kept one by one.
 */
export function selectionAsTarget(
  selected: ReadonlySet<string>,
  picked: ReadonlySet<string>,
  groups: readonly GroupSummary[],
  hosts: readonly HostSummary[],
): { hostIds: string[]; groupIds: string[] } {
  const whole = groups.filter(
    (g) => picked.has(g.id) && hostsOfGroup(g.id, groups, hosts).length > 0 && groupSelection(g.id, selected, groups, hosts) === "all",
  );
  const wholeIds = new Set(whole.map((g) => g.id));
  // Only the outermost: a subgroup inside a whole group is already covered.
  const outer = whole.filter((g) => {
    // Bounded by the number of groups, so a loop in the data cannot hang the page.
    let p = g.parentId;
    for (let steps = 0; p !== null && steps < groups.length; steps++) {
      if (wholeIds.has(p)) return false;
      const parent: string | null = groups.find((x) => x.id === p)?.parentId ?? null;
      p = parent;
    }
    return true;
  });
  const covered = new Set(outer.flatMap((g) => hostsOfGroup(g.id, groups, hosts).map((h) => h.id)));
  return {
    groupIds: outer.map((g) => g.id),
    hostIds: hosts.filter((h) => selected.has(h.id) && !covered.has(h.id)).map((h) => h.id),
  };
}

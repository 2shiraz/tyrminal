// The group tree, as the Hosts list needs it: a group's path and its descendants. A module of its
// own so the list does not load the host and group editors (loaded on first use).
import type { GroupSummary } from "@tyrminal/contracts";

export function groupPath(groups: GroupSummary[], id: string): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const names: string[] = [];
  let current = byId.get(id);
  for (let depth = 0; current && depth < 16; depth += 1) {
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" / ");
}

/** Ids of `id` and every group nested under it (a group cannot move into these). */
export function descendantsOf(groups: GroupSummary[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
    }
  }
  return out;
}

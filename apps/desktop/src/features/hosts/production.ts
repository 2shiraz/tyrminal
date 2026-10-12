// Production hosts (P-26): a host is one through its own flag, a group above it (both resolved
// in the core) or the production tag from the preferences (resolved here, the one place the
// interface asks).

import type { HostSummary } from "@tyrminal/contracts";
import { useCallback } from "react";

import { usePreferences } from "../../app/preferences";

export type ProductionReason = "host" | "group" | "tag";

export function productionReason(host: Pick<HostSummary, "production" | "tags">, tag: string): ProductionReason | null {
  if (host.production) return host.production;
  const wanted = tag.trim().toLowerCase();
  return wanted !== "" && host.tags.some((t) => t.toLowerCase() === wanted) ? "tag" : null;
}

/** Whether a host is a production host under the current preferences. */
export function useIsProduction(): (host: Pick<HostSummary, "production" | "tags"> | null | undefined) => boolean {
  const { prefs } = usePreferences();
  const tag = prefs.productionTag;
  return useCallback((host) => (host ? productionReason(host, tag) !== null : false), [tag]);
}

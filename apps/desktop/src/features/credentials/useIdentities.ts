import type { IdentitySummary } from "@tyrminal/contracts";

import { useVaultData } from "../../app/vaultData";

/** The identity list from the per-unlock cache (reloaded whenever identities or their uses change). */
export function useIdentities(): IdentitySummary[] | null {
  const { identities } = useVaultData();
  return identities.value ?? (identities.error ? [] : null);
}

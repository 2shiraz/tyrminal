// Vault-backed lists shared by several views (hosts, known hosts, keychain, palette, snippets
// panel). They load once per unlock: they live under AppShell, which is keyed by the vault
// generation, so a lock discards all of them. The native side sends no change events for vault
// records (only "vault-status"), so the views that edit a record reload the list it belongs to
// after the edit, and identities reload on `identityEvents`.

import type { GroupSummary, HostSummary, IdentitySummary, KeySummary, SnippetSummary } from "@tyrminal/contracts";
import { type ReactNode, createContext, useContext, useEffect, useMemo } from "react";

import { identityEvents } from "../features/credentials/identityEvents";
import { groups as groupsApi, hosts as hostsApi, identities as identitiesApi, keys as keysApi, snippets as snippetsApi } from "../lib/ipc";
import { useLoaded } from "../lib/useAsync";

type Loaded<T> = ReturnType<typeof useLoaded<T>>;

interface VaultData {
  hosts: Loaded<HostSummary[]>;
  recent: Loaded<HostSummary[]>;
  keys: Loaded<KeySummary[]>;
  snippets: Loaded<SnippetSummary[]>;
  groups: Loaded<GroupSummary[]>;
  identities: Loaded<IdentitySummary[]>;
}

const Context = createContext<VaultData | null>(null);

export function VaultDataProvider({ children }: { children: ReactNode }) {
  const hosts = useLoaded(hostsApi.list);
  const recent = useLoaded(hostsApi.recent);
  const keys = useLoaded(keysApi.list);
  const snippets = useLoaded(snippetsApi.list);
  const groups = useLoaded(groupsApi.list);
  const identities = useLoaded(identitiesApi.list);
  const reloadIdentities = identities.reload;
  useEffect(() => identityEvents.subscribe(() => void reloadIdentities()), [reloadIdentities]);
  const value = useMemo(
    () => ({ hosts, recent, keys, snippets, groups, identities }),
    [hosts, recent, keys, snippets, groups, identities],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The shared lists where the vault is part of the window, else null (a detached window). */
export function useOptionalVaultData(): VaultData | null {
  return useContext(Context);
}

export function useVaultData(): VaultData {
  const value = useContext(Context);
  if (!value) throw new Error("useVaultData outside VaultDataProvider");
  return value;
}

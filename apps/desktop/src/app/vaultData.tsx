// Vault-backed lists shared by several views (home, hosts, palette, snippets panel). They live
// under AppShell, which is keyed by the vault generation, so a lock discards all of them.

import type { GroupSummary, HostSummary, KeySummary, SnippetSummary } from "@tyrminal/contracts";
import { type ReactNode, createContext, useContext, useMemo } from "react";

import { groups as groupsApi, hosts as hostsApi, keys as keysApi, snippets as snippetsApi } from "../lib/ipc";
import { useLoaded } from "../lib/useAsync";

type Loaded<T> = ReturnType<typeof useLoaded<T>>;

interface VaultData {
  hosts: Loaded<HostSummary[]>;
  recent: Loaded<HostSummary[]>;
  keys: Loaded<KeySummary[]>;
  snippets: Loaded<SnippetSummary[]>;
  groups: Loaded<GroupSummary[]>;
}

const Context = createContext<VaultData | null>(null);

export function VaultDataProvider({ children }: { children: ReactNode }) {
  const hosts = useLoaded(hostsApi.list);
  const recent = useLoaded(hostsApi.recent);
  const keys = useLoaded(keysApi.list);
  const snippets = useLoaded(snippetsApi.list);
  const groups = useLoaded(groupsApi.list);
  const value = useMemo(() => ({ hosts, recent, keys, snippets, groups }), [hosts, recent, keys, snippets, groups]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useVaultData(): VaultData {
  const value = useContext(Context);
  if (!value) throw new Error("useVaultData outside VaultDataProvider");
  return value;
}

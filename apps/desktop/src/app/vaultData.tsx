// Vault-backed lists shared by several views (home, hosts, palette, snippets panel). They live
// under AppShell, which is keyed by the vault generation, so a lock discards all of them.

import type { GroupSummary, HostSummary, KeySummary, SnippetSummary } from "@tyrminal/contracts";
import { type ReactNode, createContext, useContext, useMemo, useRef } from "react";

import { groups as groupsApi, hosts as hostsApi, keys as keysApi, snippets as snippetsApi } from "../lib/ipc";
import { useLoaded } from "../lib/useAsync";

type Loaded<T> = ReturnType<typeof useLoaded<T>>;

interface VaultData {
  hosts: Loaded<HostSummary[]>;
  recent: Loaded<HostSummary[]>;
  keys: Loaded<KeySummary[]>;
  snippets: Loaded<SnippetSummary[]>;
  groups: Loaded<GroupSummary[]>;
  /** Derived, non-secret results computed once per unlock (Home's security review counts). */
  memo: Map<string, unknown>;
}

const Context = createContext<VaultData | null>(null);

export function VaultDataProvider({ children }: { children: ReactNode }) {
  const hosts = useLoaded(hostsApi.list);
  const recent = useLoaded(hostsApi.recent);
  const keys = useLoaded(keysApi.list);
  const snippets = useLoaded(snippetsApi.list);
  const groups = useLoaded(groupsApi.list);
  const memo = useRef(new Map<string, unknown>()).current;
  const value = useMemo(() => ({ hosts, recent, keys, snippets, groups, memo }), [hosts, recent, keys, snippets, groups, memo]);
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

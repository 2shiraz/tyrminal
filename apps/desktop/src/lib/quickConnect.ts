// Quick connect (Home): the input for a session to an address that is not saved, handed from the
// quick-connect sheet to the terminal pane that opens it. It lives only in memory, in this window,
// and is never part of workspace or layout state (the pane's target holds only an opaque token).
// A typed password is used once: after the first open, a reconnect asks for it again.

import type { QuickConnectInput } from "@tyrminal/contracts";

const pending = new Map<string, QuickConnectInput>();

/** Keeps `input` for the pane about to open and returns the token its target carries. */
export function stashQuick(input: QuickConnectInput): string {
  const token = crypto.randomUUID();
  pending.set(token, input);
  return token;
}

/** The input for `token`, or null when it is gone (another window, or the app reloaded). */
export function takeQuick(token: string): QuickConnectInput | null {
  return pending.get(token) ?? null;
}

/**
 * A session was opened with `token`'s input: a typed password has been used once, so what stays
 * behind (for a reconnect) asks for it again. Nothing secret outlives the first session.
 */
export function quickUsed(token: string): void {
  const input = pending.get(token);
  if (input?.auth.kind === "password") pending.set(token, { ...input, auth: { kind: "ask" } });
}

/** Forgets every pending quick connection (the vault locked). */
export function clearQuick(): void {
  pending.clear();
}

/**
 * An address typed on Home, alone or as `user@address`, with an optional `:port` (IPv6 in
 * brackets when a port follows). Only the shape is checked here; the core validates it again.
 */
export function parseAddress(text: string): { username: string; address: string; port: number | null } | null {
  const value = text.trim();
  const m = /^(?:([^\s@:/]+)@)?(\[[0-9a-fA-F:.]+\]|[0-9a-fA-F]*:[0-9a-fA-F:.]*:[0-9a-fA-F:.]*|[^\s:@/[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) return null;
  const raw = m[2] as string;
  const bracketed = raw.startsWith("[");
  const address = bracketed ? raw.slice(1, -1) : raw;
  // A bare IPv6 address has no port (its colons are its own); a port needs brackets.
  if (!bracketed && address.includes(":") && m[3]) return null;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
  const ipv6 = address.includes(":") && /^[0-9a-fA-F:.]+$/.test(address) && address.split("::").length <= 2;
  // A host name: labels of letters, digits and inner hyphens, joined by dots (one label is fine:
  // Home offers it only when no saved host matches).
  const hostname = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(address) && !/^\d+$/.test(address);
  if (ipv4 && address.split(".").some((part) => Number(part) > 255)) return null;
  if (!ipv4 && !ipv6 && !hostname) return null;
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { username: m[1] ?? "", address, port };
}

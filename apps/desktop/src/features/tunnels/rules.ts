// Pure helpers for the tunnels UI. The native side validates every rule again; these only decide
// what to show (for example when to ask for an external-bind approval before saving).

import type { TunnelKind } from "@tyrminal/contracts";

function bare(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function isLoopbackLiteral(host: string): boolean {
  const h = bare(host).toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) return isLoopbackLiteral(h.slice(7));
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return v4 !== null && v4[1] === "127" && v4.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Whether a listen address would be reachable from other machines, mirroring the native rule:
 * an empty address means loopback (127.0.0.1 here, the server's localhost for remote rules).
 */
export function isExposed(kind: TunnelKind, host: string): boolean {
  if (host.trim() === "") return false;
  if (kind === "remote" && host.trim() === "*") return true;
  return !isLoopbackLiteral(host);
}

/** The address shown for an empty listen field. */
export function defaultListen(kind: TunnelKind): string {
  return kind === "remote" ? "localhost" : "127.0.0.1";
}

/** Parses a port field: empty is 0 (pick one), otherwise 1–65535; `null` when invalid. */
export function parsePort(text: string, allowAuto: boolean): number | null {
  const t = text.trim();
  if (t === "") return allowAuto ? 0 : null;
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

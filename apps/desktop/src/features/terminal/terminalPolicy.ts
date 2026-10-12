// UI-side handling of untrusted terminal-supplied text. This is presentation hygiene and user
// review; the native side enforces the real policy (link validation, owned-session writes, no
// clipboard or opener capability for the renderer).


const MAX_TITLE_LENGTH = 80;
/** Largest OSC 52 payload accepted for review (decoded bytes). */
export const MAX_OSC52_BYTES = 64 * 1024;
/** Pastes larger than this are reviewed even on one line. */
export const PASTE_REVIEW_BYTES = 4 * 1024;

const DECEPTIVE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Makes a remote-controlled terminal title safe to show as a tab label: control characters and
 * bidirectional overrides removed, whitespace collapsed, length capped. The result is still only
 * ever rendered as text.
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(DECEPTIVE, "").replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned;
}

/**
 * Splits a fingerprint into short groups so two fingerprints can be compared by eye.
 * `SHA256:abcdefgh…` → `SHA256` + `abcd efgh …`.
 */
export function groupFingerprint(fingerprint: string): { algorithm: string; groups: string[] } {
  const separator = fingerprint.indexOf(":");
  const algorithm = separator > 0 ? fingerprint.slice(0, separator) : "";
  const body = separator > 0 ? fingerprint.slice(separator + 1) : fingerprint;
  return { algorithm, groups: body.match(/.{1,4}/g) ?? [] };
}

/**
 * Parses an OSC 52 payload (`<targets>;<base64>`). Returns the text to write, or null for a read
 * request (`?`), a malformed or oversized payload, or text that is not valid UTF-8. Reads are
 * never answered.
 */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const payload = data.slice(separator + 1);
  if (payload === "?" || payload.length === 0) return null;
  if (payload.length > Math.ceil((MAX_OSC52_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function lineCount(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

export interface LinkCheck {
  ok: boolean;
  /** The scheme and host exactly as the browser would see them, for the confirmation dialog. */
  origin: string;
  host: string;
}

/**
 * Pre-checks a link before asking the user (the native side validates again before opening).
 * Only http/https, no embedded credentials, no control or invisible characters. `host` is shown
 * in punycode so look-alike Unicode domains are visible as such.
 */
export function checkLink(raw: string): LinkCheck {
  const fail: LinkCheck = { ok: false, origin: "", host: "" };
  if (!raw || raw.length > 2048 || /\s/.test(raw) || DECEPTIVE.test(raw)) {
    DECEPTIVE.lastIndex = 0;
    return fail;
  }
  DECEPTIVE.lastIndex = 0;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return fail;
  if (/@/.test(raw.slice(raw.indexOf("//") + 2).split(/[/?#]/)[0] ?? "")) return fail;
  return { ok: true, origin: url.origin, host: url.host };
}

const LIGATURES = [
  "<!--", "===", "!==", "<=>", "...", "->>", "<<=", ">>=", "|||", "&&&", "::=",
  "=>", "->", "<-", "<=", ">=", "==", "!=", "&&", "||", "::", "..", "//", "/*", "*/", "++", "--",
  "<<", ">>", "|>", "<|", "=<", "~>", "<~", ":=", "=:", "#{", "#[", "</", "/>", "<>", "?.", "??",
];

/**
 * Character joiner for programming ligatures. The joined range is drawn as one string, so the
 * font's own ligature substitution applies (the GPU renderer otherwise draws cell by cell).
 */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    const match = LIGATURES.find((lig) => text.startsWith(lig, i));
    if (match) {
      ranges.push([i, i + match.length]);
      i += match.length;
    } else {
      i += 1;
    }
  }
  return ranges;
}


/** Automatic reconnect: at most this many tries after a working session drops. */
export const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt` (1-based): doubling from 1 s, capped at 30 s, with
 * ±20% jitter so many tabs (or many clients) do not retry in lockstep. Servers that throttle
 * repeated connections from one address (OpenSSH PerSourcePenalties) see a slowing client.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(Math.max(attempt, 1) - 1, 16);
  const base = Math.min(RECONNECT_BASE_MS * 2 ** step, RECONNECT_CAP_MS);
  return Math.round(base * (0.8 + 0.4 * Math.min(Math.max(random(), 0), 1)));
}

/**
 * Only an SSH session that had reached its shell and then lost the network is retried on its
 * own. Authentication failures, a changed or rejected host key, cancellation, a locked vault,
 * and a normal exit are never retried automatically.
 */
export function shouldAutoReconnect(kind: "ssh" | "local", wasConnected: boolean, code: string | null): boolean {
  return kind === "ssh" && wasConnected && code !== null && ["DISCONNECTED", "TIMEOUT", "UNREACHABLE"].includes(code);
}

/**
 * The working directory from an OSC 7 report (`file://host/path`, percent-encoded), or null.
 * Remote output is untrusted: only an absolute, bounded path without control or invisible
 * characters is kept. Nothing acts on it except an explicit restore the user confirms.
 */
export function parseOsc7(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  if (path.length > 4096 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(path)) return null;
  return path;
}

/** `cd` to `path` for a POSIX shell, quoted so the path is never interpreted. */
export function cdCommand(path: string): string {
  return `cd -- '${path.replaceAll("'", "'\\''")}'`;
}


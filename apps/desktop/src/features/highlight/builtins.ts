// Built-in highlight rules (TRM-07): the tokens Termius-style terminals color in plain output.
// Every expression is linear on the line (no nested or adjacent unbounded repetition that can
// backtrack), runs on one terminal row at a time (at most a few hundred characters) and only
// over cells the program left in the default colors (see highlight.ts).

import type { HighlightPreferences } from "@tyrminal/contracts";

/** What a token is; each kind has its own color in every scheme (palette.ts). */
export type TokenKind =
  | "danger"
  | "warning"
  | "success"
  | "info"
  | "dim"
  | "address"
  | "number"
  | "url"
  | "string"
  | "date"
  | "path"
  | "hex";

export interface BuiltinRule {
  /** Which preference turns it on. */
  pref: keyof Pick<HighlightPreferences, "ipAddresses" | "numbers" | "urls" | "macAddresses" | "dates" | "quoted" | "paths" | "hex" | "levels">;
  kind: TokenKind;
  re: RegExp;
  /** Optional check on the matched text (for shapes a regular expression states poorly). */
  accept?: (text: string) => boolean;
}

const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/(?:3[0-2]|[12]?\d))?(?::\d{1,5})?(?![\w.]*\w)/g;
const IPV6_CANDIDATE = /(?<![0-9A-Fa-f:])[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?![0-9A-Fa-f:])/g;

/**
 * A full (eight groups) or `::`-compressed IPv6 address. Times (12:30:45) and MAC addresses
 * (six groups) are not addresses and are not matched.
 */
export function isIpv6(text: string): boolean {
  if (text.length < 3 || text.length > 39) return false;
  const double = text.indexOf("::");
  if (double !== text.lastIndexOf("::")) return false;
  if (double >= 0) {
    const parts = text.split("::").flatMap((half) => (half === "" ? [] : half.split(":")));
    return parts.length <= 7 && parts.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
  }
  const groups = text.split(":");
  return groups.length === 8 && groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
}

/** A hexadecimal run that is a hash, not a word or a plain number: it has a digit and a letter. */
const isHash = (text: string) => /\d/.test(text) && /[a-f]/i.test(text);

/** In rank order: where two matches overlap, the earlier rule wins. */
export const BUILTIN_RULES: readonly BuiltinRule[] = [
  // URLs first: they contain addresses, numbers and paths.
  { pref: "urls", kind: "url", re: /\b(?:https?|ftp|ssh|sftp|file):\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]}]/g },
  // ISO dates and date-times, then clock times.
  {
    pref: "dates",
    kind: "date",
    re: /(?<![\w.:-])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:[.,]\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?(?![\w:-])/g,
  },
  { pref: "dates", kind: "date", re: /(?<![\w.:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:[.,]\d{1,9})?)?(?![\w:])/g },
  { pref: "ipAddresses", kind: "address", re: IPV4 },
  { pref: "ipAddresses", kind: "address", re: IPV6_CANDIDATE, accept: isIpv6 },
  { pref: "macAddresses", kind: "address", re: /(?<![\w:-])[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}(?![\w:-])/g },
  // UUIDs, 0x values and commit hashes.
  { pref: "hex", kind: "hex", re: /(?<![\w-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\w-])/g },
  { pref: "hex", kind: "hex", re: /(?<!\w)0x[0-9a-fA-F]{1,64}(?!\w)/g },
  { pref: "hex", kind: "hex", re: /(?<![\w-])[0-9a-f]{7,64}(?![\w-])/g, accept: isHash },
  // Quoted text on one line; a single quote must not be an apostrophe inside a word.
  { pref: "quoted", kind: "string", re: /"[^"\r\n]{0,200}"/g },
  { pref: "quoted", kind: "string", re: /(?<!\w)'[^'\r\n]{1,200}'(?!\w)/g },
  // Status words.
  {
    pref: "levels",
    kind: "danger",
    re: /\b(?:error|errors|err|fail|failed|failure|failing|fatal|denied|refused|critical|crit|panic|emerg|alert|unreachable|timeout|timed out|abort(?:ed)?|killed|segfault|exception|invalid|forbidden|unauthorized|not found|no such file or directory|down)\b/gi,
  },
  { pref: "levels", kind: "warning", re: /\b(?:warn|warning|warnings|deprecated|retry(?:ing)?|skipped|degraded|pending)\b/gi },
  { pref: "levels", kind: "success", re: /\b(?:ok|okay|success|successful|successfully|succeeded|done|passed|pass|up|active|running|enabled|ready|healthy|complete(?:d)?|connected|accepted|started|listening)\b/gi },
  { pref: "levels", kind: "dim", re: /\b(?:info|debug|trace|notice|verbose)\b/gi },
  // Paths: absolute, home or relative with at least one separator.
  { pref: "paths", kind: "path", re: /(?<![\w/.~:-])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+\/?(?![\w/])/g, accept: (t) => /[A-Za-z_]/.test(t) },
  // Numbers last: with a size, percentage or duration unit when there is one.
  {
    pref: "numbers",
    kind: "number",
    re: /(?<![\w.])[-+]?\d+(?:[.,]\d+)*(?:\s?(?:[KMGTPE]i?B?|[kKMGTPE]|B|bytes|%|ms|us|µs|ns|s|sec|secs|min|h|d|x|°C))?(?![\w.]*\w)/g,
  },
];

export function enabledBuiltins(prefs: HighlightPreferences): BuiltinRule[] {
  if (!prefs.enabled) return [];
  // Files written before a kind existed have no value for it: on, like the default.
  return BUILTIN_RULES.filter((rule) => prefs[rule.pref] !== false);
}

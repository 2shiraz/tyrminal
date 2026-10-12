// Paste safety (P-25, extends P-14). What a paste would really send: characters that do not show
// on screen (controls, ESC, C1, bidirectional overrides, zero-width) are found and named, a
// paste that would run a command at once is recognised, and a bracketed-paste end marker inside
// the text is found, because it would end the paste early and let the rest run as typed input.
// Pure functions; the terminal and the review use them, and the send path refuses the marker.

export const PASTE_REVIEW_BYTES = 4 * 1024;

/** ESC [ 2 0 1 ~, the marker that ends a bracketed paste. */
export const BRACKET_END = "\u001b[201~";

export type HiddenKind = "control" | "escape" | "c1" | "bidi" | "zero-width";

export interface Hidden {
  index: number;
  char: string;
  kind: HiddenKind;
  /** What the review shows in place of the character, e.g. "ESC", "NUL", "U+202E". */
  label: string;
}

export interface PasteAnalysis {
  lines: number;
  /** A single line that ends in a newline: pasting it runs it at once. */
  runsAtOnce: boolean;
  hidden: Hidden[];
  hasBracketEnd: boolean;
}

const C0_NAMES = ["NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL", "BS", "TAB", "LF", "VT", "FF", "CR", "SO", "SI", "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB", "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US"];

const hex = (c: string) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/** The kind of a character that does not show as itself, or null for one that does. */
export function hiddenKind(c: string): HiddenKind | null {
  const code = c.codePointAt(0) ?? 0;
  // Tab and line breaks are ordinary paste content.
  if (c === "\t" || c === "\n" || c === "\r") return null;
  if (code === 0x1b) return "escape";
  if (code < 0x20 || code === 0x7f) return "control";
  if (code >= 0x80 && code <= 0x9f) return "c1";
  if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f || code === 0x061c) return "bidi";
  if ((code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff || code === 0x00ad || code === 0x180e) return "zero-width";
  return null;
}

function label(c: string, kind: HiddenKind): string {
  const code = c.codePointAt(0) ?? 0;
  if (kind === "escape") return "ESC";
  if (kind === "control") return code === 0x7f ? "DEL" : (C0_NAMES[code] ?? hex(c));
  return hex(c);
}

export function lineCount(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

export function analyzePaste(text: string): PasteAnalysis {
  const hidden: Hidden[] = [];
  let index = 0;
  for (const c of text) {
    const kind = hiddenKind(c);
    if (kind) hidden.push({ index, char: c, kind, label: label(c, kind) });
    index += c.length;
  }
  const lines = lineCount(text);
  return { lines, runsAtOnce: lines === 1 && /[\r\n]$/.test(text), hidden, hasBracketEnd: text.includes(BRACKET_END) };
}

/**
 * Whether a paste is shown before it is sent. Hidden characters and the end marker always are
 * (this cannot be turned off); the multi-line review follows the user's setting.
 */
export function needsPasteReview(text: string, reviewPlain = true): boolean {
  const a = analyzePaste(text);
  if (a.hidden.length > 0 || a.hasBracketEnd) return true;
  return reviewPlain && (a.lines > 1 || a.runsAtOnce || text.length > PASTE_REVIEW_BYTES);
}

/** The text with every end marker removed. */
export function withoutBracketEnd(text: string): string {
  return text.split(BRACKET_END).join("");
}

/** The text in pieces for the review: plain runs, and hidden characters with their labels. */
export function previewSegments(text: string): ({ text: string } | { hidden: Hidden })[] {
  const out: ({ text: string } | { hidden: Hidden })[] = [];
  let run = "";
  let index = 0;
  for (const c of text) {
    const kind = hiddenKind(c);
    if (kind) {
      if (run) out.push({ text: run });
      run = "";
      out.push({ hidden: { index, char: c, kind, label: label(c, kind) } });
    } else {
      run += c;
    }
    index += c.length;
  }
  if (run) out.push({ text: run });
  return out;
}

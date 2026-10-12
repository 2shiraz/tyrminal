// Paste safety (P-25, ADR 0011; extends P-14). Decides whether a paste is shown for review before
// it is sent, and makes characters that change what the shell receives without being visible
// show up in that review. This is the user's chance to read the exact text; nothing here decides
// that text is safe.

import { PASTE_REVIEW_BYTES } from "./terminalPolicy";

/** The bracketed-paste end marker. Inside pasted text it would end the bracket early and let the
 * rest run as typed input, so it is never sent. */
export const BRACKET_END = "\u001b[201~";
/** The same marker with the 8-bit CSI introducer. */
const BRACKET_END_C1 = "\u009b201~";

export type PasteReason =
  /** More than one line: in a shell, each line can run as a command. */
  | "multiline"
  /** Larger than `PASTE_REVIEW_BYTES`. */
  | "large"
  /** One line that ends in a newline runs as soon as it is pasted. */
  | "trailing_newline"
  /** Control or invisible characters (always reviewed). */
  | "hidden"
  /** A bracketed-paste end marker (always reviewed; never sent as it is). */
  | "bracket_end";

/** The checks the user can lower for one host. The hidden-character check is not among them. */
export interface PasteChecks {
  /** Review pastes with several lines or more than `PASTE_REVIEW_BYTES`. */
  multiline: boolean;
  /** Review a one-line paste that ends in a newline. */
  trailingNewline: boolean;
}

export interface HiddenCharacter {
  /** Index in the pasted string. */
  index: number;
  codePoint: number;
  /** How the review shows it: a control picture (␛) or `<U+XXXX>`. */
  label: string;
}

export interface PasteCheck {
  review: boolean;
  reasons: PasteReason[];
  hidden: HiddenCharacter[];
  bracketEnd: boolean;
}

/**
 * C0 controls other than tab, line feed and carriage return; DEL; C1 controls; bidirectional
 * embeddings, overrides and isolates (U+202A–202E, U+2066–2069); zero-width space, non-joiner
 * and joiner (U+200B–200D) and the byte-order mark (U+FEFF).
 */
function isHidden(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0xfeff
  );
}

function label(code: number): string {
  if (code < 0x20) return String.fromCodePoint(0x2400 + code);
  if (code === 0x7f) return "␡";
  return `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
}

export function hiddenCharacters(text: string): HiddenCharacter[] {
  const out: HiddenCharacter[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHidden(code)) out.push({ index: i, codePoint: code, label: label(code) });
  }
  return out;
}

export function hasBracketEnd(text: string): boolean {
  return text.includes(BRACKET_END) || text.includes(BRACKET_END_C1);
}

/** The text with every bracketed-paste end marker removed, including ones formed by removal. */
export function removeBracketEnd(text: string): string {
  let out = text;
  while (hasBracketEnd(out)) out = out.split(BRACKET_END).join("").split(BRACKET_END_C1).join("");
  return out;
}

function lines(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

/** Whether `text` is reviewed before it is sent, and why. */
export function checkPaste(text: string, checks: PasteChecks): PasteCheck {
  const reasons: PasteReason[] = [];
  const hidden = hiddenCharacters(text);
  const bracketEnd = hasBracketEnd(text);
  if (bracketEnd) reasons.push("bracket_end");
  if (hidden.length > 0) reasons.push("hidden");
  const multi = lines(text) > 1;
  if (checks.multiline && multi) reasons.push("multiline");
  if (checks.multiline && text.length > PASTE_REVIEW_BYTES) reasons.push("large");
  if (checks.trailingNewline && !multi && /[\r\n]$/.test(text)) reasons.push("trailing_newline");
  return { review: reasons.length > 0, reasons, hidden, bracketEnd };
}

export interface VisibleSegment {
  text: string;
  /** A hidden character shown by its label. */
  hidden: boolean;
}

/** The text split for display, hidden characters replaced by their labels. */
export function visibleSegments(text: string): VisibleSegment[] {
  const out: VisibleSegment[] = [];
  let plain = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isHidden(code)) {
      plain += text[i];
      continue;
    }
    if (plain) out.push({ text: plain, hidden: false });
    plain = "";
    out.push({ text: label(code), hidden: true });
  }
  if (plain) out.push({ text: plain, hidden: false });
  return out;
}

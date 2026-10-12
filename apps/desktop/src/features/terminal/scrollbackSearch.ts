// Search over a terminal's scrollback (P-28). It reads only the buffer the terminal already holds
// in memory; nothing is indexed, stored or logged, and the query never leaves the page.

import type { IBufferLine } from "@xterm/xterm";

/** Longest query accepted, in characters. */
export const MAX_QUERY = 256;
/** Matches returned per terminal; the caller is told when there were more. */
export const MAX_MATCHES_PER_TERMINAL = 200;
/** Characters of context shown on each side of a match. */
const CONTEXT = 48;

export interface ScrollbackMatch {
  /** Buffer row and column where the match starts. */
  row: number;
  col: number;
  /** Length of the match in characters. */
  length: number;
  /** The text around the match, for the result list; `at` is where the match starts in it. */
  preview: string;
  at: number;
}

export interface ScrollbackResult {
  matches: ScrollbackMatch[];
  /** More matches exist than were returned. */
  truncated: boolean;
}

/**
 * Finds `query` in the rows `[0, length)` of a buffer. Soft-wrapped rows are joined into one
 * logical line so a match can cross a wrap. Plain text, not a pattern; case-insensitive unless
 * asked otherwise.
 */
export function searchLines(
  getLine: (y: number) => IBufferLine | undefined,
  length: number,
  query: string,
  caseSensitive = false,
  max = MAX_MATCHES_PER_TERMINAL,
): ScrollbackResult {
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle.length === 0 || needle.length > MAX_QUERY) return { matches: [], truncated: false };
  const matches: ScrollbackMatch[] = [];
  let y = 0;
  while (y < length) {
    // One logical line: this row and the wrapped rows that continue it.
    const starts: number[] = [];
    let text = "";
    const first = y;
    do {
      starts.push(text.length);
      text += getLine(y)?.translateToString(true) ?? "";
      y += 1;
    } while (y < length && getLine(y)?.isWrapped);
    const haystack = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      if (matches.length >= max) return { matches, truncated: true };
      let r = 0;
      while (r + 1 < starts.length && (starts[r + 1] ?? Infinity) <= index) r += 1;
      const begin = Math.max(0, index - CONTEXT);
      matches.push({
        row: first + r,
        col: index - (starts[r] ?? 0),
        length: needle.length,
        preview: text.slice(begin, index + needle.length + CONTEXT),
        at: index - begin,
      });
      from = index + Math.max(1, needle.length);
    }
  }
  return { matches, truncated: false };
}

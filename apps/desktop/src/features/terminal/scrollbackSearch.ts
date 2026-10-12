// Search over a terminal's scrollback (P-28). It reads only the buffer the terminal already holds
// in memory; nothing is indexed, stored or logged, and the query never leaves the page.

import type { IBufferLine } from "@xterm/xterm";

/** Longest query accepted, in characters. */
export const MAX_QUERY = 256;
/** Matches returned per call unless the caller asks otherwise (a line in progress is finished). */
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
  /** The row to continue from with another slice; the buffer length when the search is done. */
  next: number;
  /** Rows in the buffer when it was searched. */
  length: number;
}

/**
 * Part of a buffer to search, so a caller can search in small steps and never block typing:
 * start at row `from`, stop after about `rows` rows (always at the start of a logical line) or
 * once `max` matches are found.
 */
export interface SearchSlice {
  from?: number;
  rows?: number;
  max?: number;
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
  slice: SearchSlice = {},
): ScrollbackResult {
  const max = slice.max ?? MAX_MATCHES_PER_TERMINAL;
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle.length === 0 || needle.length > MAX_QUERY) return { matches: [], truncated: false, next: length, length };
  const matches: ScrollbackMatch[] = [];
  let y = Math.max(0, slice.from ?? 0);
  // A slice starts at a logical line, never inside a wrapped one.
  while (y > 0 && y < length && getLine(y)?.isWrapped) y -= 1;
  const stop = slice.rows === undefined ? length : Math.min(length, y + Math.max(1, slice.rows));
  while (y < length) {
    if (y >= stop) return { matches, truncated: false, next: y, length };
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
      // One enormous wrapped line cannot flood the list: past four times the cap it is cut short.
      if (index < 0 || matches.length >= max * 4) break;
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
    // The cap is checked between logical lines, so resuming at `next` never repeats a match.
    if (matches.length >= max && y < length) return { matches, truncated: true, next: y, length };
  }
  return { matches, truncated: false, next: length, length };
}

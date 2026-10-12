// Output highlighting (TRM-07). Matches are drawn as xterm decorations over the cells already on
// screen: the bytes received, the text in the buffer, what a selection copies and what is sent
// back to the server are never changed. Only the visible rows are scanned, after output settles.

import type { HighlightPreferences, HighlightTone } from "@tyrminal/contracts";
import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

import type { PatternRule } from "../highlight/patterns";
import { isSlowPattern, runPatterns } from "../highlight/runner";

export interface Match {
  start: number;
  end: number;
  tone: HighlightTone;
}

const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)/g;
const IPV6_CANDIDATE = /(?<![0-9A-Fa-f:])[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?![0-9A-Fa-f:])/g;

/**
 * A full (eight groups) or `::`-compressed IPv6 address. Times (12:30:45) and MAC addresses
 * (six groups) are not addresses and are not matched.
 */
export function isIpv6(text: string): boolean {
  if (text.length < 2 || text.length > 39) return false;
  const double = text.indexOf("::");
  if (double !== text.lastIndexOf("::")) return false;
  const groups = text.split(":");
  if (double >= 0) {
    const parts = text.split("::").flatMap((half) => (half === "" ? [] : half.split(":")));
    return parts.length <= 7 && parts.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
  }
  return groups.length === 8 && groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RankedMatch extends Match {
  /** Rule position: earlier rules win where matches overlap; addresses come last. */
  rank: number;
}

const ADDRESS_RANK = Number.MAX_SAFE_INTEGER;

/** Literal words and addresses (matched here); pattern rules are matched in a worker. */
export function compileRules(prefs: HighlightPreferences): ((text: string) => RankedMatch[]) | null {
  const literal = prefs.keywords.flatMap((k, rank) => (k.pattern ? [] : [{ k, rank }]));
  if (!prefs.enabled || (!prefs.ipAddresses && literal.length === 0)) return null;
  const words = literal.map(({ k, rank }) => {
    const body = escape(k.text);
    // Whole words for words; anything else matches where it appears.
    const left = /^\w/.test(k.text) ? "(?<![\\w])" : "";
    const right = /\w$/.test(k.text) ? "(?![\\w])" : "";
    return { re: new RegExp(`${left}${body}${right}`, k.caseSensitive ? "g" : "gi"), tone: k.tone, rank };
  });
  return (text) => {
    const found: RankedMatch[] = [];
    for (const w of words) for (const m of text.matchAll(w.re)) found.push({ start: m.index, end: m.index + m[0].length, tone: w.tone, rank: w.rank });
    if (prefs.ipAddresses) {
      for (const m of text.matchAll(IPV4)) found.push({ start: m.index, end: m.index + m[0].length, tone: "info", rank: ADDRESS_RANK });
      for (const m of text.matchAll(IPV6_CANDIDATE)) {
        if (isIpv6(m[0])) found.push({ start: m.index, end: m.index + m[0].length, tone: "info", rank: ADDRESS_RANK });
      }
    }
    return found;
  };
}

/** Keeps the earliest rule's match where matches overlap; returns them left to right. */
export function resolveOverlaps(found: RankedMatch[]): RankedMatch[] {
  const byRank = [...found].sort((a, b) => a.rank - b.rank || a.start - b.start);
  const kept: RankedMatch[] = [];
  for (const m of byRank) if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
  return kept.sort((a, b) => a.start - b.start);
}

/** Pattern rules that are on (not switched off for running too long). */
function patternRules(prefs: HighlightPreferences): PatternRule[] {
  if (!prefs.enabled) return [];
  return prefs.keywords.flatMap((k, rank) => (k.pattern && !isSlowPattern(k) ? [{ rank, text: k.text, caseSensitive: k.caseSensitive }] : []));
}

interface Row {
  lineIndex: number;
  text: string;
  /** Per UTF-16 unit of `text`: the cell column and the cell width of its character. */
  columns: number[];
  widths: number[];
}

const MAX_DECORATIONS = 400;
const SETTLE_MS = 60;

/** Decorates matches in the visible rows of one terminal. */
export class OutputHighlighter {
  private matcher: ((text: string) => RankedMatch[]) | null = null;
  private patterns: PatternRule[] = [];
  private prefs: HighlightPreferences | null = null;
  private seq = 0;
  private disposed = false;
  private marks: { marker: IMarker; decoration: IDisposable | undefined }[] = [];
  private timer: number | undefined;
  private readonly listeners: IDisposable[];

  constructor(
    private readonly term: Terminal,
    private colors: Record<HighlightTone, string>,
  ) {
    const schedule = () => this.schedule();
    this.listeners = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule)];
  }

  update(prefs: HighlightPreferences, colors: Record<HighlightTone, string>): void {
    this.prefs = prefs;
    this.matcher = compileRules(prefs);
    this.patterns = patternRules(prefs);
    this.colors = colors;
    this.schedule();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), SETTLE_MS);
  }

  private clear(): void {
    for (const m of this.marks) {
      m.decoration?.dispose();
      m.marker.dispose();
    }
    this.marks = [];
  }

  private render(): void {
    const seq = ++this.seq;
    // A pattern switched off for running too long stays off for this terminal too.
    if (this.prefs) this.patterns = patternRules(this.prefs);
    const match = this.matcher;
    const patterns = this.patterns;
    if (!match && patterns.length === 0) {
      this.clear();
      return;
    }
    const buffer = this.term.buffer.active;
    const rows: Row[] = [];
    for (let row = 0; row < this.term.rows; row += 1) {
      const lineIndex = buffer.viewportY + row;
      const line = buffer.getLine(lineIndex);
      if (!line) continue;
      // Text with the cell column and width of each character (wide characters take two cells).
      let text = "";
      const columns: number[] = [];
      const widths: number[] = [];
      for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x);
        const chars = cell?.getChars() ?? "";
        if (chars === "") continue;
        for (let i = 0; i < chars.length; i += 1) {
          columns.push(x);
          widths.push(cell?.getWidth() ?? 1);
        }
        text += chars;
      }
      if (/\S/.test(text)) rows.push({ lineIndex, text, columns, widths });
    }
    const literal = rows.map((r) => (match ? match(r.text) : []));
    if (patterns.length === 0) {
      this.draw(rows, literal);
      return;
    }
    void runPatterns(this, patterns, rows.map((r) => r.text)).then((outcome) => {
      // Output, scrolling or new rules since this request: a newer render owns the screen.
      if (this.disposed || seq !== this.seq) return;
      if (outcome.kind === "ok") {
        for (const [index, start, end, rank] of outcome.matches) {
          const tone = this.prefs?.keywords[rank]?.tone ?? "info";
          literal[index]?.push({ start, end, tone, rank });
        }
      } else if (outcome.kind === "slow") {
        // Draw what is known and try again without the pattern that was switched off.
        this.schedule();
      }
      this.draw(rows, literal);
    });
  }

  private draw(rows: Row[], found: RankedMatch[][]): void {
    this.clear();
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    rows.forEach((row, index) => {
      for (const m of resolveOverlaps(found[index] ?? [])) {
        if (this.marks.length >= MAX_DECORATIONS) return;
        const x = row.columns[m.start];
        const last = row.columns[m.end - 1];
        if (x === undefined || last === undefined) continue;
        const width = last - x + (row.widths[m.end - 1] ?? 1);
        const marker = this.term.registerMarker(row.lineIndex - cursorLine);
        if (!marker) continue;
        const decoration = this.term.registerDecoration({ marker, x, width, foregroundColor: this.colors[m.tone], layer: "top" });
        decoration?.onRender((element) => {
          element.classList.add("term-highlight");
          element.dataset.tone = m.tone;
        });
        this.marks.push({ marker, decoration });
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.timer);
    for (const l of this.listeners) l.dispose();
    this.clear();
  }
}

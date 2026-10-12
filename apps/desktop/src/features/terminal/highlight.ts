// Output highlighting (TRM-07). Matches are drawn as xterm decorations over the cells already on
// screen: the bytes received, the text in the buffer, what a selection copies and what is sent
// back to the server are never changed. Only the visible rows are scanned, after output settles.
//
// Only plain output is recolored: a match is drawn only if every one of its cells is in the
// terminal's default colors (the program did not color it), and nothing is drawn while a
// full-screen application uses the alternate screen (vim, htop, tmux).

import type { HighlightPreferences } from "@tyrminal/contracts";
import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

import { type TokenKind, enabledBuiltins } from "../highlight/builtins";
import type { PatternRule } from "../highlight/patterns";
import { isSlowPattern, runPatterns } from "../highlight/runner";

export { isIpv6 } from "../highlight/builtins";

export interface Match {
  start: number;
  end: number;
  tone: TokenKind;
}

export interface RankedMatch extends Match {
  /** Rule position: the user's rules first, in their order, then the built-in kinds. */
  rank: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BUILTIN_RANK = 10_000;

/** The user's literal words and the built-in kinds (matched here); patterns run in a worker. */
export function compileRules(prefs: HighlightPreferences): ((text: string) => RankedMatch[]) | null {
  if (!prefs.enabled) return null;
  const literal = prefs.keywords.flatMap((k, rank) => (k.pattern ? [] : [{ k, rank }]));
  const words = literal.map(({ k, rank }) => {
    const body = escape(k.text);
    // Whole words for words; anything else matches where it appears.
    const left = /^\w/.test(k.text) ? "(?<![\\w])" : "";
    const right = /\w$/.test(k.text) ? "(?![\\w])" : "";
    return { re: new RegExp(`${left}${body}${right}`, k.caseSensitive ? "g" : "gi"), tone: k.tone as TokenKind, rank, accept: undefined };
  });
  const builtins = enabledBuiltins(prefs).map((rule, i) => ({ re: rule.re, tone: rule.kind, rank: BUILTIN_RANK + i, accept: rule.accept }));
  const rules = [...words, ...builtins];
  if (rules.length === 0) return null;
  return (text) => {
    const found: RankedMatch[] = [];
    for (const r of rules) {
      r.re.lastIndex = 0;
      for (const m of text.matchAll(r.re)) {
        if (m[0].length === 0 || (r.accept && !r.accept(m[0]))) continue;
        found.push({ start: m.index, end: m.index + m[0].length, tone: r.tone, rank: r.rank });
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
  /** Per UTF-16 unit of `text`: the cell column, the cell width and whether the cell is plain. */
  columns: number[];
  widths: number[];
  plain: boolean[];
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
    private colors: Record<TokenKind, string>,
  ) {
    const schedule = () => this.schedule();
    this.listeners = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule), term.buffer.onBufferChange(schedule)];
  }

  update(prefs: HighlightPreferences, colors: Record<TokenKind, string>): void {
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
    const buffer = this.term.buffer.active;
    // Full-screen applications draw their own screen: never recolor it.
    if ((!match && patterns.length === 0) || buffer.type === "alternate") {
      this.clear();
      return;
    }
    const rows: Row[] = [];
    for (let row = 0; row < this.term.rows; row += 1) {
      const lineIndex = buffer.viewportY + row;
      const line = buffer.getLine(lineIndex);
      if (!line) continue;
      // Text with the cell column and width of each character (wide characters take two cells).
      let text = "";
      const columns: number[] = [];
      const widths: number[] = [];
      const plain: boolean[] = [];
      let anyPlain = false;
      for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x);
        const chars = cell?.getChars() ?? "";
        if (chars === "") continue;
        const isPlain = cell !== undefined && cell.isFgDefault() && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible();
        anyPlain ||= isPlain;
        for (let i = 0; i < chars.length; i += 1) {
          columns.push(x);
          widths.push(cell?.getWidth() ?? 1);
          plain.push(isPlain);
        }
        text += chars;
      }
      if (anyPlain && /\S/.test(text)) rows.push({ lineIndex, text, columns, widths, plain });
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
          const tone = (this.prefs?.keywords[rank]?.tone ?? "info") as TokenKind;
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
    if (buffer.type === "alternate") return;
    const cursorLine = buffer.baseY + buffer.cursorY;
    rows.forEach((row, index) => {
      // Text the program colored is never recolored: only matches over plain cells are drawn.
      const plainOnly = (found[index] ?? []).filter((m) => row.plain.slice(m.start, m.end).every(Boolean));
      for (const m of resolveOverlaps(plainOnly)) {
        if (this.marks.length >= MAX_DECORATIONS) return;
        const x = row.columns[m.start];
        const last = row.columns[m.end - 1];
        if (x === undefined || last === undefined) continue;
        const width = last - x + (row.widths[m.end - 1] ?? 1);
        const marker = this.term.registerMarker(row.lineIndex - cursorLine);
        if (!marker) continue;
        const decoration = this.term.registerDecoration({ marker, x, width, foregroundColor: this.colors[m.tone], layer: "top" });
        const color = this.colors[m.tone];
        decoration?.onRender((element) => {
          element.classList.add("term-highlight");
          element.dataset.tone = m.tone;
          // Links are underlined in their own color (the decoration box sits over the cells).
          element.style.setProperty("--highlight-color", color);
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

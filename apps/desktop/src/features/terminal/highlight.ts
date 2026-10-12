// Output highlighting (TRM-07). Matches are drawn as xterm decorations over the cells already on
// screen: the bytes received, the text in the buffer, what a selection copies and what is sent
// back to the server are never changed. Only the visible rows are scanned, after output settles.

import type { HighlightPreferences, HighlightTone } from "@tyrminal/contracts";
import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

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

export function compileRules(prefs: HighlightPreferences): ((text: string) => Match[]) | null {
  if (!prefs.enabled || (!prefs.ipAddresses && prefs.keywords.length === 0)) return null;
  const words = prefs.keywords.map((k) => {
    const body = escape(k.text);
    // Whole words for words; anything else matches where it appears.
    const left = /^\w/.test(k.text) ? "(?<![\\w])" : "";
    const right = /\w$/.test(k.text) ? "(?![\\w])" : "";
    return { re: new RegExp(`${left}${body}${right}`, k.caseSensitive ? "g" : "gi"), tone: k.tone };
  });
  return (text) => {
    const found: Match[] = [];
    for (const w of words) for (const m of text.matchAll(w.re)) found.push({ start: m.index, end: m.index + m[0].length, tone: w.tone });
    if (prefs.ipAddresses) {
      for (const m of text.matchAll(IPV4)) found.push({ start: m.index, end: m.index + m[0].length, tone: "info" });
      for (const m of text.matchAll(IPV6_CANDIDATE)) {
        if (isIpv6(m[0])) found.push({ start: m.index, end: m.index + m[0].length, tone: "info" });
      }
    }
    // Earlier rules win where matches overlap (words before addresses), then left to right.
    const kept: Match[] = [];
    for (const m of found) if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
    return kept.sort((a, b) => a.start - b.start);
  };
}

const MAX_DECORATIONS = 400;
const SETTLE_MS = 60;

/** Decorates matches in the visible rows of one terminal. */
export class OutputHighlighter {
  private matcher: ((text: string) => Match[]) | null = null;
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
    this.matcher = compileRules(prefs);
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
    this.clear();
    const match = this.matcher;
    if (!match) return;
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    for (let row = 0; row < this.term.rows && this.marks.length < MAX_DECORATIONS; row += 1) {
      const lineIndex = buffer.viewportY + row;
      const line = buffer.getLine(lineIndex);
      if (!line) continue;
      // Text with the cell column of each character (wide characters take two cells).
      let text = "";
      const columns: number[] = [];
      for (let x = 0; x < line.length; x += 1) {
        const chars = line.getCell(x)?.getChars() ?? "";
        if (chars === "") continue;
        for (let i = 0; i < chars.length; i += 1) columns.push(x);
        text += chars;
      }
      if (!/\S/.test(text)) continue;
      for (const m of match(text)) {
        if (this.marks.length >= MAX_DECORATIONS) break;
        const x = columns[m.start] as number;
        const last = columns[m.end - 1] as number;
        const width = last - x + (line.getCell(last)?.getWidth() ?? 1);
        const marker = this.term.registerMarker(lineIndex - cursorLine);
        if (!marker) continue;
        const decoration = this.term.registerDecoration({ marker, x, width, foregroundColor: this.colors[m.tone], layer: "top" });
        decoration?.onRender((element) => {
          element.classList.add("term-highlight");
          element.dataset.tone = m.tone;
        });
        this.marks.push({ marker, decoration });
      }
    }
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    for (const l of this.listeners) l.dispose();
    this.clear();
  }
}

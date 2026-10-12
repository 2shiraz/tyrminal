// The output of each command, as the shell integration marks it (P-29). OSC 133 `C` comes just
// before the command runs (the cursor is where its output starts) and `D` just after it ends (the
// cursor is where the output stops), so the text between the two positions is the output alone:
// no prompt, no command line. Without those marks nothing is recorded and nothing is offered;
// output boundaries are never guessed.
//
// The marks come from the server and are untrusted. They only choose which part of the screen
// the user copies or saves, after choosing the command themselves; nothing here runs or sends.

import type { IBufferLine, IMarker, Terminal } from "@xterm/xterm";

import { shellContexts } from "../autocomplete/shellContext";

/** Commands remembered per terminal; older ones are forgotten (and their markers released). */
const MAX_COMMANDS = 100;
/** Longest output returned, in characters (a full 100,000-line scrollback fits). */
export const MAX_OUTPUT_CHARS = 32 * 1024 * 1024;

export interface CommandRecord {
  id: number;
  /** The command line as the shell integration read it from the screen, if it could. */
  command: string | null;
  exitStatus: number | null;
  /** `D` arrived: the command has ended. */
  finished: boolean;
  /** The output is still in the scrollback. */
  available: boolean;
}

interface Entry {
  id: number;
  command: string | null;
  exitStatus: number | null;
  start: { marker: IMarker; x: number };
  end: { marker: IMarker; x: number } | null;
}

/** Text of `buffer` from (startLine, startX) to (endLine, endX), joining soft-wrapped rows. */
export function textBetween(
  getLine: (y: number) => IBufferLine | undefined,
  start: { line: number; x: number },
  end: { line: number; x: number },
  max = MAX_OUTPUT_CHARS,
): string | null {
  if (end.line < start.line || (end.line === start.line && end.x < start.x)) return "";
  let text = "";
  for (let y = start.line; y <= end.line; y++) {
    const line = getLine(y);
    if (!line) return null;
    const from = y === start.line ? start.x : 0;
    const part = y === end.line ? line.translateToString(false, from, end.x).replace(/\s+$/, "") : line.translateToString(true, from);
    if (y > start.line) text += line.isWrapped ? "" : "\n";
    text += part;
    if (text.length > max) return null;
  }
  return text.replace(/\n+$/, "");
}

export class CommandOutputs {
  private entries: Entry[] = [];
  private nextId = 1;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly sessionId: () => string | null,
  ) {
    // Registered after the shell context handler, so it runs first and returns false to let
    // that handler see the same mark (xterm calls handlers newest first until one returns true).
    const osc = term.parser.registerOscHandler(133, (data) => {
      if (data.length > 4096) return false;
      const [mark, arg] = data.split(";");
      if (mark === "C") this.started();
      else if (mark === "D") this.ended(arg);
      return false;
    });
    this.cleanups.push(() => osc.dispose());
    // The command line is read by the shell context when it handles `C`; take it from there.
    this.cleanups.push(
      shellContexts.onMark((mark) => {
        if (mark.kind !== "command_start" || mark.sessionId !== this.sessionId()) return;
        const last = this.entries.at(-1);
        if (last && last.end === null) last.command = mark.command;
      }),
    );
  }

  private started(): void {
    // A `C` without a `D` before it: the previous command never reported its end.
    const open = this.entries.at(-1);
    if (open && open.end === null) this.drop(open);
    // Full-screen programs draw on the alternate screen, which keeps no scrollback.
    if (this.term.buffer.active.type !== "normal") return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.entries.push({ id: this.nextId++, command: null, exitStatus: null, start: { marker, x: this.term.buffer.active.cursorX }, end: null });
    while (this.entries.length > MAX_COMMANDS) {
      const oldest = this.entries[0];
      if (oldest) this.drop(oldest);
    }
  }

  private ended(arg: string | undefined): void {
    const last = this.entries.at(-1);
    if (!last || last.end !== null) return;
    if (this.term.buffer.active.type !== "normal") {
      this.drop(last);
      return;
    }
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    last.end = { marker, x: this.term.buffer.active.cursorX };
    last.exitStatus = arg !== undefined && /^\d{1,3}$/.test(arg) ? Number(arg) : null;
  }

  private drop(entry: Entry): void {
    entry.start.marker.dispose();
    entry.end?.marker.dispose();
    this.entries = this.entries.filter((e) => e !== entry);
  }

  /** Recorded commands, newest first. */
  list(): CommandRecord[] {
    return this.entries
      .map((e) => ({
        id: e.id,
        command: e.command,
        exitStatus: e.exitStatus,
        finished: e.end !== null,
        available: !e.start.marker.isDisposed && (e.end === null || !e.end.marker.isDisposed),
      }))
      .reverse();
  }

  /** The output of a finished command, or null when it is unknown or no longer in the scrollback. */
  output(id: number): string | null {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry?.end || entry.start.marker.isDisposed || entry.end.marker.isDisposed) return null;
    const buffer = this.term.buffer.normal;
    return textBetween(
      (y) => buffer.getLine(y),
      { line: entry.start.marker.line, x: entry.start.x },
      { line: entry.end.marker.line, x: entry.end.x },
    );
  }

  dispose(): void {
    for (const e of [...this.entries]) this.drop(e);
    for (const fn of this.cleanups) fn();
  }
}

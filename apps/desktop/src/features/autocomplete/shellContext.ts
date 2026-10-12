// Shell context from the opt-in shell integration (AUT-06): OSC 133 marks (prompt start A,
// prompt end B, command start C, command end D;<status>) and OSC 7 (file://host/folder).
//
// The marks come from the remote side, so they are untrusted: payloads are bounded, folders must
// be absolute and free of control characters, and everything is kept as plain text. Nothing here
// runs or sends anything; the context only anchors suggestions and is shown as text. A server
// without the integration can print the same sequences, which at worst changes where relative
// path suggestions start (the user still picks and reviews every insertion).

import type { IBufferLine, IMarker, Terminal } from "@xterm/xterm";

export interface ShellContext {
  /** The shell's current folder (OSC 7). */
  cwd: string | null;
  /** The last command line the user ran, as shown on screen between the marks. */
  command: string | null;
  /** That command's exit status, once it finished. */
  exitStatus: number | null;
  /** Whether the shell is showing its prompt (between A and C). */
  atPrompt: boolean;
}

const MAX_OSC = 4096;
const MAX_COMMAND = 2048;
// C0/C1 controls, DEL, and bidirectional overrides/isolates.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * One mark, after validation, for features that follow a session as it happens (command history,
 * for example). Fields hold only what passed the checks above; listeners must treat them as text
 * from the server and never run or send them.
 */
export type ShellMark =
  | { kind: "prompt"; sessionId: string }
  | { kind: "command_start"; sessionId: string; command: string | null }
  | { kind: "command_end"; sessionId: string; command: string | null; exitStatus: number | null }
  | { kind: "folder"; sessionId: string; cwd: string };

const contexts = new Map<string, ShellContext>();
const listeners = new Set<() => void>();
const markListeners = new Set<(mark: ShellMark) => void>();

function publish(sessionId: string, change: Partial<ShellContext>) {
  const now = contexts.get(sessionId) ?? { cwd: null, command: null, exitStatus: null, atPrompt: false };
  contexts.set(sessionId, { ...now, ...change });
  for (const fn of listeners) fn();
}

function emit(mark: ShellMark) {
  for (const fn of markListeners) {
    try {
      fn(mark);
    } catch {
      // One failing listener does not stop the others or the terminal.
    }
  }
}

export const shellContexts = {
  get(sessionId: string): ShellContext | null {
    return contexts.get(sessionId) ?? null;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Every validated mark of every session, in arrival order. Returns the unsubscribe. */
  onMark(fn: (mark: ShellMark) => void): () => void {
    markListeners.add(fn);
    return () => markListeners.delete(fn);
  },
};

/** Percent-decodes `text` as UTF-8; null when malformed. */
function percentDecode(text: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x25) {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (c < 0x80) bytes.push(c);
    else return null; // a conforming URI is ASCII
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** The folder of an OSC 7 payload (`file://host/path`), or null when it is not acceptable. */
export function parseOsc7(data: string): string | null {
  if (data.length > MAX_OSC || !data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const path = percentDecode(rest.slice(slash));
  if (path === null || !path.startsWith("/") || UNSAFE.test(path)) return null;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The command line that changes a Bash shell to `folder` (`cd -- '<folder>'` and Enter), or null
 * when the folder would not pass the OSC 7 checks. Single quotes leave every character literal;
 * a quote inside the name is closed, escaped and reopened.
 */
export function cdCommand(folder: string): string | null {
  if (folder.length > MAX_OSC || !folder.startsWith("/") || UNSAFE.test(folder)) return null;
  return `cd -- '${folder.replace(/'/g, `'\\''`)}'\r`;
}

/** The text between the prompt end (`start`) and the line the cursor moved to on Enter. */
function commandText(term: Terminal, start: { line: number; x: number }): string | null {
  const buffer = term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  const last = buffer.cursorX === 0 ? cursorLine - 1 : cursorLine;
  if (start.line < 0 || last < start.line || last - start.line > 64) return null;
  let text = "";
  for (let y = start.line; y <= last; y++) {
    const line: IBufferLine | undefined = buffer.getLine(y);
    if (!line) return null;
    const part = line.translateToString(true, y === start.line ? start.x : 0);
    // A soft-wrapped continuation joins the previous row; a real new line keeps the break.
    text += y > start.line && !line.isWrapped ? `\n${part}` : part;
    if (text.length > MAX_COMMAND) return null;
  }
  const command = text.trim();
  return command && !UNSAFE.test(command.replace(/\n/g, "")) ? command : null;
}

/**
 * Follows the marks of one terminal. `sessionId` is read when a mark arrives (the session id is
 * known once the session opened). Returns the cleanup that drops the handlers and the context.
 */
export function attachShellContext(term: Terminal, sessionId: () => string | null): () => void {
  let promptEnd: { marker: IMarker; x: number } | null = null;
  let running = false;
  const osc7 = term.parser.registerOscHandler(7, (data) => {
    const id = sessionId();
    const cwd = parseOsc7(data);
    if (id && cwd) {
      publish(id, { cwd });
      emit({ kind: "folder", sessionId: id, cwd });
    }
    return true;
  });
  const osc133 = term.parser.registerOscHandler(133, (data) => {
    const id = sessionId();
    if (!id || data.length > MAX_OSC) return true;
    const [mark, arg] = data.split(";");
    if (mark === "A") {
      publish(id, { atPrompt: true });
      emit({ kind: "prompt", sessionId: id });
    } else if (mark === "B") {
      promptEnd?.marker.dispose();
      const marker = term.registerMarker(0);
      promptEnd = marker ? { marker, x: term.buffer.active.cursorX } : null;
    } else if (mark === "C") {
      const command = promptEnd && !promptEnd.marker.isDisposed ? commandText(term, { line: promptEnd.marker.line, x: promptEnd.x }) : null;
      promptEnd?.marker.dispose();
      promptEnd = null;
      running = true;
      publish(id, { atPrompt: false, command, exitStatus: null });
      emit({ kind: "command_start", sessionId: id, command });
    } else if (mark === "D" && running) {
      running = false;
      const status = arg !== undefined && /^\d{1,3}$/.test(arg) ? Number(arg) : null;
      publish(id, { exitStatus: status });
      emit({ kind: "command_end", sessionId: id, command: contexts.get(id)?.command ?? null, exitStatus: status });
    }
    return true;
  });
  return () => {
    osc7.dispose();
    osc133.dispose();
    promptEnd?.marker.dispose();
    const id = sessionId();
    if (id && contexts.delete(id)) for (const fn of listeners) fn();
  };
}

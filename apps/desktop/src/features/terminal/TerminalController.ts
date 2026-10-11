// Imperative owner of one xterm instance and its session. Terminal bytes never pass through
// React state: output goes native → channel → xterm, input goes xterm → native.
//
// Flow control: each chunk is acknowledged to the native side only after xterm has parsed it
// (the `write` callback). The core stops reading from the server once 1 MiB is unacknowledged,
// so a slow renderer pauses the remote producer instead of growing a queue.

import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { SessionEvent } from "@tyrminal/contracts";

import { sessions, toAppError } from "../../lib/ipc";
import { sanitizeTitle } from "./terminalPolicy";

export type TerminalTarget = { kind: "ssh"; hostId: string } | { kind: "local" };

export interface TerminalCallbacks {
  onEvent(event: SessionEvent): void;
  onTitle(title: string): void;
}

const INPUT_CHUNK = 32 * 1024;
const ACK_BATCH = 32 * 1024;
const ACK_DELAY_MS = 25;
const RESIZE_DEBOUNCE_MS = 80;
const SCROLLBACK_LINES = 5000;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export class TerminalController {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly encoder = new TextEncoder();
  private readonly resizeObserver: ResizeObserver;
  private sessionId: string | null = null;
  private disposed = false;
  private pendingAck = 0;
  private ackTimer: number | undefined;
  private resizeTimer: number | undefined;
  private lastSize = { cols: 0, rows: 0 };
  /** Serializes input writes so chunks of one paste arrive in order. */
  private inputChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: TerminalCallbacks,
  ) {
    this.term = new Terminal({
      allowProposedApi: false,
      scrollback: SCROLLBACK_LINES,
      cursorBlink: true,
      convertEol: false,
      fontFamily: cssVar("--font-mono", "ui-monospace, Menlo, Consolas, monospace"),
      fontSize: 14,
      // Links are inert: no opener capability is granted to this window, and remote output must
      // never trigger a local action on its own (INV-08). A reviewed, click-to-confirm opener
      // arrives with the terminal policy work in Phase 05.
      linkHandler: { activate: () => undefined },
      theme: {
        background: cssVar("--terminal-bg", "#0b1016"),
        foreground: cssVar("--terminal-fg", "#e8edf3"),
        cursor: cssVar("--terminal-cursor", "#5694ff"),
        selectionBackground: cssVar("--terminal-selection", "#27405f"),
      },
    });
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.fitNow();

    this.term.onData((text) => this.send(this.encoder.encode(text)));
    this.term.onBinary((binary) => this.send(Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff)));
    // The remote side controls the title: treat it as untrusted text.
    this.term.onTitleChange((title) => this.callbacks.onTitle(sanitizeTitle(title)));

    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(container);
  }

  /** Opens the session. Events (state, prompts, close) arrive through the callbacks. */
  async start(target: TerminalTarget): Promise<void> {
    const { cols, rows } = this.term;
    this.lastSize = { cols, rows };
    const onOutput = (bytes: Uint8Array) => this.receive(bytes);
    const onEvent = (event: SessionEvent) => {
      if (!this.disposed) this.callbacks.onEvent(event);
    };
    try {
      const opened =
        target.kind === "ssh"
          ? await sessions.openSsh(target.hostId, cols, rows, onOutput, onEvent)
          : await sessions.openLocal(cols, rows, onOutput, onEvent);
      if (this.disposed) {
        // Closed while opening: do not leave an orphan session behind.
        void sessions.close(opened.sessionId).catch(() => undefined);
        return;
      }
      this.sessionId = opened.sessionId;
    } catch (error) {
      const appError = toAppError(error);
      this.callbacks.onEvent({ type: "closed", error: { code: appError.code, message: appError.message }, exitStatus: null });
    }
  }

  get id(): string | null {
    return this.sessionId;
  }

  focus(): void {
    this.term.focus();
  }

  /** Re-measures the container (for example when a hidden tab becomes visible). */
  refit(): void {
    this.scheduleResize();
  }

  private receive(bytes: Uint8Array): void {
    if (this.disposed) return;
    this.term.write(bytes, () => this.acknowledge(bytes.length));
  }

  private acknowledge(count: number): void {
    this.pendingAck += count;
    if (this.pendingAck >= ACK_BATCH) {
      this.flushAck();
    } else if (this.ackTimer === undefined) {
      this.ackTimer = window.setTimeout(() => this.flushAck(), ACK_DELAY_MS);
    }
  }

  private flushAck(): void {
    window.clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    const count = this.pendingAck;
    this.pendingAck = 0;
    if (count > 0 && this.sessionId && !this.disposed) {
      void sessions.ack(this.sessionId, count).catch(() => undefined);
    }
  }

  private send(bytes: Uint8Array): void {
    const id = this.sessionId;
    if (!id || this.disposed || bytes.length === 0) return;
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK) {
      const chunk = bytes.subarray(offset, offset + INPUT_CHUNK);
      this.inputChain = this.inputChain.then(() => sessions.write(id, chunk)).catch(() => undefined);
    }
  }

  private fitNow(): void {
    // A hidden container measures as zero; fitting then would collapse the terminal.
    if (this.container.clientWidth > 0 && this.container.clientHeight > 0) this.fit.fit();
  }

  private scheduleResize(): void {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed) return;
      this.fitNow();
      const { cols, rows } = this.term;
      if (cols === this.lastSize.cols && rows === this.lastSize.rows) return;
      this.lastSize = { cols, rows };
      // Only the final size after the debounce is sent.
      if (this.sessionId) void sessions.resize(this.sessionId, cols, rows).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }

  /** Releases everything exactly once and closes the session. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.ackTimer);
    window.clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    if (this.sessionId) void sessions.close(this.sessionId).catch(() => undefined);
    this.sessionId = null;
    this.term.dispose();
  }
}

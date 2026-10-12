// Imperative owner of one xterm instance and its session. Terminal bytes never pass through
// React state: output goes native → channel → xterm, input goes xterm → native.
//
// Flow control: each chunk is acknowledged to the native side only after xterm has parsed it
// (the `write` callback). The core stops reading from the server once 1 MiB is unacknowledged,
// so a slow renderer pauses the remote producer instead of growing a queue.
//
// Remote output only ever reaches the terminal parser (INV-08). The few escape sequences that
// could cause a local effect are routed to explicit user decisions here: links need a click and
// a confirmation, OSC 52 clipboard writes need per-session consent, clipboard reads are never
// answered, and titles are sanitized text.

import "@xterm/xterm/css/xterm.css";

import type { SessionEvent, TerminalPreferences } from "@tyrminal/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITerminalOptions, Terminal } from "@xterm/xterm";

import { sessions, toAppError } from "../../lib/ipc";
import { isMac } from "../../lib/platform";
import { actionFor, bindings, matches, tabIndexFor } from "../../lib/shortcuts";
import { schemeById } from "./schemes";
import { decodeOsc52, ligatureRanges, needsPasteReview, sanitizeTitle } from "./terminalPolicy";

export type TerminalTarget = { kind: "ssh"; hostId: string } | { kind: "local" };

export type RendererKind = "webgl" | "dom";

export interface TerminalCallbacks {
  onEvent(event: SessionEvent): void;
  onTitle(title: string): void;
  /** The user clicked a link in the output. Never called by output alone. */
  onLink(url: string): void;
  /** The server asked to write `text` to the clipboard (OSC 52). */
  onClipboardWrite(text: string): void;
  /** A paste needs review before it is sent; call `confirm` to send it. */
  onPasteReview(text: string, bracketed: boolean, confirm: () => void): void;
  onRenderer(kind: RendererKind, fellBack: boolean): void;
  onResize(cols: number, rows: number): void;
  onSearchResults(index: number, total: number): void;
}

const INPUT_CHUNK = 32 * 1024;
const ACK_BATCH = 32 * 1024;
const ACK_DELAY_MS = 25;
const RESIZE_DEBOUNCE_MS = 60;
const MIN_ZOOM = -6;
const MAX_ZOOM = 12;

const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "Liberation Mono"';

/** The bundled symbol font always follows the main font so powerline and icon glyphs render. */
function fontFamily(prefs: TerminalPreferences): string {
  return prefs.fontFamily === "jetbrains-mono"
    ? `"JetBrains Mono", "Symbols Nerd Font Mono", ${SYSTEM_MONO}, monospace`
    : `${SYSTEM_MONO}, "Symbols Nerd Font Mono", monospace`;
}

export function terminalOptions(prefs: TerminalPreferences, zoom = 0): ITerminalOptions {
  const scheme = schemeById(prefs.scheme);
  return {
    allowProposedApi: true,
    scrollback: prefs.scrollback,
    cursorBlink: prefs.cursorBlink,
    cursorStyle: prefs.cursorStyle,
    cursorInactiveStyle: "outline",
    convertEol: false,
    fontFamily: fontFamily(prefs),
    fontSize: Math.max(6, prefs.fontSize + zoom),
    fontWeight: "400",
    fontWeightBold: "700",
    lineHeight: prefs.lineHeight,
    letterSpacing: prefs.letterSpacing,
    // Box-drawing and block elements are drawn as pixel-exact shapes, not font glyphs.
    customGlyphs: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    macOptionIsMeta: isMac,
    rightClickSelectsWord: isMac,
    smoothScrollDuration: 0,
    // OSC 8 hyperlinks: activation goes through the same confirmation as detected links.
    linkHandler: null,
    theme: {
      background: scheme.background,
      foreground: scheme.foreground,
      cursor: scheme.cursor,
      cursorAccent: scheme.cursorAccent,
      selectionBackground: scheme.selectionBackground,
      selectionInactiveBackground: scheme.selectionBackground,
      black: scheme.black,
      red: scheme.red,
      green: scheme.green,
      yellow: scheme.yellow,
      blue: scheme.blue,
      magenta: scheme.magenta,
      cyan: scheme.cyan,
      white: scheme.white,
      brightBlack: scheme.brightBlack,
      brightRed: scheme.brightRed,
      brightGreen: scheme.brightGreen,
      brightYellow: scheme.brightYellow,
      brightBlue: scheme.brightBlue,
      brightMagenta: scheme.brightMagenta,
      brightCyan: scheme.brightCyan,
      brightWhite: scheme.brightWhite,
    },
  };
}

/** Waits for the bundled fonts so the renderer measures the real cell size, not a fallback's. */
export async function fontsReady(prefs: TerminalPreferences): Promise<void> {
  if (prefs.fontFamily !== "jetbrains-mono" || !document.fonts) return;
  const size = `${prefs.fontSize}px`;
  await Promise.allSettled([
    document.fonts.load(`${size} "JetBrains Mono"`),
    document.fonts.load(`bold ${size} "JetBrains Mono"`),
    document.fonts.load(`${size} "Symbols Nerd Font Mono"`, ""),
  ]);
}

export class TerminalController {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon({ highlightLimit: 2000 });
  private readonly encoder = new TextEncoder();
  private readonly resizeObserver: ResizeObserver;
  private webgl: WebglAddon | null = null;
  private joiner: number | null = null;
  private renderer: RendererKind = "dom";
  private sessionId: string | null = null;
  private disposed = false;
  private pendingAck = 0;
  private ackTimer: number | undefined;
  private resizeTimer: number | undefined;
  private lastSize = { cols: 0, rows: 0 };
  private zoom = 0;
  private prefs: TerminalPreferences;
  private readonly cleanups: (() => void)[] = [];
  /** Serializes input writes so chunks of one paste arrive in order. */
  private inputChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly container: HTMLElement,
    prefs: TerminalPreferences,
    private readonly callbacks: TerminalCallbacks,
  ) {
    this.prefs = prefs;
    this.term = new Terminal(terminalOptions(prefs));
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    // Unicode 15 widths and grapheme clusters: CJK, emoji (including ZWJ sequences) and
    // combining marks take the right number of cells.
    this.term.loadAddon(new UnicodeGraphemesAddon());
    this.term.unicode.activeVersion = "15-graphemes";
    // Detected URLs: activation is a click and then a confirmation dialog (never automatic).
    this.term.loadAddon(new WebLinksAddon((event, uri) => this.activateLink(event, uri)));
    this.term.options.linkHandler = {
      activate: (event, text) => this.activateLink(event, text),
      allowNonHttpProtocols: false,
    };
    this.term.open(container);
    this.applyRenderer();
    this.applyLigatures();
    this.fitNow();

    this.term.onData((text) => this.send(this.encoder.encode(text)));
    this.term.onBinary((binary) => this.send(Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff)));
    // The remote side controls the title: treat it as untrusted text.
    this.term.onTitleChange((title) => this.callbacks.onTitle(sanitizeTitle(title)));
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => this.callbacks.onSearchResults(resultIndex + 1, resultCount));
    this.term.onSelectionChange(() => {
      if (this.prefs.copyOnSelect && this.term.hasSelection()) void this.copySelection();
    });

    // OSC 52 (clipboard). Writes go to the owner for a consent decision; a read request ("?")
    // is never answered. Returning true marks the sequence handled so nothing else acts on it.
    this.term.parser.registerOscHandler(52, (data) => {
      const decoded = decodeOsc52(data);
      if (decoded !== null) this.callbacks.onClipboardWrite(decoded);
      return true;
    });

    this.term.attachCustomKeyEventHandler((event) => this.onKey(event));

    // Pastes are reviewed before anything is sent when they span several lines or are large.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      this.pasteText(text);
    };
    const textarea = this.term.textarea;
    textarea?.addEventListener("paste", onPaste, true);
    this.cleanups.push(() => textarea?.removeEventListener("paste", onPaste, true));

    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(container);
  }

  /** Opens the session. Events (state, prompts, close) arrive through the callbacks. */
  async start(target: TerminalTarget): Promise<void> {
    await fontsReady(this.prefs);
    if (this.disposed) return;
    this.fitNow();
    const { cols, rows } = this.term;
    this.lastSize = { cols, rows };
    this.callbacks.onResize(cols, rows);
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

  get rendererKind(): RendererKind {
    return this.renderer;
  }

  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  focus(): void {
    this.term.focus();
  }

  blur(): void {
    this.term.blur();
  }

  /** Re-measures the container (for example when a hidden tab becomes visible). */
  refit(): void {
    this.scheduleResize();
  }

  /** Applies changed preferences live, keeping the session and screen. */
  updatePreferences(prefs: TerminalPreferences): void {
    const rendererChanged = prefs.renderer !== this.prefs.renderer;
    const ligaturesChanged = prefs.ligatures !== this.prefs.ligatures;
    this.prefs = prefs;
    const options = terminalOptions(prefs, this.zoom);
    for (const [key, value] of Object.entries(options)) {
      if (key === "linkHandler") continue;
      (this.term.options as Record<string, unknown>)[key] = value;
    }
    if (rendererChanged) this.applyRenderer();
    if (ligaturesChanged) this.applyLigatures();
    void fontsReady(prefs).then(() => {
      if (!this.disposed) {
        this.webgl?.clearTextureAtlas();
        this.scheduleResize();
      }
    });
  }

  setZoom(step: "in" | "out" | "reset"): void {
    this.zoom = step === "reset" ? 0 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom + (step === "in" ? 1 : -1)));
    this.term.options.fontSize = Math.max(6, this.prefs.fontSize + this.zoom);
    this.scheduleResize();
  }

  find(query: string, options: { caseSensitive: boolean; regex: boolean }, direction: "next" | "previous"): void {
    if (!query) {
      this.search.clearDecorations();
      this.callbacks.onSearchResults(0, 0);
      return;
    }
    const scheme = schemeById(this.prefs.scheme);
    const searchOptions = {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
      decorations: {
        matchBackground: scheme.selectionBackground,
        matchOverviewRuler: scheme.yellow,
        activeMatchBackground: scheme.yellow,
        activeMatchColorOverviewRuler: scheme.yellow,
      },
    };
    if (direction === "next") this.search.findNext(query, searchOptions);
    else this.search.findPrevious(query, searchOptions);
  }

  clearFind(): void {
    this.search.clearDecorations();
    this.term.clearSelection();
  }

  /** Sends text as a paste (bracketed when the remote enabled it), after review if needed. */
  pasteText(text: string): void {
    if (!text || this.disposed) return;
    const send = () => this.term.paste(text);
    if (this.prefs.confirmMultilinePaste && needsPasteReview(text)) {
      this.callbacks.onPasteReview(text, this.term.modes.bracketedPasteMode, send);
    } else {
      send();
    }
  }

  private activateLink(event: MouseEvent, uri: string): void {
    // Only a primary-button click activates; hovering or remote output never does.
    if (event.button !== 0) return;
    this.callbacks.onLink(uri);
  }

  private async copySelection(): Promise<boolean> {
    const text = this.term.getSelection();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      this.pasteText(await navigator.clipboard.readText());
    } catch {
      // Clipboard access denied by the platform: the native paste event path still works.
    }
  }

  /** Returns false for keys the terminal must not process. */
  private onKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;
    // Application shortcuts are handled by the shell before the terminal sees them.
    if (actionFor(event) || tabIndexFor(event) !== null) return false;
    if (matches(event, bindings.copy)) {
      if (this.term.hasSelection()) {
        void this.copySelection();
        return false;
      }
      // Cmd+C without a selection does nothing on macOS; Ctrl+Shift+C likewise.
      return false;
    }
    if (matches(event, bindings.paste)) {
      // Let the native paste event fire (it carries the clipboard without a permission prompt).
      return false;
    }
    // Windows/Linux: Ctrl+C copies when there is a selection, otherwise it is an interrupt.
    if (!isMac && event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "KeyC" && this.term.hasSelection()) {
      void this.copySelection().then(() => this.term.clearSelection());
      return false;
    }
    if (!isMac && event.ctrlKey && event.shiftKey && event.code === "KeyV") {
      void this.pasteFromClipboard();
      return false;
    }
    return true;
  }

  private applyRenderer(): void {
    const wanted = this.prefs.renderer === "auto";
    if (!wanted) {
      this.disposeWebgl();
      this.setRenderer("dom", false);
      return;
    }
    if (this.webgl) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // The GPU context went away (driver reset, sleep, too many contexts): fall back to the
        // DOM renderer and keep the session running.
        this.disposeWebgl();
        this.setRenderer("dom", true);
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
      this.setRenderer("webgl", false);
    } catch {
      // WebGL is unavailable in this WebView: the DOM renderer stays in place.
      this.webgl = null;
      this.setRenderer("dom", true);
    }
  }

  private disposeWebgl(): void {
    if (!this.webgl) return;
    try {
      this.webgl.dispose();
    } catch {
      // Already torn down by the context loss.
    }
    this.webgl = null;
  }

  private setRenderer(kind: RendererKind, fellBack: boolean): void {
    this.renderer = kind;
    this.container.dataset.renderer = kind;
    this.callbacks.onRenderer(kind, fellBack);
  }

  private applyLigatures(): void {
    if (this.joiner !== null) {
      this.term.deregisterCharacterJoiner(this.joiner);
      this.joiner = null;
    }
    if (this.prefs.ligatures) this.joiner = this.term.registerCharacterJoiner(ligatureRanges);
    this.term.refresh(0, this.term.rows - 1);
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
      this.callbacks.onResize(cols, rows);
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
    for (const cleanup of this.cleanups) cleanup();
    if (this.sessionId) void sessions.close(this.sessionId).catch(() => undefined);
    this.sessionId = null;
    this.disposeWebgl();
    this.term.dispose();
  }
}

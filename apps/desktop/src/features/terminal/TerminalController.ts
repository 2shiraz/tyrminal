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

import type { SessionEvent, TerminalPreferences, WorkspacePreferences } from "@tyrminal/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITerminalOptions, Terminal } from "@xterm/xterm";

import { detach, sessions, toAppError } from "../../lib/ipc";
import { isMac } from "../../lib/platform";
import { actionFor, bindings, matches, tabIndexFor } from "../../lib/shortcuts";
import type { TokenKind } from "../highlight/builtins";
import { highlightPalette } from "../highlight/palette";
import { MouseMap } from "../mouse/mouseMap";
import { type Token, tokenLinkProvider } from "../tokens/tokenLinks";
import { CommandMarks } from "./commandMarks";
import { installComposition } from "./composition";
import { SessionEncoding } from "./encoding";
import { OutputHighlighter } from "./highlight";
import { schemeById } from "./schemes";
import { decodeOsc52, ligatureRanges, needsPasteReview, parseOsc7, sanitizeTitle } from "./terminalPolicy";
import { CommandOutputs } from "./commandOutput";
import { type ScrollbackResult, searchLines } from "./scrollbackSearch";
import { attachShellContext, cdCommand, shellContexts } from "../autocomplete/shellContext";

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
  /** Bytes the user typed or pasted here (never the terminal's own replies), for broadcast. */
  onUserInput?(bytes: Uint8Array): void;
  /** Output arrived (no content: only that something was received). */
  onOutput?(): void;
  /** Typed characters the session's encoding cannot represent; they were not sent. */
  onUnencodable?(chars: string[]): void;
  /** The user clicked an address or (local terminals) a path in the output. */
  onToken?(token: Token): void;
  /** The shell reported its working directory (OSC 7), already validated. */
  onDirectory?(path: string): void;
}

const INPUT_CHUNK = 32 * 1024;
const ACK_BATCH = 32 * 1024;
const ACK_DELAY_MS = 25;
const RESIZE_DEBOUNCE_MS = 60;
/** How long a duplicated SSH tab waits for its first integrated prompt before dropping the `cd`. */
const FOLDER_WAIT_MS = 60_000;
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

/**
 * Every live terminal. The WebGL renderer shares one glyph texture atlas between terminals with
 * the same font and colours; when one of them rebuilds it (theme or font change, atlas pages
 * merged after long use, GPU memory reclaimed while the window was hidden), the others still
 * point at the old glyph positions and draw fragments of other characters. Redrawing them all
 * after any such change keeps every terminal readable.
 */
const live = new Set<TerminalController>();
let redrawFrame = 0;
let clearOnRedraw = false;

/** Redraws every terminal on the next frame, optionally rebuilding the glyph atlas first. */
function redrawAll(clearAtlas: boolean): void {
  clearOnRedraw ||= clearAtlas;
  if (redrawFrame) return;
  redrawFrame = requestAnimationFrame(() => {
    redrawFrame = 0;
    const clear = clearOnRedraw;
    clearOnRedraw = false;
    for (const controller of live) controller.redraw(clear);
  });
}

if (typeof document !== "undefined") {
  // Coming back after the window was hidden or idle: the GPU may have dropped the atlas.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") redrawAll(true);
  });
  window.addEventListener("focus", () => redrawAll(true));
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
  /** P-29: command output ranges from shell-integration marks. */
  readonly commandOutputs: CommandOutputs;
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
  /**
   * Byte counts only (never content), published on the host element for diagnostics: received
   * from the session, parsed by xterm, sent as input, and input writes the native side refused.
   */
  private readonly counters = { rx: 0, parsed: 0, tx: 0, txFailed: 0, renders: 0 };
  private fromUser = false;
  /** SSH: folder to change to at the new shell's first integrated prompt (duplicated tab). */
  private pendingFolder: { command: string; until: number } | null = null;
  /** Whether user input can be told apart from terminal replies (see the data handler). */
  broadcastable = false;
  private readonly highlighter: OutputHighlighter;
  private readonly mouse: MouseMap;
  private commands!: CommandMarks;
  private encoding = new SessionEncoding("utf-8");

  private publishCounters(): void {
    const d = this.container.dataset;
    d.rx = String(this.counters.rx);
    d.parsed = String(this.counters.parsed);
    d.tx = String(this.counters.tx);
    d.txFailed = String(this.counters.txFailed);
    d.renders = String(this.counters.renders);
    // Positions only: where parsing has moved the cursor, to compare with what is on screen.
    const b = this.term.buffer.active;
    d.cursor = `${b.type}:${b.baseY}+${b.cursorY},${b.cursorX}`;
  }

  constructor(
    private readonly container: HTMLElement,
    prefs: TerminalPreferences,
    private readonly callbacks: TerminalCallbacks,
  ) {
    this.prefs = prefs;
    this.term = new Terminal(terminalOptions(prefs));
    live.add(this);
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    // Unicode 15 widths and grapheme clusters: CJK, emoji (including ZWJ sequences) and
    // combining marks take the right number of cells.
    this.term.loadAddon(new UnicodeGraphemesAddon());
    this.term.unicode.activeVersion = "15-graphemes";
    // Detected URLs: activation is a click and then a confirmation dialog (never automatic).
    this.term.loadAddon(new WebLinksAddon((event, uri) => this.activateLink(event, uri)));
    // Addresses and (local terminals) paths: hover underlines, a click opens their menu.
    const tokens = this.term.registerLinkProvider(
      tokenLinkProvider(this.term, { paths: () => this.target?.kind === "local", onToken: (token) => this.callbacks.onToken?.(token) }),
    );
    this.cleanups.push(() => tokens.dispose());
    this.term.options.linkHandler = {
      activate: (event, text) => this.activateLink(event, text),
      allowNonHttpProtocols: false,
    };
    this.term.open(container);
    // Committed IME text sent exactly once and in order (TRM-11); xterm's own handling otherwise.
    const composition = installComposition(this.term);
    if (composition) this.cleanups.push(composition);
    container.dataset.composition = composition ? "ordered" : "xterm";
    this.highlighter = new OutputHighlighter(this.term, this.toneColors());
    this.mouse = new MouseMap(container, this.term, () => void this.pasteFromClipboard());
    this.cleanups.push(() => this.mouse.dispose());
    this.applyRenderer();
    this.applyLigatures();
    this.fitNow();

    // xterm reports user input and its own replies to terminal queries through the same data
    // event; its core flags user input synchronously just before. Only flagged data may be
    // broadcast to other panes. Without the flag, broadcast is not offered at all.
    const core = (this.term as unknown as { _core?: { coreService?: { onUserInput?: (cb: () => void) => { dispose(): void } } } })._core;
    const userInput = core?.coreService?.onUserInput?.(() => {
      this.fromUser = true;
    });
    this.broadcastable = userInput !== undefined;
    if (userInput) this.cleanups.push(() => userInput.dispose());
    this.term.onData((text) => {
      const fromUser = this.fromUser;
      this.fromUser = false;
      // Once the user types, the shell is theirs: no folder change is typed in after that.
      if (fromUser) this.pendingFolder = null;
      this.sendText(text);
      // Broadcast relays the typed text (as UTF-8); each pane encodes it for its own session.
      if (fromUser) this.callbacks.onUserInput?.(this.encoder.encode(text));
    });
    this.term.onBinary((binary) => this.send(Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff)));
    // The remote side controls the title: treat it as untrusted text.
    this.term.onTitleChange((title) => this.callbacks.onTitle(sanitizeTitle(title)));
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => this.callbacks.onSearchResults(resultIndex + 1, resultCount));
    this.term.onSelectionChange(() => {
      if (this.prefs.copyOnSelect && this.term.hasSelection()) void this.copySelection();
    });

    // Shell integration marks (OSC 7, OSC 133): folder, prompt and command boundaries. Registered
    // first: xterm calls the most recent handler first and stops at one that returns true, so the
    // handlers registered below only observe these sequences and pass them on (return false).
    this.cleanups.push(attachShellContext(this.term, () => this.sessionId));

    // OSC 52 (clipboard). Writes go to the owner for a consent decision; a read request ("?")
    // is never answered. Returning true marks the sequence handled so nothing else acts on it.
    this.term.parser.registerOscHandler(52, (data) => {
      const decoded = decodeOsc52(data);
      if (decoded !== null) this.callbacks.onClipboardWrite(decoded);
      return true;
    });
    // A duplicated SSH tab's folder: `cd` is typed in at the first marked prompt.
    // P-29: the output of each command between its shell-integration marks.
    this.commandOutputs = new CommandOutputs(this.term, () => this.sessionId);
    this.cleanups.push(() => this.commandOutputs.dispose());
    this.cleanups.push(
      shellContexts.onMark((mark) => {
        const pending = this.pendingFolder;
        if (!pending || mark.kind !== "prompt" || mark.sessionId !== this.sessionId) return;
        this.pendingFolder = null;
        if (Date.now() <= pending.until) this.send(this.encoder.encode(pending.command));
      }),
    );

    // OSC 133: command boundaries from shell integration (separators and jumping).
    this.commands = new CommandMarks(this.term, () => {
      const scheme = schemeById(this.prefs.scheme);
      return { failure: highlightPalette(scheme).danger, text: scheme.foreground };
    });
    this.cleanups.push(() => this.commands.dispose());

    // OSC 7: the shell's working directory, remembered for layout templates only.
    this.term.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7(data);
      if (path !== null) this.callbacks.onDirectory?.(path);
      // Observe only: the shell-integration handler registered earlier also needs the folder.
      return false;
    });

    this.term.attachCustomKeyEventHandler((event) => this.onKey(event));

    // Pastes are reviewed before anything is sent when they span several lines or are large.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      // The X11 primary selection after a middle click is never sent (see mouseMap.ts).
      if (this.mouse.swallowPaste()) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      this.pasteText(text);
    };
    const textarea = this.term.textarea;
    textarea?.addEventListener("paste", onPaste, true);
    this.cleanups.push(() => textarea?.removeEventListener("paste", onPaste, true));
    const rendered = this.term.onRender(() => {
      this.counters.renders += 1;
      this.publishCounters();
      this.checkCellSize();
    });
    this.cleanups.push(() => rendered.dispose());
    // A font that finishes loading later changes the cell size without resizing the container.
    const onFonts = () => this.scheduleResize();
    document.fonts?.addEventListener("loadingdone", onFonts);
    this.cleanups.push(() => document.fonts?.removeEventListener("loadingdone", onFonts));

    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(container);
  }

  /**
   * Opens the session, or with `attachToken` takes over one handed to this window (a detached
   * tab). Events (state, prompts, close) arrive through the callbacks. `startIn` (a duplicated
   * tab's folder): a local shell starts there; an SSH shell is sent `cd` to it at its first
   * prompt, and only when that prompt carries the shell integration's mark.
   */
  async start(target: TerminalTarget, startIn: string | null = null, attachToken?: string): Promise<void> {
    this.target = target;
    await fontsReady(this.prefs);
    if (this.disposed) return;
    this.fitNow();
    const { cols, rows } = this.term;
    this.lastSize = { cols, rows };
    this.callbacks.onResize(cols, rows);
    const command = target.kind === "ssh" && startIn ? cdCommand(startIn) : null;
    this.pendingFolder = command ? { command, until: Date.now() + FOLDER_WAIT_MS } : null;
    const onOutput = (bytes: Uint8Array) => this.receive(bytes);
    const onEvent = (event: SessionEvent) => {
      if (!this.disposed) this.callbacks.onEvent(event);
    };
    try {
      const opened = attachToken
        ? { sessionId: await detach.attach(attachToken, onOutput, onEvent) }
        : target.kind === "ssh"
          ? await sessions.openSsh(target.hostId, cols, rows, onOutput, onEvent)
          : await sessions.openLocal(cols, rows, onOutput, onEvent, startIn);
      if (this.disposed) {
        // Closed while opening: do not leave an orphan session behind.
        void sessions.close(opened.sessionId).catch(() => undefined);
        return;
      }
      this.sessionId = opened.sessionId;
      if (attachToken) {
        // Only connected sessions are handed over, and the handoff sends no state event; a close
        // that happened meanwhile still arrives as its own event. The size may differ here.
        this.callbacks.onEvent({ type: "state", state: "connected", hop: null });
        void sessions.resize(opened.sessionId, cols, rows).catch(() => undefined);
      }
    } catch (error) {
      const appError = toAppError(error);
      this.callbacks.onEvent({ type: "closed", error: { code: appError.code, message: appError.message }, exitStatus: null });
    }
  }

  /** P-28: matches for `query` in this terminal's scrollback (in memory only). */
  searchScrollback(query: string, caseSensitive: boolean): ScrollbackResult {
    const buffer = this.term.buffer.normal;
    return searchLines((y) => buffer.getLine(y), buffer.length, query, caseSensitive);
  }

  /** P-28: scrolls a match into view and selects it. */
  revealMatch(match: { row: number; col: number; length: number }): void {
    if (this.disposed || this.term.buffer.active.type !== "normal") return;
    this.term.scrollToLine(Math.max(0, match.row - Math.floor(this.term.rows / 2)));
    this.term.select(match.col, match.row, match.length);
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
        // The atlas is shared: every terminal redraws, not only this one.
        redrawAll(true);
        this.scheduleResize();
      }
    });
  }

  /** Highlight colors from the current scheme, each readable on its background. */
  private toneColors(): Record<TokenKind, string> {
    return highlightPalette(schemeById(this.prefs.scheme));
  }

  /** Workspace preferences: output highlighting, Option as Meta, right click. Display only. */
  setWorkspace(ws: WorkspacePreferences): void {
    this.term.options.macOptionIsMeta = isMac && ws.optionAsMeta;
    this.term.options.rightClickSelectsWord = ws.rightClickSelectsWord && !ws.rightClickPaste;
    this.mouse.update({ rightClickPaste: ws.rightClickPaste ?? false, middleClickPaste: ws.middleClickPaste ?? false });
    this.highlighter.update(ws.highlight, this.toneColors());
  }

  setZoom(step: "in" | "out" | "reset"): void {
    this.zoom = step === "reset" ? 0 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom + (step === "in" ? 1 : -1)));
    this.term.options.fontSize = Math.max(6, this.prefs.fontSize + this.zoom);
    redrawAll(true);
    this.scheduleResize();
  }

  /** Repaints every row, rebuilding the glyph atlas first when asked. */
  redraw(clearAtlas: boolean): void {
    if (this.disposed) return;
    if (clearAtlas) this.webgl?.clearTextureAtlas();
    this.term.refresh(0, this.term.rows - 1);
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

  /** Offers text for pasting, always through the paste review (a note's code block, P-30). */
  reviewPaste(text: string): void {
    if (!text || this.disposed) return;
    this.callbacks.onPasteReview(text, this.term.modes.bracketedPasteMode, () => this.term.paste(text));
  }

  /** Scrolls to the previous or next command (shell integration marks); false without one. */
  jumpCommand(direction: -1 | 1): boolean {
    return this.commands.jump(direction);
  }

  /** Copies the selection (palette action); false when nothing is selected. */
  copy(): Promise<boolean> {
    return this.copySelection();
  }

  /** Pastes the clipboard through the same review as a keyboard paste (palette action). */
  paste(): void {
    void this.pasteFromClipboard();
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
    // Keys an input method is processing (CJK composition) belong to it: no shortcut, copy or
    // paste handling here, so xterm's composition helper sees every one of them.
    if (event.isComposing || event.keyCode === 229) return true;
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
      // Another terminal sharing the atlas rebuilt or merged its pages: redraw everyone.
      addon.onChangeTextureAtlas(() => redrawAll(false));
      addon.onRemoveTextureAtlasCanvas(() => redrawAll(false));
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
    this.counters.rx += bytes.length;
    this.publishCounters();
    this.callbacks.onOutput?.();
    this.term.write(this.encoding.decode(bytes), () => {
      this.counters.parsed += bytes.length;
      this.publishCounters();
      this.acknowledge(bytes.length);
    });
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

  /** Input typed in another pane of a broadcasting tab (UTF-8 text); sent as if typed here. */
  receiveBroadcast(bytes: Uint8Array): void {
    this.sendText(new TextDecoder().decode(bytes));
  }

  /** The session's character encoding (output decoding and input encoding). */
  setEncoding(id: string): void {
    this.encoding = new SessionEncoding(id);
  }

  get encodingId(): string {
    return this.encoding.option.id;
  }

  /** Sends a command the user confirmed (for example returning to a saved directory). */
  sendConfirmedCommand(command: string): void {
    this.sendText(`${command}\r`);
  }

  private sendText(text: string): void {
    const { bytes, unsupported } = this.encoding.encode(text);
    if (unsupported.length > 0) this.callbacks.onUnencodable?.(unsupported);
    this.send(bytes);
  }

  private send(bytes: Uint8Array): void {
    const id = this.sessionId;
    if (!id || this.disposed || bytes.length === 0) return;
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK) {
      const chunk = bytes.subarray(offset, offset + INPUT_CHUNK);
      this.inputChain = this.inputChain
        .then(() => sessions.write(id, chunk))
        .then(
          () => {
            this.counters.tx += chunk.length;
            this.publishCounters();
          },
          () => {
            // The session ended or refused input; the state events report why.
            this.counters.txFailed += 1;
            this.publishCounters();
          },
        );
    }
  }

  private lastCellCheck = 0;

  /**
   * The cell size can change after the last fit (a font or renderer re-measures) while the
   * container keeps its size, so no resize is observed; the grid would then extend past the
   * visible area and hide the bottom rows. Re-fit when the current cell size calls for a
   * different grid. Rate-limited: renders are frequent during output.
   */
  private checkCellSize(): void {
    const now = performance.now();
    if (now - this.lastCellCheck < 500) return;
    this.lastCellCheck = now;
    const proposed = this.fit.proposeDimensions();
    if (proposed && (proposed.cols !== this.term.cols || proposed.rows !== this.term.rows)) this.scheduleResize();
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

  private released = false;
  private target: TerminalTarget | null = null;

  /** The session is moving to another window: disposing this terminal must not close it. */
  release(on: boolean): void {
    this.released = on;
  }

  /** Releases everything exactly once and closes the session (unless it was handed over). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    window.clearTimeout(this.ackTimer);
    window.clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    for (const cleanup of this.cleanups) cleanup();
    this.highlighter.dispose();
    if (this.sessionId && !this.released) void sessions.close(this.sessionId).catch(() => undefined);
    this.sessionId = null;
    this.disposeWebgl();
    this.term.dispose();
  }
}

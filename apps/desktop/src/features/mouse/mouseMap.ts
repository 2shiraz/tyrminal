// Mouse mappings in a terminal (TRM-08): right click and middle click can paste the clipboard.
// A paste from the mouse goes through the terminal's paste path, so the same review applies.
// While an application has asked for mouse reports (vim, htop, mc), clicks belong to it unless
// Shift is held, as with xterm's own selection override.

import type { Terminal } from "@xterm/xterm";

export interface MouseMapping {
  rightClickPaste: boolean;
  middleClickPaste: boolean;
}

/**
 * How long after a middle click a platform paste event (X11 primary selection) is ignored. The
 * platform's primary-selection paste is never sent: with the mapping off a middle click sends
 * nothing, and with it on the clipboard is pasted instead (through the review).
 */
const PRIMARY_PASTE_WINDOW_MS = 500;

export class MouseMap {
  private mapping: MouseMapping = { rightClickPaste: false, middleClickPaste: false };
  private swallowUntil = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly term: Terminal,
    private readonly paste: () => void,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
      container.addEventListener(type, handler, true);
      this.cleanups.push(() => container.removeEventListener(type, handler, true));
    };
    on("mousedown", (event) => {
      if (event.button !== 1) return;
      this.swallowUntil = performance.now() + PRIMARY_PASTE_WINDOW_MS;
      if (!this.mapping.middleClickPaste || !this.ours(event)) return;
      // No autoscroll: the clipboard is pasted instead of the primary selection.
      event.preventDefault();
      event.stopPropagation();
      this.term.focus();
      this.paste();
    });
    on("auxclick", (event) => {
      if (event.button === 1 && this.mapping.middleClickPaste && this.ours(event)) event.preventDefault();
    });
    on("contextmenu", (event) => {
      if (!this.mapping.rightClickPaste || !this.ours(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.term.focus();
      this.paste();
    });
  }

  update(mapping: MouseMapping): void {
    this.mapping = mapping;
    // Which mappings are on, for tests and diagnostics (no content).
    this.container.dataset.mouse = [mapping.rightClickPaste && "right-paste", mapping.middleClickPaste && "middle-paste"].filter(Boolean).join(" ") || "default";
  }

  /** True for a platform paste event caused by a middle click (the X11 primary selection). */
  swallowPaste(): boolean {
    return performance.now() < this.swallowUntil;
  }

  /** A click is the mapping's unless an application asked for mouse reports (Shift overrides). */
  private ours(event: MouseEvent): boolean {
    return this.term.modes.mouseTrackingMode === "none" || event.shiftKey;
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
  }
}

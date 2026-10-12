// Input method composition (TRM-11). xterm reads committed text from its hidden textarea a tick
// after `compositionend`, using offsets recorded earlier. When the next key arrives before that
// tick (Chromium runs input before timers) or the textarea is cleared meanwhile (xterm clears it
// on Enter and Ctrl+C), committed text is sent twice, partly, or not at all.
//
// This replaces the composition methods of xterm's helper instance with a deterministic version:
// the committed text is everything the textarea gained since the composition started, and it is
// sent at the first of: the next composition starting, the next key, the textarea losing focus,
// or one tick after `compositionend`, exactly once. The preedit is never sent. If the helper is
// not found (a different xterm build), xterm's own handling stays in place.

import type { Terminal } from "@xterm/xterm";

interface Helper {
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  _isComposing: boolean;
  _isSendingComposition: boolean;
  compositionstart(): void;
  compositionupdate(ev: Pick<CompositionEvent, "data">): void;
  compositionend(): void;
  keydown(ev: KeyboardEvent): boolean;
  updateCompositionElements(dontRecurse?: boolean): void;
}

const IME_KEYS = new Set([229, 20, 16, 17, 18]);

function helperOf(term: Terminal): Helper | null {
  const core = (term as unknown as { _core?: { _compositionHelper?: Partial<Helper> } })._core;
  const h = core?._compositionHelper;
  const ok =
    h &&
    h._textarea instanceof HTMLTextAreaElement &&
    h._compositionView instanceof HTMLElement &&
    typeof h._coreService?.triggerDataEvent === "function" &&
    typeof h.updateCompositionElements === "function";
  return ok ? (h as Helper) : null;
}

/** Installs the composition handling on an opened terminal; returns a cleanup, or null if not installed. */
export function installComposition(term: Terminal): (() => void) | null {
  const helper = helperOf(term);
  if (!helper) return null;
  const textarea = helper._textarea;
  const view = helper._compositionView;
  const send = (text: string) => {
    if (text) helper._coreService.triggerDataEvent(text, true);
  };

  /** Where the current composition began in the textarea. */
  let start = 0;
  /** A finished composition whose text has not been sent yet: where it began. */
  let pending: number | null = null;
  let timer: number | undefined;

  const flush = (upTo?: number) => {
    window.clearTimeout(timer);
    timer = undefined;
    if (pending === null) return;
    const from = pending;
    pending = null;
    helper._isSendingComposition = false;
    send(textarea.value.slice(from, upTo));
  };

  helper.compositionstart = () => {
    // The previous composition's text is all in the textarea by now.
    flush();
    helper._isComposing = true;
    start = textarea.value.length;
    view.textContent = "";
    view.classList.add("active");
  };

  helper.compositionupdate = (ev) => {
    view.textContent = ev.data;
    helper.updateCompositionElements();
  };

  helper.compositionend = () => {
    view.classList.remove("active");
    helper._isComposing = false;
    pending = start;
    helper._isSendingComposition = true;
    // Some engines update the textarea after compositionend: read it once that has happened.
    window.clearTimeout(timer);
    timer = window.setTimeout(() => flush(), 0);
  };

  helper.keydown = (ev) => {
    if (helper._isComposing) {
      if (IME_KEYS.has(ev.keyCode)) return false;
      // A key the input method did not take ends the composition with what is there.
      helper.compositionend();
    }
    // The committed text goes before this key's own input, in order.
    flush();
    if (ev.keyCode === 229) {
      // The input method is active but inserted plain text (digits, punctuation): send what the
      // textarea gained once the browser has applied it.
      const before = textarea.value;
      window.setTimeout(() => {
        if (helper._isComposing) return;
        const after = textarea.value;
        if (after.length > before.length && after.startsWith(before)) send(after.slice(before.length));
        else if (after.length < before.length) send("\u007f");
      }, 0);
      return false;
    }
    return true;
  };

  // xterm empties the textarea when it loses focus: send a finished composition first.
  const onBlur = () => flush();
  textarea.addEventListener("blur", onBlur, true);
  return () => {
    window.clearTimeout(timer);
    textarea.removeEventListener("blur", onBlur, true);
  };
}

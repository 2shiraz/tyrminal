// Selection in a file list, shared by the Files panel and the SFTP tab: click, Shift for a
// range, Ctrl/Cmd to toggle, arrow keys to move (Shift extends), Space to toggle. Pure functions
// over the names in display order, so the owner keeps the state wherever it likes.

import type { RemoteEntry } from "@tyrminal/contracts";

export interface Selection {
  /** Selected names. */
  names: string[];
  /** Where a Shift range starts. */
  anchor: string | null;
  /** The row the keyboard is on. */
  cursor: string | null;
}

export const NO_SELECTION: Selection = { names: [], anchor: null, cursor: null };

export function single(name: string): Selection {
  return { names: [name], anchor: name, cursor: name };
}

function range(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** A click on `name`. `toggle` is Ctrl (Cmd on macOS); `extend` is Shift. */
export function clickSelect(selection: Selection, order: string[], name: string, mods: { toggle: boolean; extend: boolean }): Selection {
  if (mods.extend && selection.anchor) return { names: range(order, selection.anchor, name), anchor: selection.anchor, cursor: name };
  if (mods.toggle) {
    const has = selection.names.includes(name);
    return { names: has ? selection.names.filter((n) => n !== name) : [...selection.names, name], anchor: name, cursor: name };
  }
  return single(name);
}

/** Arrow keys, Home/End (Shift extends from the anchor) and Space (toggles the cursor row). */
export function keySelect(selection: Selection, order: string[], key: string, extend: boolean): Selection | null {
  if (order.length === 0) return null;
  if (key === " ") {
    const at = selection.cursor ?? order[0];
    if (!at) return null;
    const has = selection.names.includes(at);
    return { names: has ? selection.names.filter((n) => n !== at) : [...selection.names, at], anchor: at, cursor: at };
  }
  const index = selection.cursor ? order.indexOf(selection.cursor) : -1;
  let next: number;
  switch (key) {
    case "ArrowDown":
      next = index < 0 ? 0 : Math.min(order.length - 1, index + 1);
      break;
    case "ArrowUp":
      next = index < 0 ? 0 : Math.max(0, index - 1);
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = order.length - 1;
      break;
    default:
      return null;
  }
  const name = order[next] as string;
  if (extend) {
    const anchor = selection.anchor ?? name;
    return { names: range(order, anchor, name), anchor, cursor: name };
  }
  return single(name);
}

/** Drops names no longer listed (after a refresh). */
export function pruneSelection(selection: Selection, order: string[]): Selection {
  const names = selection.names.filter((n) => order.includes(n));
  if (names.length === selection.names.length && (!selection.cursor || order.includes(selection.cursor))) return selection;
  return {
    names,
    anchor: selection.anchor && order.includes(selection.anchor) ? selection.anchor : null,
    cursor: selection.cursor && order.includes(selection.cursor) ? selection.cursor : null,
  };
}

/** "3 selected · 12 KB" (sizes of files only), or the item count when nothing is selected. */
export function selectionSummary(entries: RemoteEntry[], names: string[], formatSize: (n: number) => string): string {
  if (names.length === 0) return entries.length === 1 ? "1 item" : `${entries.length.toLocaleString()} items`;
  const chosen = entries.filter((e) => names.includes(e.name));
  const bytes = chosen.reduce((sum, e) => sum + (e.kind === "dir" ? 0 : (e.size ?? 0)), 0);
  const folders = chosen.some((e) => e.kind === "dir");
  return `${names.length.toLocaleString()} selected · ${formatSize(bytes)}${folders ? " + folders" : ""}`;
}

/** Is the platform's "toggle" modifier down (Cmd on macOS, Ctrl elsewhere)? */
export function toggleKey(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
}

/**
 * Immediate pressed feedback: the row is marked on pointer down and stays marked for at least
 * `PRESS_MS`, so even a quick click is visibly registered.
 */
export const PRESS_MS = 100;

export function pressFeedback(element: HTMLElement) {
  const started = performance.now();
  element.dataset.pressed = "true";
  const release = () => {
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    const left = Math.max(0, PRESS_MS - (performance.now() - started));
    window.setTimeout(() => delete element.dataset.pressed, left);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}

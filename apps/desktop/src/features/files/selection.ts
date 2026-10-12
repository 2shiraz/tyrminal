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

// Immediate pressed feedback now lives in lib/press.ts and covers every pressable element.
export { PRESS_MS, pressFeedback } from "../../lib/press";

/** How long typed letters keep adding to one type-ahead search. */
export const TYPE_AHEAD_MS = 800;

/**
 * Type-ahead: the first name (in display order) that starts with what was typed, case-
 * insensitively. The same letter typed again moves to the next name starting with it, as in
 * Finder and Explorer. Null when nothing matches.
 */
export function typeAhead(order: string[], cursor: string | null, typed: string): string | null {
  const needle = typed.toLowerCase();
  if (!needle) return null;
  const repeat = needle.length > 1 && [...needle].every((c) => c === needle[0]);
  const prefix = repeat ? (needle[0] as string) : needle;
  const at = cursor ? order.indexOf(cursor) : -1;
  // A new search includes the current row; a repeated letter starts after it.
  const start = repeat || needle.length === 1 ? at + 1 : Math.max(0, at);
  for (let i = 0; i < order.length; i++) {
    const name = order[(start + i) % order.length] as string;
    if (name.toLowerCase().startsWith(prefix)) return name;
  }
  return null;
}

// Platform keyboard shortcuts. macOS uses Cmd, which terminals never receive. Windows and Linux
// use Ctrl+Shift (or Alt) combinations, so plain Ctrl+letter keys keep their terminal meaning
// (Ctrl+C interrupt, Ctrl+K kill line, Ctrl+W delete word, ...). The application handles a
// binding before the terminal sees the key; nothing else is intercepted.

import { isMac, keyLabels } from "./platform";

export type ActionId =
  | "palette"
  | "newLocal"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "find"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "nextTab"
  | "prevTab"
  | "focusLeft"
  | "focusRight"
  | "focusUp"
  | "focusDown"
  | "toggleSnippets"
  | "toggleFiles"
  | "toggleSidebar"
  | "settings"
  | "lock"
  | "renameTab"
  | "copy"
  | "paste"
  // agent D: inventory and snippets
  | "suggest"
  // privilege prompts (KEY-18)
  | "insertPassword";

export interface Binding {
  key: string;
  mod?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const mac: Record<ActionId, Binding> = {
  palette: { key: "k", mod: true },
  newLocal: { key: "t", mod: true },
  closePane: { key: "w", mod: true },
  splitRight: { key: "d", mod: true },
  splitDown: { key: "d", mod: true, shift: true },
  find: { key: "f", mod: true },
  zoomIn: { key: "=", mod: true },
  zoomOut: { key: "-", mod: true },
  zoomReset: { key: "0", mod: true },
  nextTab: { key: "]", mod: true, shift: true },
  prevTab: { key: "[", mod: true, shift: true },
  focusLeft: { key: "ArrowLeft", mod: true, alt: true },
  focusRight: { key: "ArrowRight", mod: true, alt: true },
  focusUp: { key: "ArrowUp", mod: true, alt: true },
  focusDown: { key: "ArrowDown", mod: true, alt: true },
  toggleSnippets: { key: "s", mod: true, shift: true },
  toggleFiles: { key: "o", mod: true, shift: true },
  toggleSidebar: { key: "b", mod: true },
  settings: { key: ",", mod: true },
  lock: { key: "l", mod: true, shift: true },
  renameTab: { key: "r", mod: true, shift: true },
  copy: { key: "c", mod: true },
  paste: { key: "v", mod: true },
  // agent D: inventory and snippets
  suggest: { key: "e", mod: true, shift: true },
  // privilege prompts (KEY-18)
  insertPassword: { key: "p", mod: true, shift: true },
};

const other: Record<ActionId, Binding> = {
  palette: { key: "k", ctrl: true, shift: true },
  newLocal: { key: "t", ctrl: true, shift: true },
  closePane: { key: "w", ctrl: true, shift: true },
  splitRight: { key: "=", alt: true, shift: true },
  splitDown: { key: "-", alt: true, shift: true },
  find: { key: "f", ctrl: true, shift: true },
  zoomIn: { key: "=", ctrl: true },
  zoomOut: { key: "-", ctrl: true },
  zoomReset: { key: "0", ctrl: true },
  nextTab: { key: "Tab", ctrl: true },
  prevTab: { key: "Tab", ctrl: true, shift: true },
  focusLeft: { key: "ArrowLeft", alt: true },
  focusRight: { key: "ArrowRight", alt: true },
  focusUp: { key: "ArrowUp", alt: true },
  focusDown: { key: "ArrowDown", alt: true },
  toggleSnippets: { key: "s", ctrl: true, shift: true },
  toggleFiles: { key: "o", ctrl: true, shift: true },
  toggleSidebar: { key: "b", ctrl: true, shift: true },
  settings: { key: ",", ctrl: true },
  lock: { key: "l", ctrl: true, shift: true },
  renameTab: { key: "r", ctrl: true, shift: true },
  copy: { key: "c", ctrl: true, shift: true },
  paste: { key: "v", ctrl: true, shift: true },
  // agent D: inventory and snippets
  suggest: { key: "e", ctrl: true, shift: true },
  // privilege prompts (KEY-18)
  insertPassword: { key: "p", ctrl: true, shift: true },
};

export const bindings: Record<ActionId, Binding> = isMac ? mac : other;

/** Bindings the terminal must never receive (copy/paste are handled inside the terminal). */
export const appActions = (Object.keys(bindings) as ActionId[]).filter((a) => a !== "copy" && a !== "paste");

function normalizeKey(event: KeyboardEvent): string {
  // With Shift held, "=" arrives as "+" and "-" as "_" on US layouts; compare the physical key.
  if (event.code === "Equal") return "=";
  if (event.code === "Minus") return "-";
  if (event.code === "BracketLeft") return "[";
  if (event.code === "BracketRight") return "]";
  if (event.code === "Comma") return ",";
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function matches(event: KeyboardEvent, binding: Binding): boolean {
  const mod = isMac ? event.metaKey : false;
  const wantCtrl = Boolean(binding.ctrl) || (!isMac && Boolean(binding.mod));
  return (
    normalizeKey(event) === binding.key &&
    Boolean(binding.mod && isMac) === mod &&
    wantCtrl === event.ctrlKey &&
    Boolean(binding.shift) === event.shiftKey &&
    Boolean(binding.alt) === event.altKey &&
    (isMac || !event.metaKey)
  );
}

export function actionFor(event: KeyboardEvent): ActionId | null {
  for (const action of appActions) {
    if (matches(event, bindings[action])) return action;
  }
  return null;
}

/** Tab N (1–9): Cmd+N on macOS, Alt+N elsewhere. Returns the zero-based index or null. */
export function tabIndexFor(event: KeyboardEvent): number | null {
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
  if (!digit) return null;
  const ok = isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  return ok ? Number(digit) - 1 : null;
}

const KEY_NAMES: Record<string, string> = isMac
  ? { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Tab: "⇥", "=": "=", "-": "−" }
  : { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Tab: "Tab", "=": "+", "-": "−" };

/** Key caps for display, e.g. ["⌘", "K"] or ["Ctrl", "Shift", "K"]. */
export function keyCaps(binding: Binding): string[] {
  const caps: string[] = [];
  if (binding.ctrl) caps.push(keyLabels.ctrl);
  if (binding.alt) caps.push(keyLabels.alt);
  if (binding.shift) caps.push(keyLabels.shift);
  if (binding.mod) caps.push(keyLabels.mod);
  caps.push(KEY_NAMES[binding.key] ?? binding.key.toUpperCase());
  return caps;
}

export function shortcutText(action: ActionId): string {
  return keyCaps(bindings[action]).join(isMac ? "" : "+");
}

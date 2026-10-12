// Platform keyboard shortcuts. macOS uses Cmd, which terminals never receive. Windows and Linux
// use Ctrl+Shift (or Alt) combinations, so plain Ctrl+letter keys keep their terminal meaning
// (Ctrl+C interrupt, Ctrl+K kill line, Ctrl+W delete word, ...). The application handles a
// binding before the terminal sees the key; nothing else is intercepted.

import type { KeyBindingPreference } from "@tyrminal/contracts";

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
  // agent C: workspaces
  | "toggleFocusLayout"
  | "movePaneLeft"
  | "movePaneRight"
  | "movePaneUp"
  | "movePaneDown"
  // terminal input: jump between commands (shell integration marks)
  | "previousCommand"
  | "nextCommand"
  // agent D: inventory and snippets
  | "suggest";

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
  // agent C: workspaces
  toggleFocusLayout: { key: "Enter", mod: true, shift: true },
  movePaneLeft: { key: "ArrowLeft", mod: true, alt: true, shift: true },
  movePaneRight: { key: "ArrowRight", mod: true, alt: true, shift: true },
  movePaneUp: { key: "ArrowUp", mod: true, alt: true, shift: true },
  movePaneDown: { key: "ArrowDown", mod: true, alt: true, shift: true },
  // terminal input: jump between commands
  previousCommand: { key: "ArrowUp", mod: true },
  nextCommand: { key: "ArrowDown", mod: true },
  // agent D: inventory and snippets
  suggest: { key: "e", mod: true, shift: true },
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
  // agent C: workspaces
  toggleFocusLayout: { key: "Enter", ctrl: true, shift: true },
  movePaneLeft: { key: "ArrowLeft", alt: true, shift: true },
  movePaneRight: { key: "ArrowRight", alt: true, shift: true },
  movePaneUp: { key: "ArrowUp", alt: true, shift: true },
  movePaneDown: { key: "ArrowDown", alt: true, shift: true },
  // terminal input: jump between commands
  previousCommand: { key: "ArrowUp", ctrl: true, shift: true },
  nextCommand: { key: "ArrowDown", ctrl: true, shift: true },
  // agent D: inventory and snippets
  suggest: { key: "e", ctrl: true, shift: true },
};

/** The current bindings: the platform defaults with the user's replacements applied (see below). */
export const bindings: Record<ActionId, Binding> = { ...(isMac ? mac : other) };
export const defaultBindings: Readonly<Record<ActionId, Binding>> = { ...(isMac ? mac : other) };

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
  if (recordingShortcut) return null;
  for (const action of appActions) {
    if (matches(event, bindings[action])) return action;
  }
  return null;
}

/** Tab N (1–9): Cmd+N on macOS, Alt+N elsewhere. Returns the zero-based index or null. */
export function tabIndexFor(event: KeyboardEvent): number | null {
  if (recordingShortcut) return null;
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
  if (!digit) return null;
  const ok = isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  return ok ? Number(digit) - 1 : null;
}

const KEY_NAMES: Record<string, string> = isMac
  ? { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Tab: "⇥", "=": "=", "-": "−", Enter: "↩" }
  : { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Tab: "Tab", "=": "+", "-": "−", Enter: "Enter" };

/** Key caps for display, e.g. ["⌘", "K"] or ["Ctrl", "Shift", "K"]. */
export function keyCaps(binding: Binding): string[] {
  if (binding.key === "") return ["—"];
  const caps: string[] = [];
  if (binding.ctrl) caps.push(keyLabels.ctrl);
  if (binding.alt) caps.push(keyLabels.alt);
  if (binding.shift) caps.push(keyLabels.shift);
  if (binding.mod) caps.push(keyLabels.mod);
  caps.push(KEY_NAMES[binding.key] ?? binding.key.toUpperCase());
  return caps;
}

// agent C: workspaces — keyboard customization (TRM-08, WSP-13)

/** While a new shortcut is being recorded, no key press runs an action. */
let recordingShortcut = false;
export function setRecordingShortcut(on: boolean): void {
  recordingShortcut = on;
}

/** An action the user left without a shortcut: its key never matches. */
const UNBOUND: Binding = { key: "" };

export function isUnbound(binding: Binding): boolean {
  return binding.key === "";
}

/** A binding with only the modifiers that are held (absent rather than false). */
function make(key: string, mods: { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean }): Binding {
  const b: Binding = { key };
  if (mods.mod) b.mod = true;
  if (mods.ctrl) b.ctrl = true;
  if (mods.alt) b.alt = true;
  if (mods.shift) b.shift = true;
  return b;
}

export function fromPreference(p: KeyBindingPreference): Binding {
  if (p.key === null) return UNBOUND;
  // On macOS "meta" is Cmd (the `mod` modifier); elsewhere the shortcut layer has no Meta.
  return make(p.key, { mod: isMac && p.meta, ctrl: p.ctrl, alt: p.alt, shift: p.shift });
}

export function toPreference(action: ActionId, b: Binding): KeyBindingPreference {
  if (isUnbound(b)) return { action, key: null, ctrl: false, alt: false, shift: false, meta: false };
  return { action, key: b.key, ctrl: Boolean(b.ctrl) || (!isMac && Boolean(b.mod)), alt: Boolean(b.alt), shift: Boolean(b.shift), meta: isMac && Boolean(b.mod) };
}

/** Replaces the current bindings with the defaults plus `overrides` (unknown actions ignored). */
export function applyBindingOverrides(overrides: readonly KeyBindingPreference[]): void {
  for (const action of Object.keys(defaultBindings) as ActionId[]) bindings[action] = defaultBindings[action];
  for (const o of overrides) {
    if (o.action in defaultBindings) bindings[o.action as ActionId] = fromPreference(o);
  }
}

const same = (a: Binding, b: Binding) =>
  a.key === b.key && Boolean(a.mod) === Boolean(b.mod) && Boolean(a.ctrl) === Boolean(b.ctrl) && Boolean(a.alt) === Boolean(b.alt) && Boolean(a.shift) === Boolean(b.shift);

/** Keys a shortcut can use (the same list is checked natively). */
const NAMED_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab", "Enter", "Home", "End", "PageUp", "PageDown"]);
for (let i = 1; i <= 12; i++) NAMED_KEYS.add(`F${i}`);

function bindableKey(key: string): boolean {
  if ([...key].length === 1) return /^[\x21-\x7e]$/.test(key) && !/[A-Z]/.test(key);
  return NAMED_KEYS.has(key);
}

export type ReservedReason = "quit" | "hide" | "minimize" | "switchApps" | "switchWindows" | "lockScreen" | "fullScreen" | "screenshot" | "closeWindow" | "tabNumber";

type Chord = [key: string, mods: string, reason: ReservedReason];

// Chords the operating system (or the window manager) takes before the application sees them,
// and Cmd/Alt+1–9, which switch tabs. Modifiers: c = Ctrl, a = Alt/Option, s = Shift, m = Cmd.
const RESERVED: readonly Chord[] = isMac
  ? [
      ["q", "m", "quit"],
      ["h", "m", "hide"],
      ["h", "am", "hide"],
      ["m", "m", "minimize"],
      ["Tab", "m", "switchApps"],
      ["Tab", "sm", "switchApps"],
      ["`", "m", "switchWindows"],
      ["`", "sm", "switchWindows"],
      ["q", "cm", "lockScreen"],
      ["f", "cm", "fullScreen"],
      ["3", "sm", "screenshot"],
      ["4", "sm", "screenshot"],
      ["5", "sm", "screenshot"],
    ]
  : [
      ["F4", "a", "closeWindow"],
      ["Tab", "a", "switchWindows"],
      ["Tab", "as", "switchWindows"],
      ["l", "ca", "lockScreen"],
    ];

function mods(b: Binding): string {
  return `${b.ctrl ? "c" : ""}${b.alt ? "a" : ""}${b.shift ? "s" : ""}${b.mod ? "m" : ""}`;
}

/** Why the system or the tab-number keys keep `b`, or null. */
export function reservedReason(b: Binding): ReservedReason | null {
  const m = mods(b);
  if (/^[1-9]$/.test(b.key) && m === (isMac ? "m" : "a")) return "tabNumber";
  return RESERVED.find(([key, chordMods]) => key === b.key && chordMods === m)?.[2] ?? null;
}

export type BindingProblem =
  | { kind: "terminal" }
  | { kind: "key" }
  | { kind: "reserved"; reason: ReservedReason }
  | { kind: "conflict"; other: ActionId };

/**
 * Why `candidate` cannot be the shortcut for `action`, or null. The terminal keeps its keys: a
 * shortcut needs Ctrl, Alt or Cmd, and Ctrl with a single key (Ctrl+C interrupt, Ctrl+D end of
 * input, ...) is never taken. Chords the system keeps are refused with the reason. The same
 * rules are enforced natively; a conflict is reported so the caller can offer a swap.
 */
export function bindingProblem(action: ActionId, candidate: Binding): BindingProblem | null {
  if (isUnbound(candidate)) return null;
  if (!bindableKey(candidate.key)) return { kind: "key" };
  const hasMod = Boolean(candidate.mod) || Boolean(candidate.ctrl) || Boolean(candidate.alt);
  if (!hasMod) return { kind: "terminal" };
  if (candidate.ctrl && !candidate.alt && !candidate.shift && !candidate.mod) return { kind: "terminal" };
  const reason = reservedReason(candidate);
  if (reason) return { kind: "reserved", reason };
  for (const other of Object.keys(bindings) as ActionId[]) {
    if (other !== action && same(bindings[other], candidate)) return { kind: "conflict", other };
  }
  return null;
}

/** True when `a` and `b` are the same chord. */
export function sameBinding(a: Binding, b: Binding): boolean {
  return same(a, b);
}

/** The binding a key press describes (for recording a new shortcut). */
export function bindingFromEvent(event: KeyboardEvent): Binding | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"].includes(event.key)) return null;
  const key = normalizeKey(event);
  if (!key || key === "Escape" || key === "Dead") return null;
  if (!isMac && event.metaKey) return null;
  return make(key, { mod: isMac && event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey });
}

export function shortcutText(action: ActionId): string {
  return keyCaps(bindings[action]).join(isMac ? "" : "+");
}

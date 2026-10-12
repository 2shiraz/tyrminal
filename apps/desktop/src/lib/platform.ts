// Platform conventions for shortcuts and labels. Detection uses the user agent only to pick
// keyboard conventions; it is never used for a security decision.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Display names for modifier keys on this platform. */
export const keyLabels = isMac
  ? { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↩", esc: "esc" }
  : { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", esc: "Esc" };

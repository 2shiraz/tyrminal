// What Settings contains, for its navigation and its search: the sections in order (with their
// nav group) and every setting row (section, group inside the section, label, hint, anchor id).
// Built from the same message strings the rows show, so search always finds what is on screen.

import { msg } from "../../lib/messages";
import { msgB } from "../../lib/messages-b";
import { msgC } from "../../lib/messages-c";
import { msgN } from "../../lib/messages-notify";
import { msgPC } from "../../lib/messages-password-check";
import { msgProduction } from "../../lib/messages-production";
import { msgSettings } from "./messages";

export type Section = "appearance" | "terminal" | "shortcuts" | "highlight" | "security" | "review" | "password" | "backup" | "privacy" | "about";
export type NavGroup = keyof typeof msgSettings.groups;

export const SECTIONS: { id: Section; group: NavGroup; label: string }[] = [
  { id: "appearance", group: "general", label: msgSettings.sections.appearance },
  { id: "terminal", group: "general", label: msgSettings.sections.terminal },
  { id: "shortcuts", group: "general", label: msgSettings.sections.shortcuts },
  { id: "highlight", group: "general", label: msgSettings.sections.highlight },
  { id: "security", group: "security", label: msgSettings.sections.security },
  { id: "review", group: "security", label: msgSettings.sections.review },
  { id: "password", group: "security", label: msgSettings.sections.password },
  { id: "backup", group: "data", label: msgSettings.sections.backup },
  { id: "privacy", group: "data", label: msgSettings.sections.privacy },
  { id: "about", group: "data", label: msgSettings.sections.about },
];

export interface IndexEntry {
  section: Section;
  /** The group inside the section. */
  group: string;
  label: string;
  hint?: string;
  /** The row's anchor (`data-setting`); search focuses it. */
  id: string;
}

const s = msg.settings;
const m = msgSettings;
export const SETTINGS_INDEX: IndexEntry[] = [
  { section: "appearance", group: m.theme, label: m.colourTheme, id: "colour-theme" },
  { section: "appearance", group: m.theme, label: m.themeMode, hint: m.themeModeHint, id: "theme" },
  { section: "appearance", group: m.motion, label: s.reduceMotion, hint: s.reduceMotionHint, id: "reduce-motion" },
  { section: "terminal", group: m.colourScheme, label: s.scheme, id: "scheme" },
  { section: "terminal", group: m.text, label: s.font, id: "font" },
  { section: "terminal", group: m.text, label: s.fontSize, id: "font-size" },
  { section: "terminal", group: m.text, label: s.lineHeight, id: "line-height" },
  { section: "terminal", group: m.text, label: s.letterSpacing, id: "letter-spacing" },
  { section: "terminal", group: m.text, label: s.padding, id: "padding" },
  { section: "terminal", group: m.text, label: s.ligatures, hint: s.ligaturesHint, id: "ligatures" },
  { section: "terminal", group: m.cursor, label: s.cursor, id: "cursor-style" },
  { section: "terminal", group: m.cursor, label: s.cursorBlink, id: "cursor-blink" },
  { section: "terminal", group: m.behaviour, label: s.scrollback, hint: s.scrollbackHint, id: "scrollback" },
  { section: "terminal", group: m.behaviour, label: s.renderer, hint: s.rendererHint, id: "renderer" },
  { section: "terminal", group: m.behaviour, label: s.confirmPaste, hint: s.confirmPasteHint, id: "confirm-paste" },
  { section: "terminal", group: m.behaviour, label: s.confirmOpen, hint: s.confirmOpenHint, id: "confirm-open" },
  { section: "terminal", group: m.behaviour, label: s.confirmProductionOpen, hint: s.confirmProductionOpenHint, id: "confirm-production-open" },
  { section: "terminal", group: m.behaviour, label: s.confirmRun, hint: s.confirmRunHint, id: "confirm-run" },
  { section: "terminal", group: m.behaviour, label: s.copyOnSelect, id: "copy-on-select" },
  { section: "terminal", group: m.behaviour, label: msgN.settingTitle, hint: msgN.settingHint, id: "command-notifications" },
  { section: "terminal", group: m.localShellAndEditors, label: s.localShell, hint: s.localShellHint, id: "local-shell" },
  { section: "terminal", group: m.localShellAndEditors, label: s.editors, hint: s.editorsHint, id: "editors" },
  { section: "shortcuts", group: msgC.keys.title, label: msgC.keys.title, hint: msgC.keys.body, id: "shortcuts" },
  { section: "highlight", group: msgC.highlight.title, label: msgC.highlight.enabled, hint: msgC.highlight.body, id: "highlight" },
  { section: "security", group: m.passphrase, label: m.passphraseRow, hint: m.passphraseHint, id: "passphrase" },
  { section: "security", group: m.passphrase, label: m.recoveryRow, hint: m.recoveryHint, id: "recovery-key" },
  { section: "security", group: m.quickUnlock, label: msg.quickUnlock.title, hint: msg.quickUnlock.body, id: "quick-unlock" },
  { section: "security", group: m.production, label: msgProduction.settingTag, hint: msgProduction.settingTagHint, id: "production-tag" },
  { section: "password", group: msgPC.title, label: msgPC.enable, hint: msgPC.body, id: "password-check" },
  { section: "backup", group: m.backupGroup, label: m.exportRow, hint: m.exportHint, id: "export" },
  { section: "backup", group: m.backupGroup, label: m.restoreRow, hint: m.restoreHint, id: "restore" },
  { section: "privacy", group: m.diagnostics, label: s.diagnostics, hint: s.diagnosticsHint, id: "diagnostics" },
  { section: "privacy", group: m.connections, label: msgB.quick.setting, hint: msgB.quick.settingHint, id: "port-suggestions" },
  { section: "privacy", group: m.updates, label: s.updates, id: "updates" },
  { section: "about", group: msg.about.title, label: msg.about.version, id: "version" },
];

/** Settings rows matching every word of `query` (label, hint, group or section name). */
export function searchSettings(query: string): IndexEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const sectionLabel = (id: Section) => SECTIONS.find((x) => x.id === id)?.label ?? "";
  return SETTINGS_INDEX.filter((e) => {
    const text = `${e.label} ${e.hint ?? ""} ${e.group} ${sectionLabel(e.section)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// A section asked for from elsewhere (the palette's "Keyboard shortcuts"): shown at once when
// Settings is open, otherwise when it next opens.
let requested: Section | null = null;
let listener: ((section: Section) => void) | null = null;
export function requestSection(section: Section): void {
  if (listener) listener(section);
  else requested = section;
}
export function takeRequestedSection(): Section | null {
  const r = requested;
  requested = null;
  return r;
}
/** Settings, while open, shows requested sections itself. Returns the unsubscribe. */
export function onSectionRequest(show: (section: Section) => void): () => void {
  listener = show;
  return () => {
    if (listener === show) listener = null;
  };
}

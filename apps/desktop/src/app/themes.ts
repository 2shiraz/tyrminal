// Application color themes. The values that style the interface live in styles/tokens.css, one
// block per theme and mode (the default theme is the plain :root block; the others are selected by
// data-palette on the root element). This list names them for Settings and carries four colors per
// mode for the picker's preview; scripts/check-contrast.mjs fails if a preview color differs from
// the token it stands for. Terminal color schemes are separate (features/terminal/schemes.ts).

export interface ThemePreview {
  canvas: string;
  frame: string;
  surface: string;
  text: string;
  accent: string;
}

export interface AppTheme {
  id: string;
  name: string;
  /** One short phrase for the picker, describing the look rather than selling it. */
  note: string;
  dark: ThemePreview;
  light: ThemePreview;
}

/** The theme used until the user chooses another; the same id as the core's DEFAULT_PALETTE. */
export const DEFAULT_APP_THEME = "cobalt";

export const APP_THEMES: readonly AppTheme[] = [
  {
    id: "cobalt",
    name: "Cobalt",
    note: "Blue-black ink, azure accent",
    dark: { canvas: "#0c111b", frame: "#0f1522", surface: "#131a29", text: "#e8ecf5", accent: "#6aa5ff" },
    light: { canvas: "#f4f6fb", frame: "#ebeff7", surface: "#ffffff", text: "#141d2f", accent: "#1f5fd1" },
  },
  {
    id: "verdigris",
    name: "Verdigris",
    note: "Mineral gray, green-teal accent",
    dark: { canvas: "#0e1317", frame: "#11181d", surface: "#151d23", text: "#e9eef0", accent: "#68c9b7" },
    light: { canvas: "#f5f7f6", frame: "#edf1f0", surface: "#ffffff", text: "#17242a", accent: "#176d60" },
  },
  {
    id: "fjord",
    name: "Fjord",
    note: "Blue slate, frost accent",
    dark: { canvas: "#191e27", frame: "#141821", surface: "#1d222c", text: "#e5e9f0", accent: "#88c0d0" },
    light: { canvas: "#f7f9fb", frame: "#edf0f4", surface: "#f2f4f7", text: "#1b2230", accent: "#2e6894" },
  },
  {
    id: "graphite",
    name: "Graphite",
    note: "Neutral gray, periwinkle accent",
    dark: { canvas: "#101113", frame: "#141517", surface: "#191a1d", text: "#ececef", accent: "#a9a6f7" },
    light: { canvas: "#f6f6f7", frame: "#eeeef0", surface: "#ffffff", text: "#18181d", accent: "#5148c9" },
  },
  {
    id: "contrast",
    name: "High contrast",
    note: "For low vision and bright rooms",
    dark: { canvas: "#000000", frame: "#000000", surface: "#0a0a0a", text: "#ffffff", accent: "#ffd65c" },
    light: { canvas: "#ffffff", frame: "#ffffff", surface: "#ffffff", text: "#000000", accent: "#0040a0" },
  },
];

/** The theme for a stored id; an id this version does not know (or none) is the default theme. */
export function appThemeById(id: string | null | undefined): AppTheme {
  return APP_THEMES.find((theme) => theme.id === id) ?? (APP_THEMES[0] as AppTheme);
}

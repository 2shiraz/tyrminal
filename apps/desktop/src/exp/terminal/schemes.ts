// Afterglow's terminal schemes: main's list with "Afterglow Night" in the first place. It takes over
// main's default id ("tyrminal-night"), so the experimental build opens in it without a preferences
// change (preferences stay a Rust contract this branch does not touch); "Tyrminal Night" stays
// available under its own new id. Swapped in for features/terminal/schemes.ts by vite.exp.mjs.
//
// Floors as main's own schemes (scripts/check-contrast.mjs, scripts/exp/check-contrast.mjs):
// foreground and text on selection at 4.5:1, every ANSI colour at 3:1, bright black at 2:1.
import { SCHEMES as MAIN_SCHEMES, type TerminalScheme } from "../../features/terminal/schemes";

export { contrast, lowContrastColors, type TerminalScheme } from "../../features/terminal/schemes";

export const AFTERGLOW_NIGHT: TerminalScheme = {
  id: "tyrminal-night",
  name: "Afterglow Night",
  kind: "dark",
  credit: "Tyrminal",
  background: "#141319",
  foreground: "#e6e4ec",
  cursor: "#f7a440",
  cursorAccent: "#141319",
  // rgb(247 164 64 / 0.28) over the background, flattened so contrast checks see the real colour.
  selectionBackground: "#543c24",
  black: "#2a2833",
  red: "#f2626b",
  green: "#4cc38a",
  yellow: "#e8c35a",
  blue: "#8db4ff",
  magenta: "#c792ea",
  cyan: "#5ccfd6",
  white: "#cfcdd8",
  brightBlack: "#6e6a7c",
  brightRed: "#ff8a90",
  brightGreen: "#74dba7",
  brightYellow: "#f5d88a",
  brightBlue: "#adc8ff",
  brightMagenta: "#ddb3f5",
  brightCyan: "#8be3e8",
  brightWhite: "#f6f5fa",
};

export const SCHEMES: readonly TerminalScheme[] = [
  AFTERGLOW_NIGHT,
  ...MAIN_SCHEMES.map((s) => (s.id === "tyrminal-night" ? { ...s, id: "tyrminal-night-classic" } : s)),
];

export const DEFAULT_SCHEME_ID = "tyrminal-night";

export function schemeById(id: string): TerminalScheme {
  return SCHEMES.find((s) => s.id === id) ?? AFTERGLOW_NIGHT;
}

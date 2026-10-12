// Highlight colors per color scheme (TRM-07). Each token kind names the scheme colors that fit
// it in order of preference; the first one that reads at WCAG AA (4.5:1) on the scheme's
// background is used, else the most readable of them. Colors therefore follow the scheme the
// user picked, light or dark, and never fall below what the scheme itself can offer.

import type { TerminalScheme } from "../terminal/schemes";
import type { TokenKind } from "./builtins";

type SchemeColor = Exclude<keyof TerminalScheme, "id" | "name" | "kind" | "credit">;

const PREFERENCES: Record<TokenKind, SchemeColor[]> = {
  danger: ["brightRed", "red"],
  warning: ["brightYellow", "yellow"],
  success: ["brightGreen", "green"],
  info: ["brightCyan", "cyan", "brightBlue", "blue"],
  // Quieter than the text, but still readable as text.
  dim: ["brightBlack", "white", "foreground"],
  address: ["brightCyan", "cyan", "brightBlue"],
  number: ["brightMagenta", "magenta", "brightBlue"],
  url: ["brightBlue", "blue", "brightCyan"],
  string: ["green", "brightGreen"],
  date: ["magenta", "brightMagenta", "blue"],
  path: ["yellow", "brightYellow"],
  hex: ["brightBlue", "blue", "brightMagenta"],
};

function channels(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  return m ? [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16)] : null;
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const x = channels(a);
  const y = channels(b);
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text at WCAG AA; dimmed words (debug, info) only need to stay legible. */
const floor = (kind: TokenKind) => (kind === "dim" ? 3 : 4.5);
const cache = new Map<string, Record<TokenKind, string>>();

export function highlightPalette(scheme: TerminalScheme): Record<TokenKind, string> {
  const hit = cache.get(scheme.id);
  if (hit) return hit;
  const palette = {} as Record<TokenKind, string>;
  for (const [kind, names] of Object.entries(PREFERENCES) as [TokenKind, SchemeColor[]][]) {
    const colors = names.map((n) => scheme[n] as string);
    palette[kind] = colors.find((c) => contrast(c, scheme.background) >= floor(kind)) ?? [...colors].sort((a, b) => contrast(b, scheme.background) - contrast(a, scheme.background))[0] ?? scheme.foreground;
  }
  cache.set(scheme.id, palette);
  return palette;
}

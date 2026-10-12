#!/usr/bin/env node
// WCAG 2.2 AA contrast check for the design tokens (apps/desktop/src/styles/tokens.css) in every
// palette and mode, and for every terminal color scheme's foreground/background and ANSI colors.
//
//   node scripts/check-contrast.mjs
//
// Translucent tokens are composited over the surface they are used on before measuring.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "apps/desktop/src/styles/tokens.css"), "utf8");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const base = block(":root");
const themes = [
  ["dark", base],
  ["light", { ...base, ...block(':root[data-theme="light"]') }],
  ["fjord dark", { ...base, ...block(':root[data-palette="fjord"]') }],
  ["fjord light", { ...base, ...block(':root[data-palette="fjord"][data-theme="light"]') }],
  ["contrast dark", { ...base, ...block(':root[data-palette="contrast"]') }],
  ["contrast light", { ...base, ...block(':root[data-palette="contrast"][data-theme="light"]') }],
];

export function parseColor(value) {
  let m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m) {
    const n = Number.parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`cannot parse color ${value}`);
}

function over(top, bottom) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
}

function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const failures = [];
let checked = 0;

function check(theme, name, tokens, fgName, bgName, min, under = null) {
  let bg = parseColor(tokens[bgName]);
  if (bg[3] < 1) bg = over(bg, parseColor(tokens[under ?? "bg-surface"]));
  let fg = parseColor(tokens[fgName]);
  if (fg[3] < 1) fg = over(fg, bg);
  const r = ratio(fg, bg);
  checked += 1;
  if (r < min) failures.push(`${theme}: ${fgName} on ${bgName}${under ? ` (over ${under})` : ""} = ${r.toFixed(2)} < ${min} (${name})`);
}

const surfaces = ["bg-app", "bg-sidebar", "bg-surface", "bg-raised", "bg-overlay", "bg-inset", "bg-raised-hover"];
const translucent = [
  ["bg-hover", "bg-sidebar"],
  ["bg-active", "bg-sidebar"],
  ["bg-hover", "bg-app"],
  ["bg-selected", "bg-app"],
  ["bg-selected", "bg-surface"],
  ["bg-hover", "bg-raised"],
];

for (const [theme, tokens] of themes) {
  for (const surface of surfaces) {
    for (const text of ["text", "text-muted", "text-faint", "accent-text"]) check(theme, "text", tokens, text, surface, 4.5);
    for (const status of ["success", "warning", "danger"]) check(theme, "status text", tokens, status, surface, 4.5);
    check(theme, "control boundary", tokens, "border-control", surface, 3);
    check(theme, "focus ring", tokens, "focus", surface, 3);
    check(theme, "accent fill", tokens, "accent", surface, 3);
    check(theme, "cursor marker", tokens, "cursor", surface, 3);
  }
  for (const [bg, under] of translucent) {
    for (const text of ["text", "text-muted", "accent-text"]) check(theme, "text on state", tokens, text, bg, 4.5, under);
  }
  for (const [soft, text] of [["accent-soft", "accent-text"], ["success-soft", "success"], ["warning-soft", "warning"], ["danger-soft", "danger"]]) {
    for (const under of ["bg-app", "bg-surface", "bg-raised", "bg-overlay"]) check(theme, "badge", tokens, text, soft, 4.5, under);
  }
  // Selected rows in file lists: accent text and icons on the selection tint.
  for (const under of ["bg-surface", "bg-raised", "bg-inset"]) check(theme, "selected row", tokens, "accent-text", "bg-selected", 4.5, under);
  check(theme, "primary button", tokens, "text-on-accent", "accent", 4.5);
  check(theme, "primary button hover", tokens, "text-on-accent", "accent-hover", 4.5);
}

// Terminal schemes: foreground and text on the selection at AA (4.5:1) for every scheme; bright
// black (comments, hints) at least 2:1. Tyrminal's own schemes additionally keep every ANSI color
// at 3:1. Third-party palettes keep their published ANSI colors; the picker lists any below 3:1.
const schemesSource = readFileSync(join(root, "apps/desktop/src/features/terminal/schemes.ts"), "utf8");
const schemeBlocks = [...schemesSource.matchAll(/\{\s*id: "([\w-]+)",[\s\S]*?\n  \},/g)];
for (const [text, id] of schemeBlocks) {
  const color = (key) => {
    const m = new RegExp(`\\b${key}: "(#[0-9a-fA-F]{6})"`).exec(text);
    if (!m) throw new Error(`scheme ${id}: missing ${key}`);
    return parseColor(m[1]);
  };
  const bg = color("background");
  const measure = (label, value, min) => {
    checked += 1;
    if (value < min) failures.push(`scheme ${id}: ${label} ${value.toFixed(2)} < ${min}`);
  };
  measure("foreground", ratio(color("foreground"), bg), 4.5);
  measure("text on selection", ratio(color("foreground"), color("selectionBackground")), 4.5);
  measure("bright black", ratio(color("brightBlack"), bg), 2);
  if (id.startsWith("tyrminal-")) {
    for (const key of ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan"]) {
      measure(key, ratio(color(key), bg), 3);
    }
  }
}
if (schemeBlocks.length < 10) failures.push(`only ${schemeBlocks.length} terminal schemes found; at least 10 are required`);

// terminal input: highlight colors in every scheme (computed by the app's own palette code).
{
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "scripts/check-highlight-contrast.mjs")], { encoding: "utf8" });
  checked += 1;
  if (run.status !== 0) failures.push(`highlight colors:\n${run.stdout}${run.stderr}`.trim());
  else process.stdout.write(run.stdout);
}

if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f}`).join("\n"));
  console.error(`\n${failures.length} of ${checked} contrast checks failed`);
  process.exit(1);
}
console.log(`contrast ok: ${checked} pairs across ${themes.length} themes and ${schemeBlocks.length} terminal schemes`);

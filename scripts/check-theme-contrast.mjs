#!/usr/bin/env node
// WCAG 2.2 AA contrast check for the next design tokens (apps/desktop/src/styles/next/theme.css):
// every palette in both modes, with the same pairs as scripts/check-contrast.mjs plus the cursor
// marker. When theme.css replaces tokens.css, this check folds into check-contrast.mjs.
//
//   node scripts/check-theme-contrast.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "apps/desktop/src/styles/next/theme.css"), "utf8");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const base = block(":root");
const themes = [
  ["graphite (dark)", base],
  ["paper (light)", { ...base, ...block(':root[data-theme="light"]') }],
  ["fjord dark", { ...base, ...block(':root[data-palette="fjord"]') }],
  ["fjord light", { ...base, ...block(':root[data-palette="fjord"][data-theme="light"]') }],
  ["contrast dark", { ...base, ...block(':root[data-palette="contrast"]') }],
  ["contrast light", { ...base, ...block(':root[data-palette="contrast"][data-theme="light"]') }],
];

function parseColor(value) {
  let m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m) {
    const n = Number.parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`cannot parse color ${value}`);
}

const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);

function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const failures = [];
const lowest = new Map();
let checked = 0;

function check(theme, label, tokens, fgName, bgName, min, under = "bg-surface") {
  let bg = parseColor(tokens[bgName]);
  if (bg[3] < 1) bg = over(bg, parseColor(tokens[under]));
  let fg = parseColor(tokens[fgName]);
  if (fg[3] < 1) fg = over(fg, bg);
  const r = ratio(fg, bg);
  checked += 1;
  const key = `${theme}: ${label}`;
  if (!lowest.has(key) || lowest.get(key).r > r) lowest.set(key, { r, pair: `${fgName} on ${bgName}` });
  if (r < min) failures.push(`${theme}: ${fgName} on ${bgName}${bgName.includes("soft") || bgName.startsWith("bg-h") || bgName.startsWith("bg-a") || bgName.startsWith("bg-s") ? ` (over ${under})` : ""} = ${r.toFixed(2)} < ${min} (${label})`);
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
  check(theme, "primary button", tokens, "text-on-accent", "accent", 4.5);
  check(theme, "primary button hover", tokens, "text-on-accent", "accent-hover", 4.5);
}

if (process.argv.includes("--report")) {
  for (const [key, { r, pair }] of lowest) console.log(`${key.padEnd(40)} min ${r.toFixed(2)}  ${pair}`);
}
if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f}`).join("\n"));
  console.error(`\n${failures.length} of ${checked} contrast checks failed`);
  process.exit(1);
}
console.log(`theme contrast ok: ${checked} pairs across ${themes.length} palettes`);

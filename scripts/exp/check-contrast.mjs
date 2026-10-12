#!/usr/bin/env node
// Afterglow (experimental UI, branch only): WCAG 2.2 AA contrast for the Afterglow tokens
// (apps/desktop/src/exp/styles/tokens.css) in dark and light, the hue distance between the accent
// and the warning colour (they must never be mistaken for each other), and the Afterglow Night
// terminal scheme against the floors main's schemes meet.
//
//   node scripts/exp/check-contrast.mjs
//
// Translucent tokens are composited over the surface they sit on before measuring.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "apps/desktop/src/exp/styles/tokens.css"), "utf8");
const schemes = readFileSync(join(root, "apps/desktop/src/exp/terminal/schemes.ts"), "utf8");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const dark = block(':root[data-ui="afterglow"]:not([data-palette="contrast"])');
const light = { ...dark, ...block(':root[data-ui="afterglow"][data-theme="light"]:not([data-palette="contrast"])') };

function resolve(tokens, value, depth = 0) {
  const m = /^var\(--([\w-]+)\)$/.exec(value);
  if (!m) return value;
  if (depth > 8 || !(m[1] in tokens)) throw new Error(`cannot resolve ${value}`);
  return resolve(tokens, tokens[m[1]], depth + 1);
}

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

/** OKLCH hue in degrees (Björn Ottosson's OKLab). */
function hue([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
}

const failures = [];
let checked = 0;

function check(theme, tokens, fgName, bgName, min, underName) {
  const color = (name) => parseColor(resolve(tokens, tokens[name] ?? `var(--${name})`));
  let bg = color(bgName);
  if (underName) bg = over(bg, color(underName));
  const fg = over(color(fgName), bg);
  const r = ratio(fg, bg);
  checked += 1;
  if (r < min) failures.push(`${theme}: --${fgName} on --${bgName}${underName ? ` over --${underName}` : ""} is ${r.toFixed(2)}:1, needs ${min}:1`);
}

const SURFACES = ["bg-window", "bg-canvas", "bg-surface-2", "bg-control", "bg-overlay"];
for (const [theme, tokens] of [["dark", dark], ["light", light]]) {
  for (const bg of SURFACES) {
    for (const fg of ["text", "text-muted", "text-faint", "accent-text", "danger", "success"]) check(theme, tokens, fg, bg, 4.5);
    // Warning is text only with its icon; it still reads at AA.
    check(theme, tokens, "warning", bg, 4.5);
    // Control boundaries and the focus ring: 3:1 (WCAG 1.4.11).
    check(theme, tokens, "border-control", bg, 3);
    check(theme, tokens, "focus", bg, 3);
  }
  // Text on the soft accent and selection fills.
  for (const fg of ["text", "text-muted", "accent-text"]) {
    check(theme, tokens, fg, "accent-soft", 4.5, "bg-window");
    check(theme, tokens, fg, "accent-soft", 4.5, "bg-canvas");
    check(theme, tokens, fg, "bg-active", 4.5, "bg-overlay");
  }
  // Tinted badges on every card-like surface (badge-danger/success/warning/accent).
  for (const under of ["bg-surface-2", "bg-control", "bg-overlay", "bg-canvas"]) {
    check(theme, tokens, "danger", "danger-soft", 4.5, under);
    check(theme, tokens, "success", "success-soft", 4.5, under);
    check(theme, tokens, "warning", "warning-soft", 4.5, under);
    check(theme, tokens, "accent-text", "accent-soft", 4.5, under);
  }
  // The production badge: danger on color-mix(danger 12%, --bg-raised), opaque (global.css P-26).
  {
    const danger = parseColor(resolve(tokens, tokens.danger));
    const raised = parseColor(resolve(tokens, tokens["bg-raised"]));
    const bg = over([danger[0], danger[1], danger[2], 0.12], raised);
    const r = ratio(danger, bg);
    checked += 1;
    if (r < 4.5) failures.push(`${theme}: production badge (danger on its 12% mix) is ${r.toFixed(2)}:1, needs 4.5:1`);
  }
  check(theme, tokens, "on-accent", "accent", 4.5);
  check(theme, tokens, "on-accent", "accent-hover", 4.5);

  const distance = Math.abs(hue(parseColor(tokens.accent)) - hue(parseColor(tokens.warning)));
  checked += 1;
  if (Math.min(distance, 360 - distance) < 15) failures.push(`${theme}: accent and warning are ${distance.toFixed(1)}° apart in OKLCH hue, need 15°`);
}

// Afterglow Night: the floors of main's own schemes.
const scheme = Object.fromEntries([...schemes.slice(schemes.indexOf("AFTERGLOW_NIGHT")).matchAll(/(\w+): "(#[0-9a-f]{6})"/gi)].map((m) => [m[1], parseColor(m[2])]));
const sr = (a, b, min, label) => {
  checked += 1;
  const r = ratio(scheme[a], scheme[b]);
  if (r < min) failures.push(`Afterglow Night: ${label} is ${r.toFixed(2)}:1, needs ${min}:1`);
};
sr("foreground", "background", 4.5, "foreground");
sr("foreground", "selectionBackground", 4.5, "text on selection");
sr("brightBlack", "background", 2, "bright black");
for (const k of ["red", "green", "yellow", "blue", "magenta", "cyan", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan"]) sr(k, "background", 3, k);

if (failures.length) {
  console.error(`Afterglow contrast: ${failures.length} of ${checked} checks failed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`Afterglow contrast: ${checked} checks passed`);

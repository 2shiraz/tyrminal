// Highlight colors in every built-in terminal scheme (TRM-07): each token kind reads at WCAG AA
// (4.5:1) on the scheme background (dimmed words at 3:1), and the kinds stay distinguishable
// (at least 6 different colors). Run directly or from scripts/check-contrast.mjs.
//
//   node --experimental-strip-types scripts/check-highlight-contrast.mjs

import { fileURLToPath } from "node:url";

const src = (p) => fileURLToPath(new URL(`../apps/desktop/src/${p}`, import.meta.url));
const { SCHEMES } = await import(src("features/terminal/schemes.ts"));
const { contrast, highlightPalette } = await import(src("features/highlight/palette.ts"));

const failures = [];
let checked = 0;
for (const scheme of SCHEMES) {
  const palette = highlightPalette(scheme);
  for (const [kind, color] of Object.entries(palette)) {
    checked += 1;
    const min = kind === "dim" ? 3 : 4.5;
    const value = contrast(color, scheme.background);
    if (value < min) failures.push(`scheme ${scheme.id}: highlight ${kind} ${color} ${value.toFixed(2)} < ${min}`);
  }
  const distinct = new Set(Object.values(palette)).size;
  if (distinct < 6) failures.push(`scheme ${scheme.id}: only ${distinct} distinct highlight colors`);
}
if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f}`).join("\n"));
  process.exit(1);
}
console.log(`highlight contrast ok: ${checked} colors across ${SCHEMES.length} schemes`);

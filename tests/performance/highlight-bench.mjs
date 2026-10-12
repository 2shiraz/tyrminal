// Output highlighting cost (TRM-07): every built-in rule over a full screen of 80 rows of 300
// characters, for ordinary output and for shapes that make backtracking expressions slow.
// Fails when any case exceeds the budget. Pure computation; no application or lab needed.
//
//   node --experimental-strip-types tests/performance/highlight-bench.mjs   (Node 22; plain `node` from 23.6)

import { fileURLToPath } from "node:url";

const builtins = fileURLToPath(new URL("../../apps/desktop/src/features/highlight/builtins.ts", import.meta.url));
const { BUILTIN_RULES } = await import(builtins);

const COLS = 300;
const ROWS = 80;
/** A screen is matched once after output settles; this keeps it far below a frame. */
const BUDGET_MS = 50;

const cases = {
  "ordinary output": "2026-10-12 14:03:22 info GET /api/v1/hosts from 10.0.0.12 took 12ms ok warn 91% 3.4GiB https://example.com/x a1f3c2e \"q\" aa:bb:cc:00:11:22 fe80::1 ",
  "digit run": "1",
  "dotted digits": "1.",
  colons: ":",
  "hex and colons": "a:",
  quotes: '"',
  "path segments": "/a",
  apostrophes: "it's ",
  "hex run": "abcdef0123",
  "status words": "error ok warn ",
  "spaces and digits": "1 ",
};

let failed = false;
for (const [name, unit] of Object.entries(cases)) {
  const line = unit.repeat(Math.ceil(COLS / unit.length)).slice(0, COLS);
  // Warm up the engine once, then measure.
  for (const rule of BUILTIN_RULES) [...line.matchAll(rule.re)];
  const start = performance.now();
  let matches = 0;
  for (let row = 0; row < ROWS; row += 1) {
    for (const rule of BUILTIN_RULES) {
      for (const m of line.matchAll(rule.re)) if (!rule.accept || rule.accept(m[0])) matches += 1;
    }
  }
  const ms = performance.now() - start;
  const ok = ms <= BUDGET_MS;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(18)} ${ms.toFixed(1).padStart(6)} ms  (${matches} matches)`);
}
console.log(`budget ${BUDGET_MS} ms per screen of ${ROWS}×${COLS}`);
process.exit(failed ? 1 : 0);

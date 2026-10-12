#!/usr/bin/env node
// Afterglow (experimental UI, branch only): main's build must carry zero experimental bytes.
// Builds main's front end into a temporary folder and fails if it contains the Afterglow scope,
// the Geist font or the motion library.
//
//   node scripts/exp/check-isolation.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = mkdtempSync(join(tmpdir(), "tyr-main-build-"));
const env = { ...process.env };
delete env.TYRMINAL_UI;
const build = spawnSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], { cwd: join(root, "apps", "desktop"), env, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(out);

const problems = [];
for (const file of files) {
  if (/geist/i.test(file)) problems.push(`font file ${file}`);
  if (!/\.(js|css|html)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const needle of ['data-ui="afterglow"', "Afterglow Night", "Geist Variable", "framer-motion", "motion/react"]) {
    if (text.includes(needle)) problems.push(`${needle} in ${file}`);
  }
}
rmSync(out, { recursive: true, force: true });
if (problems.length) {
  console.error("main's build carries experimental code:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`main's build is clean (${files.length} files, no Afterglow code, font or motion library)`);

#!/usr/bin/env node
// Afterglow (experimental UI, branch only): the commands of plan §8, each with
// TYRMINAL_UI=experimental set, so no shell syntax differs between platforms.
//
//   node scripts/exp/run.mjs dev        pnpm dev with the experimental UI (Tauri, loopback dev server)
//   node scripts/exp/run.mjs build      unsigned desktop build of the experimental UI (dist-exp)
//   node scripts/exp/run.mjs web        only the experimental front-end bundle (apps/desktop/dist-exp)
//   node scripts/exp/run.mjs test [..]  build the bundle, then run the UI specs against it
//   node scripts/exp/run.mjs capture    build the bundle, then write docs/design/afterglow/*.png
//
// Main's own commands (pnpm dev, build:desktop, test:ui) are unchanged and never see Afterglow.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktop = join(root, "apps", "desktop");
const uiTests = join(root, "tests", "ui");
const env = { ...process.env, TYRMINAL_UI: "experimental" };
const [command, ...rest] = process.argv.slice(2);

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The desktop build reads the experimental bundle instead of dist/.
const tauriConfig = JSON.stringify({ build: { beforeBuildCommand: "pnpm build", frontendDist: "../dist-exp" } });

switch (command) {
  case "dev":
    run("pnpm", ["tauri", "dev", ...rest], desktop);
    break;
  case "build":
    run("pnpm", ["tauri", "build", "--config", tauriConfig, ...rest], desktop);
    break;
  case "web":
    run("pnpm", ["build"], desktop);
    break;
  case "test":
    run("pnpm", ["build"], desktop);
    run("npx", ["playwright", "test", "-c", "playwright.exp.config.ts", ...rest], uiTests);
    break;
  case "capture":
    run("pnpm", ["build"], desktop);
    run("npx", ["playwright", "test", "-c", "afterglow-capture.config.ts", ...rest], uiTests);
    break;
  default:
    console.error("usage: node scripts/exp/run.mjs dev|build|web|test|capture [args]");
    process.exit(2);
}

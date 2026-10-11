#!/usr/bin/env node
// Builds the application with the non-default `e2e` feature (embedded WebDriver server) into its
// own target directory, so a test build can never be mistaken for, or overwrite, a normal build.
//
// The target directory is absolute on purpose: the Tauri CLI runs cargo from `src-tauri`, and a
// relative CARGO_TARGET_DIR silently resolves somewhere else.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "pnpm",
  ["tauri", "build", "--debug", "--no-bundle", "--features", "e2e", "--config", "src-tauri/tauri.e2e.conf.json"],
  {
    cwd: join(root, "apps", "desktop"),
    env: { ...process.env, CARGO_TARGET_DIR: join(root, "target", "e2e") },
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
process.exit(result.status ?? 1);

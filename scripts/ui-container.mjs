#!/usr/bin/env node
// Runs the browser UI suite inside the pinned Playwright image that CI uses, so visual baselines
// are recorded and compared with identical fonts and Chromium. Requires Docker. The container
// gets no network; it reuses this checkout's node_modules and the frontend build made here.
//
//   node scripts/ui-container.mjs            # run the suite
//   node scripts/ui-container.mjs --update   # re-record changed baselines
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE =
  "mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const update = args.includes("--update");
const rest = args.filter((a) => a !== "--update");

const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("pnpm", ["--filter", "@tyrminal/desktop", "build"]);
run("docker", [
  "run", "--rm", "--ipc=host", "--network=none", "-e", "CI=1",
  "-v", `${root}:${root}`, "-w", `${root}/tests/ui`, IMAGE,
  "./node_modules/.bin/playwright", "test", "-c", "playwright.config.ts",
  ...(update ? ["--update-snapshots=changed"] : []), ...rest,
]);

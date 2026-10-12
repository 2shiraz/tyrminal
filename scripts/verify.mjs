#!/usr/bin/env node
// Verification entry point. Each suite is a list of steps; every step's command, exit code and
// duration is printed and written to docs/reports/raw/verify-<suite>.json (git-ignored evidence).
//
//   node scripts/verify.mjs fast          format, lint, typecheck, contracts, unit tests
//   node scripts/verify.mjs integration   real SQLite/keychain/PTY and the SSH lab (needs Docker)
//   node scripts/verify.mjs security      named negative tests and release-policy checks
//   node scripts/verify.mjs native        packaged-app end-to-end tests (needs lab + e2e build)
//
// A step that cannot run because a prerequisite is missing is reported as BLOCKED and makes the
// suite fail: a blocked check is never counted as passing.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const labFile = join(root, "tests", "ssh-lab", ".run", "lab.json");
const e2eBinary = join(root, "target", "e2e", "debug", process.platform === "win32" ? "tyrminal.exe" : "tyrminal");

const needsLab = () => (existsSync(labFile) ? null : "SSH lab is not running (pnpm lab:up)");
const needsE2e = () => (existsSync(e2eBinary) ? null : "e2e application build is missing (pnpm build:e2e)");
const needsSecretStore = () => {
  if (process.platform === "darwin" || process.platform === "win32") return null;
  if (process.platform === "linux") return process.env.DBUS_SESSION_BUS_ADDRESS ? null : "no D-Bus session bus for the Secret Service (run under dbus-run-session with gnome-keyring)";
  return "no OS secret store adapter for this platform";
};

const cargo = (...args) => ["cargo", args];
const pnpm = (...args) => ["pnpm", args];
const node = (...args) => ["node", args];

// Linux without a display (CI, containers) runs the WebKitGTK application under a virtual X server.
const headless = ([command, args]) =>
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? ["xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", command, ...args]]
    : [command, args];

const SUITES = {
  fast: [
    { name: "rust format", cmd: cargo("fmt", "--all", "--check") },
    { name: "rust lint", cmd: cargo("clippy", "--workspace", "--all-targets", "--", "-D", "warnings") },
    { name: "rust unit and property tests", cmd: cargo("test", "--workspace", "--no-fail-fast", "--quiet") },
    { name: "contracts are up to date", cmd: node("scripts/generate-contracts.mjs", "--check") },
    { name: "typescript", cmd: pnpm("--filter", "@tyrminal/desktop", "typecheck") },
    { name: "frontend build", cmd: pnpm("--filter", "@tyrminal/desktop", "build") },
    { name: "feature matrix", cmd: node("scripts/feature-matrix.mjs", "--check") },
  ],
  // Large-transfer gate (Phase 06): moves 2 GiB each way, so it is a suite of its own that CI runs
  // on Linux and macOS. Without TYRMINAL_BIG_TRANSFER it is BLOCKED (never a silent pass).
  transfer: [
    {
      name: "2 GiB SFTP round trip, bounded memory",
      cmd: cargo("test", "-p", "tyrminal-core", "--test", "sessions_lab", "--quiet", "--", "--ignored", "--exact", "two_gib_round_trip_is_byte_for_byte_with_bounded_memory"),
      blockedBy: () => needsLab() ?? (process.env.TYRMINAL_BIG_TRANSFER ? null : "moves 4 GiB; set TYRMINAL_BIG_TRANSFER=1 to run"),
    },
  ],
  integration: [
    { name: "ssh adapter against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    { name: "core sessions against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-core", "--test", "sessions_lab", "--quiet", "--", "--ignored", "--skip", "two_gib"), blockedBy: needsLab },
    { name: "OS secret store round trip", cmd: cargo("test", "-p", "tyrminal-platform", "--quiet", "--", "--ignored"), blockedBy: needsSecretStore },
  ],
  security: [
    { name: "vault format: tamper, swap, bounds, known answers", cmd: cargo("test", "-p", "tyrminal-vault", "--quiet") },
    { name: "vault service: canary scan, tampering, lock races", cmd: cargo("test", "-p", "tyrminal-core", "--test", "vault_service", "--quiet") },
    { name: "storage: permissions, foreign/newer files, atomicity", cmd: cargo("test", "-p", "tyrminal-storage", "--quiet") },
    { name: "host trust and credentials ordering (lab)", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "lab", "--quiet", "--", "--ignored", "host_key", "credentials"), blockedBy: needsLab },
    { name: "session ownership, lock invalidation, output ceiling (lab)", cmd: cargo("test", "-p", "tyrminal-core", "--test", "sessions_lab", "--quiet", "--", "--ignored", "--skip", "two_gib"), blockedBy: needsLab },
    { name: "release policy", cmd: node("scripts/check-release.mjs") },
  ],
  native: [
    { name: "packaged application end to end", cmd: headless(node("--test", "--test-concurrency=1", "tests/native/app.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "terminal: full-screen apps, input, mouse, resize, escape corpus", cmd: headless(node("--test", "--test-concurrency=1", "tests/native/terminal.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "snippets: panel, owned-session send, lock", cmd: headless(node("--test", "--test-concurrency=1", "tests/native/snippets.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "backup and restore through the real application", cmd: headless(node("--test", "--test-concurrency=1", "tests/native/backup.test.mjs")), blockedBy: () => needsE2e() },
  ],
};

const suiteName = process.argv[2];
const suite = SUITES[suiteName];
if (!suite) {
  console.error(`usage: verify.mjs ${Object.keys(SUITES).join("|")}`);
  process.exit(2);
}

const results = [];
for (const step of suite) {
  const [command, args] = step.cmd;
  const line = `${command} ${args.join(" ")}`;
  const blocker = step.blockedBy?.();
  if (blocker) {
    console.log(`BLOCKED  ${step.name}\n         ${blocker}`);
    results.push({ name: step.name, command: line, status: "BLOCKED", reason: blocker });
    continue;
  }
  const started = Date.now();
  const run = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = run.status === 0;
  console.log(`${ok ? "ok     " : "FAILED "}  ${step.name}  (${seconds}s, exit ${run.status})\n         $ ${line}`);
  if (!ok) {
    const lines = `${run.stdout}${run.stderr}`.trim().split("\n");
    // The causes (panics, assertion output, failing test names) first, then the tail.
    const cause = /panicked at|^---- .* (stdout|stderr) ----|assertion|^error(\[|:)|FAILED|^failures:|^\s*[✔✖﹣] /;
    const picked = new Set();
    lines.forEach((line, i) => {
      if (cause.test(line)) for (let j = i; j < Math.min(lines.length, i + 12); j++) picked.add(j);
    });
    const context = [...picked].sort((a, b) => a - b).slice(0, 200).map((i) => lines[i]);
    if (context.length) console.log(`--- failure context ---\n${context.join("\n")}\n--- tail ---`);
    console.log(lines.slice(-40).join("\n"));
  }
  // A skipped test (e.g. a full-screen app missing on this platform's lab) is BLOCKED, never a pass.
  const output = `${run.stdout}${run.stderr}`;
  const skipped = Number(/^(?:ℹ skipped|# skipped|# skip) (\d+)/m.exec(output)?.[1] ?? 0);
  if (ok && skipped > 0) {
    const reasons = [...new Set(output.split("\n").filter((l) => /BLOCKED:/.test(l)).map((l) => l.trim()))];
    console.log(`BLOCKED  ${step.name}: ${skipped} test(s) could not run here\n         ${reasons.join("\n         ")}`);
    results.push({ name: step.name, command: line, status: "BLOCKED", reason: reasons.join("; "), skipped, exitCode: run.status, seconds: Number(seconds) });
    continue;
  }
  results.push({ name: step.name, command: line, status: ok ? "PASSED" : "FAILED", exitCode: run.status, seconds: Number(seconds) });
}

const outDir = join(root, "docs", "reports", "raw");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, `verify-${suiteName}.json`),
  `${JSON.stringify({ suite: suiteName, platform: `${process.platform}/${process.arch}`, finishedAt: new Date().toISOString(), results }, null, 2)}\n`,
);

const failed = results.filter((r) => r.status !== "PASSED");
console.log(`\n${suiteName}: ${results.length - failed.length} passed, ${results.filter((r) => r.status === "FAILED").length} failed, ${results.filter((r) => r.status === "BLOCKED").length} blocked`);
process.exit(failed.length === 0 ? 0 : 1);

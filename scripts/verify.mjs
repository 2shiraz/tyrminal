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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A step that hangs fails after this long instead of holding a CI runner until its job limit.
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const labFile = join(root, "tests", "ssh-lab", ".run", "lab.json");
const e2eBinary = join(root, "target", "e2e", "debug", process.platform === "win32" ? "tyrminal.exe" : "tyrminal");

const needsLab = () => (existsSync(labFile) ? null : "SSH lab is not running (pnpm lab:up)");
// OpenSSH offers mlkem768x25519-sha256 from 9.9; the container lab has 10.0.
// The end-to-end ML-KEM test needs a lab sshd from OpenSSH 9.9 on. TYRMINAL_PQ_LAB names a second
// lab for it (Linux CI starts the 10.0 container lab beside the local one, whose sshd is 9.6).
const pqLabFile = process.env.TYRMINAL_PQ_LAB ? resolve(root, process.env.TYRMINAL_PQ_LAB) : labFile;
const labVersion = (file) => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).serverVersion ?? "") : "");
const offersPostQuantum = (version) => {
  const [major = 0, minor = 0] = (version.match(/\d+/g) ?? []).map(Number);
  return major > 9 || (major === 9 && minor >= 9);
};
const needsPostQuantumLab = () => {
  if (!existsSync(pqLabFile)) return `the SSH lab is not running (${pqLabFile}); run pnpm lab:up`;
  const version = labVersion(pqLabFile);
  return offersPostQuantum(version) ? null : `the lab's sshd (${version}) does not offer mlkem768x25519-sha256 (needs OpenSSH 9.9 or later)`;
};
// On Windows the lab is Debian 12 in WSL 1 (OpenSSH 9.2) and the runner cannot run Linux
// containers, so the end-to-end ML-KEM step is out of scope there: SEC-08 records it as BLOCKED
// on windows-x64. Everywhere else a lab without ML-KEM stays BLOCKED (a failure).
const postQuantumOutOfScope = () =>
  process.platform === "win32" && !process.env.TYRMINAL_PQ_LAB && existsSync(labFile) && !offersPostQuantum(labVersion(labFile));
const needsE2e = () => (existsSync(e2eBinary) ? null : "e2e application build is missing (pnpm build:e2e)");
const needsSecretStore = () => {
  if (process.platform === "darwin" || process.platform === "win32") return null;
  if (process.platform === "linux") return process.env.DBUS_SESSION_BUS_ADDRESS ? null : "no D-Bus session bus for the Secret Service (run under dbus-run-session with gnome-keyring)";
  return "no OS secret store adapter for this platform";
};

const needsSocat = () => (spawnSync("socat", ["-V"], { stdio: "ignore" }).status === 0 ? null : "socat is not installed (a pseudo-terminal pair plays the serial device)");

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
    {
      name: "download onto a full local disk fails cleanly",
      cmd: cargo("test", "-p", "tyrminal-core", "--test", "sessions_lab", "--quiet", "--", "--ignored", "--exact", "full_disk_download_fails_cleanly_and_leaves_nothing_behind"),
      blockedBy: () => needsLab() ?? (process.env.TYRMINAL_SMALL_FS ? null : "needs a tiny filesystem; set TYRMINAL_SMALL_FS to a folder on one"),
    },
  ],
  integration: [
    { name: "ssh adapter against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    { name: "core sessions against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-core", "--test", "sessions_lab", "--quiet", "--", "--ignored", "--skip", "two_gib", "--skip", "full_disk"), blockedBy: needsLab },
    { name: "LAN discovery against a DNS-SD responder (loopback)", cmd: cargo("test", "-p", "tyrminal-core", "--test", "discovery_lab", "--quiet", "--", "--ignored") },
    { name: "OS secret store round trip", cmd: cargo("test", "-p", "tyrminal-platform", "--quiet", "--", "--ignored"), blockedBy: needsSecretStore },
    // Pseudo-terminals stand in for serial devices on Unix only; Windows serial is untested.
    ...(process.platform === "win32"
      ? []
      : [{ name: "serial host over a pseudo-terminal pair", cmd: cargo("test", "-p", "tyrminal-core", "--test", "protocols", "--quiet", "--", "--ignored"), blockedBy: needsSocat }]),
    // agent B: tunnels and history
    { name: "port forwarding against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "forward_lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    { name: "SSH through HTTP/SOCKS5 proxies (lab)", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "proxy_lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    { name: "tunnels, jump hosts and proxies through the core (lab)", cmd: cargo("test", "-p", "tyrminal-core", "--test", "tunnels_lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    { name: "sign-in with an OpenSSH user certificate (lab CA)", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "cert_lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    { name: "key exchange policy against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "kex_lab", "--quiet", "--", "--ignored", "--skip", "negotiated_with_a_server_that_offers_it"), blockedBy: needsLab },
    ...(postQuantumOutOfScope()
      ? []
      : [{ name: "post-quantum key exchange negotiated end to end (lab sshd with ML-KEM)", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "kex_lab", "--quiet", "--", "--ignored", "--exact", "post_quantum_key_exchange_is_negotiated_with_a_server_that_offers_it"), env: { TYRMINAL_LAB: pqLabFile }, blockedBy: needsPostQuantumLab }]),
    // agent D: inventory and snippets
    { name: "inventory, keys and snippets against OpenSSH lab", cmd: cargo("test", "-p", "tyrminal-core", "--test", "inventory_lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    // privilege prompts (KEY-18)
    { name: "explicit identity password insertion (lab)", cmd: cargo("test", "-p", "tyrminal-core", "--test", "privilege_lab", "--quiet", "--", "--ignored"), blockedBy: needsLab },
    // P-33: shells in a real container, on Linux only: the macOS and WSL labs have no container
    // engine (B-10). Native CI gives the Linux lab user Docker and sets TYRMINAL_LAB_CONTAINERS;
    // elsewhere on Linux it is BLOCKED until the lab user can use Docker or Podman (never a silent pass).
    ...(process.platform === "linux"
      ? [{
          name: "container shells in a running container (lab with an engine)",
          cmd: cargo("test", "-p", "tyrminal-core", "--test", "containers_lab", "--quiet", "--", "--ignored"),
          blockedBy: () => needsLab() ?? (process.env.TYRMINAL_LAB_CONTAINERS ? null : "needs Docker or Podman usable by the lab user, with alpine:3.22; set TYRMINAL_LAB_CONTAINERS=1 to run"),
        }]
      : []),
  ],
  security: [
    { name: "vault format: tamper, swap, bounds, known answers", cmd: cargo("test", "-p", "tyrminal-vault", "--quiet") },
    { name: "vault service: canary scan, tampering, lock races", cmd: cargo("test", "-p", "tyrminal-core", "--test", "vault_service", "--quiet") },
    { name: "storage: permissions, foreign/newer files, atomicity", cmd: cargo("test", "-p", "tyrminal-storage", "--quiet") },
    { name: "host trust and credentials ordering (lab)", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "lab", "--quiet", "--", "--ignored", "host_key", "credentials"), blockedBy: needsLab },
    { name: "session ownership, lock invalidation, output ceiling (lab)", cmd: cargo("test", "-p", "tyrminal-core", "--test", "sessions_lab", "--quiet", "--", "--ignored", "--skip", "two_gib", "--skip", "full_disk"), blockedBy: needsLab },
    { name: "release policy", cmd: node("scripts/check-release.mjs") },
    // agent B: tunnels and history
    { name: "listener exposure, denied forwarding, link-loss cleanup (lab)", cmd: cargo("test", "-p", "tyrminal-ssh", "--test", "forward_lab", "--quiet", "--", "--ignored", "never_bind", "denies", "lost_link", "limit"), blockedBy: needsLab },
    { name: "changed bastion key, proxy auth rejection, impostor proxy (lab)", cmd: cargo("test", "-p", "tyrminal-core", "--test", "tunnels_lab", "--quiet", "--", "--ignored", "bastion", "proxy", "scoped"), blockedBy: needsLab },
  ],
  native: [
    { name: "packaged application end to end", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/app.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "terminal: full-screen apps, input, mouse, resize, escape corpus", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/terminal.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "snippets: panel, owned-session send, lock", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/snippets.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "SFTP tab: files-only connection, transfers both ways", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/sftp.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "backup and restore through the real application", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/backup.test.mjs")), blockedBy: () => needsE2e() },
    // agent D: inventory and snippets
    { name: "key files through the real application", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/keys.test.mjs")), blockedBy: () => needsE2e() },
    { name: "paste safety (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/paste.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "a refused key installed by password, then used (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/key-install.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "notes: inert Markdown, kept in the vault, code blocks only through the paste review (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/notes.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "search across sessions and command output (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/output.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "startup snippets and environment (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/startup.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    { name: "shell integration through the real application (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/integration.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    // privilege prompts (KEY-18)
    { name: "identity password insertion through the real application (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/privilege.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
    // security review (P-27)
    { name: "security review through the real application", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/security-review.test.mjs")), blockedBy: () => needsE2e() },
    // command history and server at a glance
    { name: "command history and server panel (lab)", cmd: headless(node("--test", "--test-concurrency=1", "--test-timeout=300000", "tests/native/history-glance.test.mjs")), blockedBy: () => needsLab() ?? needsE2e() },
  ],
};

const suiteName = process.argv[2];
const suite = SUITES[suiteName];
if (!suite) {
  console.error(`usage: verify.mjs ${Object.keys(SUITES).join("|")}`);
  process.exit(2);
}

if (suiteName === "integration" && postQuantumOutOfScope()) {
  console.log(`OUT OF SCOPE  post-quantum key exchange negotiated end to end\n         the WSL lab's sshd (${labVersion(labFile)}) has no ML-KEM; SEC-08 records this as BLOCKED on windows-x64`);
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
  const run = spawnSync(command, args, { cwd: root, env: { ...process.env, ...step.env }, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024, timeout: STEP_TIMEOUT_MS });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = run.status === 0;
  if (run.error?.code === "ETIMEDOUT") run.stderr = `${run.stderr ?? ""}\nstep timed out after ${STEP_TIMEOUT_MS / 60000} minutes`;
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

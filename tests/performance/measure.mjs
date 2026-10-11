// Phase 01 measurements on a release-profile build of the real application.
//
//   node scripts/build-e2e.mjs --release && node tests/performance/measure.mjs
//
// The binary measured is the release profile plus the `e2e` automation feature (needed to
// observe the UI). Launch times therefore include starting the embedded WebDriver server and are
// upper bounds for the shipping binary. Results are distributions, never a single best run.
// Raw samples are written to docs/reports/raw/performance.json.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

process.env.TYRMINAL_E2E_BINARY ??= join(import.meta.dirname, "..", "..", "target", "e2e", "release", process.platform === "win32" ? "tyrminal.exe" : "tyrminal");
const { App, root } = await import("../native/harness.mjs");

const PASSPHRASE = "performance fixture passphrase";
const LAUNCH_RUNS = 20;
const IDLE_SECONDS = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heading = (s) => s.execute(`return document.querySelector("h1")?.textContent ?? null`);

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)),
  };
}

function ps() {
  // pid, resident KiB, cpu %, command
  return execFileSync("ps", ["-axo", "pid=,rss=,%cpu=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), rssKiB: Number(m[2]), cpu: Number(m[3]), command: m[4] }));
}

/** Time from process spawn to the first heading being present in the WebView. */
async function timedLaunch(dataDir) {
  const started = performance.now();
  const app = await App.launch({ dataDir });
  while (!(await heading(app.session))) await sleep(2);
  const ms = performance.now() - started;
  return { app, ms: Number(ms.toFixed(1)) };
}

const results = {
  measuredAt: new Date().toISOString(),
  binary: "release profile + e2e feature (test build)",
  host: { platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}` },
};

const dataDir = mkdtempSync(join(os.tmpdir(), "tyrminal-perf-"));
try {
  // ---- first run: create the vault (also gives the first-run-to-onboarding time) ----
  const first = await timedLaunch(dataDir);
  results.firstRunToOnboardingMs = first.ms;
  let s = first.app.session;
  await s.fill("Vault passphrase", PASSPHRASE);
  await s.fill("Repeat passphrase", PASSPHRASE);
  const createStarted = performance.now();
  await s.clickButton("Create vault");
  await s.waitFor(".recovery-key", { timeout: 30_000 });
  results.vaultCreateMs = Number((performance.now() - createStarted).toFixed(1));
  await first.app.quit({ keepData: true });

  // ---- warm launches to the locked screen ----
  const launches = [];
  for (let i = 0; i < LAUNCH_RUNS; i += 1) {
    const { app, ms } = await timedLaunch(dataDir);
    if ((await heading(app.session)) !== "Unlock your vault") throw new Error("expected the locked screen");
    launches.push(ms);
    await app.quit({ keepData: true });
  }
  results.warmLaunchToLockedMs = { ...stats(launches), samples: launches };

  // ---- unlock (Argon2id + load) through the UI, then idle and stream measurements ----
  const before = new Set(ps().map((p) => p.pid));
  const { app } = await timedLaunch(dataDir);
  s = app.session;
  const unlocks = [];
  for (let i = 0; i < 5; i += 1) {
    await s.fill("Passphrase", PASSPHRASE);
    const t = performance.now();
    await s.clickButton("Unlock");
    await s.until(async () => (await heading(s)) === "Hosts", { timeout: 30_000 });
    unlocks.push(Number((performance.now() - t).toFixed(1)));
    if (i < 4) {
      await s.clickButton("Lock vault");
      await s.until(async () => (await heading(s)) === "Unlock your vault");
    }
  }
  results.unlockThroughUiMs = { ...stats(unlocks), samples: unlocks };

  // Idle: the app's own process plus the WebKit helper processes that appeared with it.
  await sleep(10_000);
  const mine = () => ps().filter((p) => p.pid === app.child.pid || (!before.has(p.pid) && /com\.apple\.WebKit|WebView2|msedgewebview/.test(p.command)));
  const idle = [];
  for (let i = 0; i < IDLE_SECONDS; i += 1) {
    const procs = mine();
    idle.push({ rssMiB: procs.reduce((a, p) => a + p.rssKiB, 0) / 1024, cpu: procs.reduce((a, p) => a + p.cpu, 0), processes: procs.length });
    await sleep(1000);
  }
  results.idleUnlockedHome = {
    seconds: IDLE_SECONDS,
    processes: idle.at(-1).processes,
    processTreeRssMiB: stats(idle.map((x) => Number(x.rssMiB.toFixed(1)))),
    cpuPercentOfOneCore: stats(idle.map((x) => Number(x.cpu.toFixed(2)))),
    method: "sum of resident set sizes from ps for the app process and WebKit helper processes started with it; RSS double-counts shared pages, so this overstates unique memory",
  };

  // Stream: a local `seq` flood through PTY → core → IPC → xterm, measured to the last line
  // being rendered, with the renderer acknowledging as it parses.
  await s.clickButton("Local terminal", { within: "nav.sidebar" });
  await s.until(async () => /Connected/.test(await s.execute(`return document.querySelector(".terminal-pane:not([hidden]) .statusbar")?.innerText ?? ""`)));
  const input = await s.waitFor(".terminal-pane:not([hidden]) .xterm-helper-textarea");
  // Fixed-size workload: LINES lines of 79 characters plus a newline (80 bytes each). At the
  // target rate of 5 MiB/s this is more than two minutes of output, so the run sustains the
  // stream for well over 60 seconds.
  const LINES = 8_000_000;
  const bytes = LINES * 80;
  const line = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789abcdefg";
  const rssNow = () => Number((mine().reduce((a, p) => a + p.rssKiB, 0) / 1024).toFixed(1));
  const rssBefore = rssNow();
  await s.type(input, `clear; yes ${line} | head -n ${LINES}; echo stream-$((40+2))\n`);
  const streamStarted = performance.now();
  const rssSamples = [];
  const sampler = setInterval(() => rssSamples.push(rssNow()), 2000);
  try {
    await s.until(async () => /stream-42/.test(await s.execute(`return document.querySelector(".terminal-pane:not([hidden]) .xterm-rows")?.innerText ?? ""`)), { timeout: 600_000, describe: "end of stream" });
  } finally {
    clearInterval(sampler);
  }
  const seconds = (performance.now() - streamStarted) / 1000;
  const tail = await s.execute(`return document.querySelector(".terminal-pane:not([hidden]) .xterm-rows").innerText.split("\\n").filter((l) => l.trim()).slice(-3)`);
  results.terminalStream = {
    workload: `${LINES} lines x 80 bytes through a local PTY`,
    bytes,
    seconds: Number(seconds.toFixed(2)),
    mibPerSecond: Number((bytes / 1048576 / seconds).toFixed(2)),
    lastPayloadLineIntact: tail[0] === line,
    processTreeRssMiB: { before: rssBefore, peak: Math.max(...rssSamples, rssBefore), after: rssNow() },
    note: "end-to-end through the renderer (xterm DOM renderer, 5,000-line scrollback) with acknowledgement flow control; the rate is bounded by terminal parsing and rendering",
  };
  await app.quit({ keepData: true });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

const out = join(root, "docs", "reports", "raw");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "performance.json"), `${JSON.stringify(results, null, 2)}\n`);
const { samples: _a, ...launch } = results.warmLaunchToLockedMs;
const { samples: _b, ...unlock } = results.unlockThroughUiMs;
console.log(JSON.stringify({ firstRunToOnboardingMs: results.firstRunToOnboardingMs, vaultCreateMs: results.vaultCreateMs, warmLaunchToLockedMs: launch, unlockThroughUiMs: unlock, idle: results.idleUnlockedHome, stream: results.terminalStream }, null, 1));

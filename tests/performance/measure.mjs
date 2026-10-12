// Performance measurements on a release-profile build of the real application.
//
//   node scripts/build-e2e.mjs --release && pnpm lab:up && node tests/performance/measure.mjs
//   node tests/performance/measure.mjs --only=latency,stream     # a subset
//
// Sections: launch (cold-ish first run, 20 warm launches), unlock, idle, latency (keystroke to
// rendered echo, local PTY and SSH lab), stream (throughput through each renderer).
//
// The binary measured is the release profile plus the `e2e` automation feature (needed to
// observe the UI). Launch times therefore include starting the embedded WebDriver server and are
// upper bounds for the shipping binary. Results are distributions, never a single best run.
// Raw samples are written to docs/reports/raw/performance-<platform>.json.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

process.env.TYRMINAL_E2E_BINARY ??= join(import.meta.dirname, "..", "..", "target", "e2e", "release", process.platform === "win32" ? "tyrminal.exe" : "tyrminal");
const { App, DOM_RENDERER_PREFS, loadLab, root } = await import("../native/harness.mjs");
const { PASSPHRASE, ui } = await import("../native/flows.mjs");

const only = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "launch,unlock,idle,latency,stream").split(",");
const LAUNCH_RUNS = 20;
const IDLE_SECONDS = 60;
const LATENCY_SAMPLES = 200;
const STREAM_LINES = Number(process.env.TYRMINAL_PERF_STREAM_LINES ?? 1_000_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heading = (s) => s.execute(`return document.querySelector("h1")?.textContent ?? null`);
const round = (n) => Number(n.toFixed(1));

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1), mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

/** pid, resident KiB, cpu %, command. Unix only; Windows memory/CPU is reported as not measured. */
function ps() {
  if (process.platform === "win32") return [];
  return execFileSync("ps", ["-axo", "pid=,rss=,%cpu=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), rssKiB: Number(m[2]), cpu: Number(m[3]), command: m[4] }));
}
const WEBVIEW_HELPERS = /com\.apple\.WebKit|WebKitWebProcess|WebKitNetworkProcess|WebView2|msedgewebview/;

/** Time from process spawn to the first heading being present in the WebView. */
async function timedLaunch(dataDir, prefs) {
  const started = performance.now();
  const app = await App.launch({ dataDir, prefs });
  while (!(await heading(app.session))) await sleep(2);
  return { app, ms: round(performance.now() - started) };
}

async function unlock(s) {
  await s.fill("Passphrase", PASSPHRASE);
  await s.clickButton("Unlock");
  await s.until(async () => (await heading(s)) === "Home", { timeout: 30_000, describe: "home" });
}

const results = {
  measuredAt: new Date().toISOString(),
  binary: "release profile + e2e feature (test build)",
  host: { platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}` },
};

// ---------- in-page latency probe ----------
// Inserts one character at a time into xterm's input element (the same `input` event a real
// keystroke produces) and times until the echoed character is in the rendered rows. Covers
// renderer input handling, IPC to the core, the PTY or SSH channel, the echo, IPC back, parsing
// and the DOM renderer's frame. The OS keyboard path and compositor are not included.
const LATENCY_PROBE = `
  const [count, done] = arguments;
  const pane = document.querySelector(".terminal-pane:not([hidden])");
  const input = pane.querySelector(".xterm-helper-textarea");
  const rows = pane.querySelector(".xterm-rows");
  const visible = () => rows.innerText.replaceAll("\\u00a0", " ").replace(/\\s+$/, "");
  const samples = [];
  let i = 0;
  const next = () => {
    if (i >= count) return done(samples);
    const before = visible();
    const ch = "abcdefghijklmnopqrstuvwxyz"[i % 26];
    const started = performance.now();
    const observer = new MutationObserver(() => {
      const now = visible();
      if (now !== before && now.endsWith(ch)) {
        observer.disconnect();
        samples.push(performance.now() - started);
        i += 1;
        // Keep lines short so wrapping never confuses the check.
        if (i % 40 === 0) input.dispatchEvent(new InputEvent("input", { data: "\\r", inputType: "insertText" }));
        setTimeout(next, 25);
      }
    });
    observer.observe(rows, { childList: true, subtree: true, characterData: true });
    input.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
  };
  next();`;

async function latency(t, s, where) {
  // `cat` with the tty in canonical mode: each character is echoed by the line discipline.
  await t.type("clear; stty echo icanon; cat\n");
  await sleep(500);
  await s.executeAsync(LATENCY_PROBE, [20]); // warm-up
  const samples = (await s.executeAsync(LATENCY_PROBE, [LATENCY_SAMPLES])).map(round);
  await t.type("\u0003");
  return { where, ...stats(samples), samples };
}

const out = join(root, "docs", "reports", "raw");
mkdirSync(out, { recursive: true });
const name = `performance-${process.platform}-${process.arch}.json`;
/** Written after every section, so a later failure never loses earlier measurements. */
const save = () => writeFileSync(join(out, name), `${JSON.stringify(results, null, 2)}\n`);

const dataDir = mkdtempSync(join(os.tmpdir(), "tyrminal-perf-"));
try {
  // ---------- launch ----------
  const first = await timedLaunch(dataDir, DOM_RENDERER_PREFS);
  results.firstRunToOnboardingMs = first.ms;
  let s = first.app.session;
  let t = ui(s);
  const createStarted = performance.now();
  await t.createVault();
  results.vaultCreateAndConfirmMs = round(performance.now() - createStarted);
  await first.app.quit({ keepData: true });

  if (only.includes("launch")) {
    const launches = [];
    for (let i = 0; i < LAUNCH_RUNS; i += 1) {
      const { app, ms } = await timedLaunch(dataDir);
      if ((await heading(app.session)) !== "Unlock your vault") throw new Error("expected the locked screen");
      launches.push(ms);
      await app.quit({ keepData: true });
    }
    results.warmLaunchToLockedMs = { ...stats(launches), samples: launches };
    save();
  }

  const before = new Set(ps().map((p) => p.pid));
  const { app } = await timedLaunch(dataDir);
  s = app.session;
  t = ui(s);
  const mine = () => ps().filter((p) => p.pid === app.child.pid || (!before.has(p.pid) && WEBVIEW_HELPERS.test(p.command)));
  const rssNow = () => round(mine().reduce((a, p) => a + p.rssKiB, 0) / 1024);

  // ---------- unlock ----------
  if (only.includes("unlock")) {
    const unlocks = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      await unlock(s);
      unlocks.push(round(performance.now() - started));
      await s.click(await s.waitFor('nav.sidebar [data-nav="lock"]'));
      await s.until(async () => (await heading(s)) === "Unlock your vault");
    }
    results.unlockThroughUiMs = { ...stats(unlocks), samples: unlocks, note: "includes typing the passphrase over WebDriver" };
    save();
  }
  await unlock(s);

  // ---------- idle ----------
  if (only.includes("idle") && process.platform !== "win32") {
    await sleep(10_000);
    const idle = [];
    for (let i = 0; i < IDLE_SECONDS; i += 1) {
      const procs = mine();
      idle.push({ rssMiB: procs.reduce((a, p) => a + p.rssKiB, 0) / 1024, cpu: procs.reduce((a, p) => a + p.cpu, 0), processes: procs.length });
      await sleep(1000);
    }
    results.idleUnlockedHome = {
      seconds: IDLE_SECONDS,
      processes: idle.at(-1).processes,
      processTreeRssMiB: stats(idle.map((x) => round(x.rssMiB))),
      cpuPercentOfOneCore: stats(idle.map((x) => Number(x.cpu.toFixed(2)))),
      method: "sum of resident set sizes from ps for the app process and WebView helper processes started with it; RSS double-counts shared pages, so this overstates unique memory. ps %cpu is a lifetime average on macOS/Linux.",
    };
  } else if (only.includes("idle")) {
    results.idleUnlockedHome = "not measured on Windows (no ps); BLOCKED for this platform";
  }

  // ---------- latency ----------
  if (only.includes("latency")) {
    results.inputToEcho = [];
    await s.click(await s.waitFor('nav.sidebar [data-nav="local"]'));
    await s.until(async () => /Connected/.test(await t.statusText()), { describe: "local terminal" });
    if (process.platform !== "win32") results.inputToEcho.push(await latency(t, s, "local PTY (/bin/sh-compatible shell, cat)"));
    else results.inputToEcho.push({ where: "local PTY", note: "not measured: ConPTY shells do not provide a POSIX cat/stty fixture" });

    const lab = loadLab();
    await t.importKey(lab.keys.ed25519);
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
    await t.connect("Lab");
    if (lab.mode === "local" && process.platform === "win32") {
      results.inputToEcho.push({ where: "SSH lab", note: "not measured: Windows lab shell has no POSIX tty echo fixture" });
    } else {
      const sample = await latency(t, s, `SSH lab over loopback (${lab.serverVersion})`);
      results.inputToEcho.push(sample);
    }
    save();
    results.inputToEchoMethod =
      "in-page: an `input` event on xterm's textarea to the echoed character appearing in the DOM renderer's rows (MutationObserver); excludes OS input and compositor; 25 ms between keystrokes";
  }

  // ---------- stream ----------
  if (only.includes("stream") && process.platform !== "win32") {
    results.terminalStream = [];
    await app.quit({ keepData: true });
    for (const renderer of ["compatibility", "gpu"]) {
      const run = await timedLaunch(dataDir, { theme: "dark", terminal: { renderer: renderer === "gpu" ? "auto" : "compatibility", cursorBlink: false } });
      const rs = run.app.session;
      const rt = ui(rs);
      await unlock(rs);
      await rs.click(await rs.waitFor('nav.sidebar [data-nav="local"]'));
      await rs.until(async () => /Connected/.test(await rt.statusText()), { describe: "local terminal" });
      const status = await rt.statusText();
      const LINES = STREAM_LINES;
      const bytes = LINES * 80;
      const line = "0123456789abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789abcd";
      // The end marker is a window title, so completion is observable with either renderer.
      // Many default prompts set the window title on every prompt; keep ours.
      await rt.type("PROMPT_COMMAND=; PS1='$ '\n");
      await rt.type(`clear; yes '${line}' | head -n ${LINES}; printf '\\033]0;stream-%s\\007' $((40+2))\n`);
      const started = performance.now();
      await rs.until(
        async () => /stream-42/.test(await rs.execute(`return document.querySelector('[role="tab"][aria-selected="true"]')?.innerText ?? ""`)),
        { timeout: 600_000, describe: "end of stream" },
      );
      const seconds = (performance.now() - started) / 1000;
      results.terminalStream.push({
        renderer: /GPU/.test(status) ? "GPU (WebGL)" : "compatibility (DOM)",
        workload: `${LINES} lines x 80 bytes through a local PTY`,
        bytes,
        seconds: round(seconds),
        mibPerSecond: Number((bytes / 1048576 / seconds).toFixed(2)),
      });
      await run.app.quit({ keepData: true });
      save();
    }
    results.terminalStreamNote =
      "end to end: PTY -> core -> IPC -> xterm parse and render, with acknowledgement flow control; the rate is bounded by parsing and rendering";
  } else {
    await app.quit({ keepData: true });
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

save();
const strip = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "samples")) : v);
const summary = Object.fromEntries(
  Object.entries(results).map(([k, v]) => [k, Array.isArray(v) ? v.map(strip) : strip(v)]),
);
console.log(JSON.stringify(summary, null, 1));

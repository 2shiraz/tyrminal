// Startup performance against the UI test mock (perf project; real clock, CPU raster):
//   - cold start: navigation start to the first interactive Hosts paint, in a fresh browser context
//     each run (no HTTP cache, nothing compiled);
//   - unlock: the Enter that submits the passphrase to the first interactive Hosts paint.
// "Interactive Hosts" means: the Hosts search field is rendered, enabled and outside any inert
// subtree, and the host list shows host rows; the clock stops at the animation frame after that
// state is in the DOM (it has painted). Each run then checks that typing in the search works.
// The mock answers IPC at once, so these time the frontend (download, parse, render), not the
// vault; the IPC calls made before the first paint are listed so the critical path stays short.
// UI evidence only, never native verification.
import { type Browser, type Page, expect, test } from "@playwright/test";

import { type MockOptions, openApp } from "./fixtures";
import { fmt, median, report } from "./perf-stats";

const RUNS = 7;
/** Budgets for the medians (ms), set with headroom over the measured values in this container. */
const COLD_START_BUDGET_MS = 600;
const UNLOCK_BUDGET_MS = 200;
/** The serial-vault variant: each IPC call takes SERIAL_IPC_MS and they queue behind one another. */
const SERIAL_IPC_MS = 10;
const UNLOCK_SERIAL_BUDGET_MS = 250;
/** Script bytes (uncompressed) loaded before the first interactive Hosts paint. */
const STARTUP_SCRIPT_BUDGET_KB = 700;

interface Ready {
  /** performance.now() at the frame after Hosts became interactive (ms since navigation start). */
  at: number;
  /** IPC commands called before that frame. */
  calls: string[];
  /** Script bytes (decoded) loaded before that frame. */
  scriptBytes: number;
}

/** Installs, before the app loads, a probe that resolves `window.__hostsReady` once Hosts is interactive. */
async function installReadyProbe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __hostsReady: Promise<Ready>; __mockCalls?: { cmd: string }[] };
    const interactive = () => {
      const input = document.querySelector<HTMLInputElement>("input.hosts-search-input");
      if (!input || input.disabled || input.closest("[inert]") || input.getClientRects().length === 0) return false;
      const row = document.querySelector<HTMLElement>("[data-testid='host-list'] .host-open, [data-testid='host-list'] .host-card");
      return row !== null && row.getClientRects().length > 0;
    };
    w.__hostsReady = new Promise<Ready>((resolve) => {
      const poll = () => {
        if (!interactive()) {
          requestAnimationFrame(poll);
          return;
        }
        requestAnimationFrame(() => {
          const at = performance.now();
          const scriptBytes = performance
            .getEntriesByType("resource")
            .filter((e) => (e as PerformanceResourceTiming).initiatorType === "script" || e.name.endsWith(".js"))
            .reduce((sum, e) => sum + (e as PerformanceResourceTiming).decodedBodySize, 0);
          resolve({ at, calls: (w.__mockCalls ?? []).map((c) => c.cmd), scriptBytes });
        });
      };
      requestAnimationFrame(poll);
    });
  });
}

/** Typing in the Hosts search filters the list: Hosts really is interactive. */
async function expectSearchWorks(page: Page) {
  const search = page.getByRole("searchbox", { name: /search/i });
  await search.fill("edge-cache");
  await expect(page.getByTestId("host-list").getByRole("button", { name: "edge-cache", exact: true })).toBeVisible();
  await expect(page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true })).toHaveCount(0);
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 860 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
  });
  return context.newPage();
}

async function run(browser: Browser, options: MockOptions, act: (page: Page) => Promise<Ready & { from: number }>) {
  const page = await freshPage(browser);
  try {
    await installReadyProbe(page);
    await openApp(page, { realClock: true, ...options });
    const ready = await act(page);
    await expectSearchWorks(page);
    return ready;
  } finally {
    await page.context().close();
  }
}

test("perf: cold start to the first interactive Hosts paint is within budget", async ({ browser }) => {
  test.setTimeout(120_000);
  const samples: (Ready & { from: number })[] = [];
  for (let i = 0; i < RUNS; i++) {
    samples.push(
      await run(browser, {}, async (page) => ({
        ...(await page.evaluate(() => (window as unknown as { __hostsReady: Promise<Ready> }).__hostsReady)),
        from: 0,
      })),
    );
  }
  const times = samples.map((s) => s.at - s.from);
  const m = median(times);
  const kb = median(samples.map((s) => s.scriptBytes)) / 1024;
  const calls = (samples[0] as Ready).calls;
  report(`cold start to interactive Hosts: median ${m.toFixed(1)} ms (runs: ${fmt(times)}); ${kb.toFixed(0)} KB script; ${calls.length} IPC calls before it: ${calls.join(" ")}`);
  expect(m, "cold start median").toBeLessThanOrEqual(COLD_START_BUDGET_MS);
  expect(kb, "script loaded before the first Hosts paint (KB)").toBeLessThanOrEqual(STARTUP_SCRIPT_BUDGET_KB);
});

async function unlockToHosts(browser: Browser, options: MockOptions) {
  const samples: (Ready & { from: number })[] = [];
  for (let i = 0; i < RUNS; i++) {
    samples.push(
      await run(browser, { ...options, scenario: "locked" }, async (page) => {
        await page.locator("input[type='password']").fill("correct horse");
        // The clock starts on the trusted Enter that submits the form.
        await page.evaluate(() => {
          const w = window as unknown as { __unlockAt: number };
          window.addEventListener(
            "keydown",
            (event) => {
              if (event.isTrusted && event.key === "Enter") w.__unlockAt = performance.now();
            },
            { capture: true, once: true },
          );
        });
        const calledBefore = await page.evaluate(() => (window as unknown as { __mockCalls: unknown[] }).__mockCalls.length);
        await page.keyboard.press("Enter");
        const ready = await page.evaluate(() => (window as unknown as { __hostsReady: Promise<Ready> }).__hostsReady);
        const from = await page.evaluate(() => (window as unknown as { __unlockAt: number }).__unlockAt);
        return { ...ready, calls: ready.calls.slice(calledBefore), from };
      }),
    );
  }
  const times = samples.map((s) => s.at - s.from);
  return { m: median(times), times, calls: (samples[0] as Ready).calls };
}

test("perf: unlock to the first interactive Hosts paint is within budget", async ({ browser }) => {
  test.setTimeout(120_000);
  const { m, times, calls } = await unlockToHosts(browser, {});
  report(`unlock to interactive Hosts: median ${m.toFixed(1)} ms (runs: ${fmt(times)}); ${calls.length} IPC calls between: ${calls.join(" ")}`);
  expect(m, "unlock median").toBeLessThanOrEqual(UNLOCK_BUDGET_MS);
});

// The core serves vault calls one at a time: every call queued before the Hosts list delays it.
test("perf: unlock to Hosts with a one-at-a-time vault is within budget", async ({ browser }) => {
  test.setTimeout(120_000);
  const { m, times, calls } = await unlockToHosts(browser, { ipcSerialMs: SERIAL_IPC_MS });
  report(`unlock to interactive Hosts, vault serving one call per ${SERIAL_IPC_MS} ms: median ${m.toFixed(1)} ms (runs: ${fmt(times)}); ${calls.length} IPC calls between`);
  expect(m, "unlock median (serial vault)").toBeLessThanOrEqual(UNLOCK_SERIAL_BUDGET_MS);
});

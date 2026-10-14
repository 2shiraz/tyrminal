// Hosts with 1,000 hosts (perf project; real clock, CPU raster; UI test mock):
//   - typing in the search: per keystroke, the main-thread work (the key's handlers and React's
//     render, plus the next frame's style, layout and paint) must fit in one 60 Hz frame, at the
//     median and the 95th percentile; input-to-next-paint (which also waits for the frame) is
//     reported, with the long tasks (> 50 ms) while typing, including when the results arrive;
//   - scrolling the list: no long task (> 50 ms), each frame's work within one frame at the 95th
//     percentile and never over 50 ms. Frame gaps are reported (the harness's own calls widen them).
// UI evidence only, never native verification.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";
import { fmt, median, percentile, report } from "./perf-stats";

const HOSTS = 1_000;
/** One 60 Hz frame. */
const FRAME_MS = 16;
const LONG_TASK_MS = 50;
/** The longest task allowed while typing (the results render), set over the measured value. */
const RESULTS_LONG_TASK_MS = 100;
// The first key of a query switches the view from the browse list to search results, which
// replaces the whole list; it gets two frames. Every later key stays within one.
const SWITCH_KEY_MS = 2 * FRAME_MS + 1;
/** A human typing pace: the search results (debounced in the view) arrive between keys. */
const KEY_GAP_MS = 150;
const QUERY = "bulk-host-9";

interface Key {
  /** keydown (event.timeStamp) to just after the next frame painted. */
  paint: number;
  /** keydown to the end of the key's handlers and React's render and commit (window, bubble phase of input). */
  handlers: number;
  /** The next frame: from its first animation frame callback to just after it painted. */
  frame: number;
}

/** Starts collecting long tasks (> 50 ms) into `window.__longTasks`. */
async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __longObserver?: PerformanceObserver };
    w.__longTasks = [];
    w.__longObserver?.disconnect();
    w.__longObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
    });
    w.__longObserver.observe({ type: "longtask" });
  });
}

async function longTasks(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const w = window as unknown as { __longTasks: number[]; __longObserver?: PerformanceObserver };
        // Let pending entries be delivered first.
        setTimeout(() => {
          for (const entry of w.__longObserver?.takeRecords() ?? []) w.__longTasks.push(entry.duration);
          w.__longObserver?.disconnect();
          resolve(w.__longTasks);
        }, 100);
      }),
  );
}

/** Presses `key` in the focused search and returns its timings. */
async function timedKey(page: Page, key: string): Promise<Key> {
  await page.evaluate(() => {
    const w = window as unknown as { __key: Promise<Key> };
    w.__key = new Promise<Key>((resolve) => {
      let down = 0;
      let handled = 0;
      const onDown = (event: KeyboardEvent) => {
        if (!event.isTrusted) return;
        window.removeEventListener("keydown", onDown, true);
        down = event.timeStamp;
        requestAnimationFrame(() => {
          const frameStart = performance.now();
          // A message posted from an animation frame callback runs after that frame painted.
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            const end = performance.now();
            resolve({ paint: end - down, handlers: (handled || frameStart) - down, frame: end - frameStart });
          };
          channel.port2.postMessage(null);
        });
      };
      const onInput = () => {
        handled = performance.now();
        window.removeEventListener("input", onInput, false);
      };
      window.addEventListener("keydown", onDown, true);
      window.addEventListener("input", onInput, false);
    });
  });
  await page.keyboard.press(key);
  return page.evaluate(() => (window as unknown as { __key: Promise<Key> }).__key);
}

async function openBigHosts(page: Page) {
  await openApp(page, { realClock: true, extraHosts: HOSTS, hostsLayout: "list" });
  const list = page.getByTestId("host-list");
  await expect(list).toHaveAttribute("data-windowed", "true");
  await expect(list.getByRole("button", { name: "bulk-host-001", exact: true })).toBeVisible();
  return list;
}

test("perf: typing in the Hosts search with 1,000 hosts fits in a frame", async ({ page }) => {
  test.setTimeout(120_000);
  const list = await openBigHosts(page);
  const search = page.getByRole("searchbox", { name: "Search hosts" });
  // Warm-up: one query typed and cleared (first renders, first search).
  await search.click();
  await page.keyboard.type("bulk", { delay: KEY_GAP_MS });
  await expect(list.getByRole("button", { name: "api-gateway", exact: true })).toHaveCount(0);
  await search.fill("");
  await expect(list.getByRole("button", { name: "api-gateway", exact: true })).toBeVisible();

  const keys: Key[] = [];
  const switches: number[] = [];
  const longs: number[] = [];
  for (let round = 0; round < 2; round++) {
    await watchLongTasks(page);
    for (const [i, ch] of [...QUERY].entries()) {
      const key = await timedKey(page, ch);
      if (i === 0) switches.push(key.handlers + key.frame);
      else keys.push(key);
      await page.waitForTimeout(KEY_GAP_MS);
    }
    // The results for the whole query: bulk-host-9, bulk-host-90..99, bulk-host-900..999.
    await expect(list).toHaveAttribute("aria-label", /result/i);
    await expect(list.getByRole("button", { name: "bulk-host-9", exact: false }).first()).toBeVisible();
    await expect(list.getByRole("button", { name: "bulk-host-001", exact: true })).toHaveCount(0);
    longs.push(...(await longTasks(page)));
    await search.fill("");
    await expect(list.getByRole("button", { name: "bulk-host-001", exact: true })).toBeVisible();
  }

  const work = keys.map((k) => k.handlers + k.frame);
  const paint = keys.map((k) => k.paint);
  report(
    `Hosts search, ${HOSTS} hosts, per keystroke: work median ${median(work).toFixed(1)} ms, p95 ${percentile(work, 0.95).toFixed(1)} ms ` +
      `(handlers ${median(keys.map((k) => k.handlers)).toFixed(1)}, frame ${median(keys.map((k) => k.frame)).toFixed(1)}); ` +
      `input-to-next-paint median ${median(paint).toFixed(1)} ms, p95 ${percentile(paint, 0.95).toFixed(1)} ms (work runs: ${fmt(work)}); ` +
      `first key of each query (browse -> results): ${fmt(switches)} ms; ` +
      `long tasks while typing: ${longs.length ? fmt(longs) : "none"}`,
  );
  expect(median(work), "keystroke work median").toBeLessThanOrEqual(FRAME_MS);
  expect(percentile(work, 0.95), "keystroke work p95").toBeLessThanOrEqual(FRAME_MS);
  expect(Math.max(...switches), "first key of a query (browse -> results)").toBeLessThanOrEqual(SWITCH_KEY_MS);
  // The results arrive between keys and replace the list; the 111 results of the full query are
  // fewer than the windowing threshold, so all of them render at once.
  expect(Math.max(0, ...longs), "longest task while typing").toBeLessThanOrEqual(RESULTS_LONG_TASK_MS);
});

test("perf: scrolling the Hosts list with 1,000 hosts has no long tasks", async ({ page }) => {
  test.setTimeout(120_000);
  const list = await openBigHosts(page);
  await list.getByRole("button", { name: "bulk-host-001", exact: true }).hover();
  // Warm-up: one pass down and back.
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 600);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -600);

  await watchLongTasks(page);
  // Every frame: the gap since the previous one, and its work (from its first animation frame
  // callback, which runs before the list's own, to just after it painted).
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __work: number[]; __gapsOn: boolean };
    w.__gaps = [];
    w.__work = [];
    w.__gapsOn = true;
    let last = performance.now();
    const channel = new MessageChannel();
    let started = 0;
    channel.port1.onmessage = () => w.__work.push(performance.now() - started);
    const tick = () => {
      const now = performance.now();
      w.__gaps.push(now - last);
      last = now;
      started = now;
      channel.port2.postMessage(null);
      if (w.__gapsOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Wheel steps of about 25 rows (52 px each): down to the end of the list and back to the top.
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const last = list.getByRole("button", { name: "bulk-host-999", exact: true });
  const first = list.getByRole("button", { name: "api-gateway", exact: true });
  let steps = 0;
  for (; steps < 200 && (await last.count()) === 0; steps++) {
    await page.mouse.wheel(0, 1_300);
    await frame();
  }
  await expect(last).toBeVisible();
  await expect(list.getByRole("button", { name: "bulk-host-001", exact: true })).toHaveCount(0);
  for (let i = 0; i < 200 && (await first.count()) === 0; i++, steps++) {
    await page.mouse.wheel(0, -1_300);
    await frame();
  }
  await expect(first).toBeVisible();
  const { gaps, work } = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __work: number[]; __gapsOn: boolean };
    w.__gapsOn = false;
    return { gaps: w.__gaps.slice(1), work: w.__work };
  });
  const long = await longTasks(page);
  const worst = Math.max(...gaps);
  const worstWork = Math.max(...work);
  report(
    `Hosts scroll, ${HOSTS} hosts, ${steps} wheel steps: ${gaps.length} frames, gap median ${median(gaps).toFixed(1)} ms, p95 ${percentile(gaps, 0.95).toFixed(1)} ms, worst ${worst.toFixed(1)} ms; ` +
      `frame work median ${median(work).toFixed(1)} ms, p95 ${percentile(work, 0.95).toFixed(1)} ms, worst ${worstWork.toFixed(1)} ms; ` +
      `long tasks: ${long.length ? fmt(long) : "none"}`,
  );
  expect(long, "long tasks while scrolling").toEqual([]);
  expect(percentile(work, 0.95), "frame work p95 while scrolling").toBeLessThanOrEqual(FRAME_MS);
  expect(worstWork, "worst frame work while scrolling").toBeLessThanOrEqual(LONG_TASK_MS);
});

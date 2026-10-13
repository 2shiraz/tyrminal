// Afterglow performance smoke (experimental UI, branch only; plan §10.3). Headless Chromium with
// software GL is not a performance measurement: these record frame intervals and long tasks during
// the motion-heavy moments for comparison between runs, and assert only structural guarantees
// (what animates, and that nothing blocks the main thread for long). Real WebView2 and WebKitGTK
// recordings on a mid-range laptop are still needed before calling the motion smooth.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function allowMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
}

/** Starts recording rAF intervals and long tasks; returns a function that stops and summarises. */
async function record(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: number[]; stop: boolean } };
    w.__perf = { frames: [], long: [], stop: false };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.long.push(e.duration);
    }).observe({ type: "longtask", buffered: false });
    let last = performance.now();
    const tick = (now: number) => {
      w.__perf.frames.push(now - last);
      last = now;
      if (!w.__perf.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __perf: { frames: number[]; long: number[]; stop: boolean } };
      w.__perf.stop = true;
      const f = [...w.__perf.frames].sort((a, b) => a - b);
      const p = (q: number) => Math.round((f[Math.min(f.length - 1, Math.floor(f.length * q))] ?? 0) * 10) / 10;
      return { frames: f.length, p50: p(0.5), p95: p(0.95), longTasks: w.__perf.long.length, longest: Math.round(Math.max(0, ...w.__perf.long)) };
    });
}

test.describe("Afterglow performance smoke", () => {
  test("toast burst: ten toasts in about a second", async ({ page }) => {
    await openApp(page, { renderer: "compatibility" });
    await allowMotion(page);
    await page.keyboard.press("Control+Shift+K");
    await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
    await page.keyboard.press("Enter");
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    await page.keyboard.press("Control+Shift+S");
    const run = page.getByRole("button", { name: "Run Disk usage in the terminal" });
    await expect(run).toBeVisible();
    // The panel loads on first use: let it settle before recording.
    await page.waitForTimeout(800);
    const stop = await record(page);
    for (let i = 0; i < 10; i += 1) {
      await run.click();
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(400);
    const summary = await stop();
    console.log("toast burst", JSON.stringify(summary));
    // The deck keeps at most four toasts, and moves them with transform and opacity only.
    expect(await page.locator(".toasts > .toast").count()).toBeLessThanOrEqual(4);
    expect(summary.longest).toBeLessThan(250);
  });

  test("tab storm: twenty pointer switches across eight tabs", async ({ page }) => {
    await openApp(page, { renderer: "compatibility" });
    await allowMotion(page);
    const tabs = page.locator(".tabstrip-tabs .tab:not(.tab-page)");
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Control+Shift+T");
      await expect(tabs).toHaveCount(i + 1);
    }
    await page.waitForTimeout(300);
    const stop = await record(page);
    for (let i = 0; i < 20; i += 1) {
      await tabs.nth((i * 3) % 8).click();
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    const summary = await stop();
    console.log("tab storm", JSON.stringify(summary));
    // The pill is a childless, strictly contained element: its width change reflows nothing.
    expect(await page.locator(".tab-pill-indicator").count()).toBe(0);
    expect(summary.longest).toBeLessThan(250);
  });

  test("2,000-host list: scrolling the windowed list", async ({ page }) => {
    await openApp(page, { extraHosts: 2000, hostsLayout: "list" });
    await allowMotion(page);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await expect(page.getByTestId("host-list")).toBeVisible();
    const stop = await record(page);
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.move(900, 500);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);
    const summary = await stop();
    console.log("host list scroll", JSON.stringify(summary));
    expect(summary.longest).toBeLessThan(250);
  });

  test("tab storm: style, layout and script time, for comparison with main", async ({ page }) => {
    await openApp(page, { renderer: "compatibility" });
    await allowMotion(page);
    const tabs = page.locator(".tabstrip-tabs .tab:not(.tab-page)");
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Control+Shift+T");
      await expect(tabs).toHaveCount(i + 1);
    }
    await page.waitForTimeout(500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const before = await metrics();
    for (let i = 0; i < 20; i += 1) {
      await tabs.nth((i * 3) % 8).click();
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    const after = await metrics();
    const ms = (k: string) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
    // Main's build measured 0.6 s of style and 0.22 s of layout for this storm on this container.
    console.log("tab storm work", JSON.stringify({ styleMs: ms("RecalcStyleDuration"), layoutMs: ms("LayoutDuration"), scriptMs: ms("ScriptDuration") }));
    expect(ms("RecalcStyleDuration")).toBeLessThan(3000);
  });
});

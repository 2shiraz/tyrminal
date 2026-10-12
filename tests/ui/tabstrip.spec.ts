// The tab strip: browser-style tabs, "+" right after the last tab, horizontal-only overflow, the
// active tab wider than the others, and no animation under reduced motion. Mock backend; the
// geometry is measured in the page. Never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const strip = (page: Page) => page.locator(".tabstrip");
const scroller = (page: Page) => page.locator(".tabstrip-scroll");
const terminalTabs = (page: Page) => page.getByRole("tablist", { name: "Open sessions" }).locator(".tab:not(.tab-page)");
const plus = (page: Page) => page.getByRole("button", { name: "New tab" });

async function openLocalTabs(page: Page, count: number) {
  for (let i = 0; i < count; i += 1) {
    const before = await terminalTabs(page).count();
    await page.keyboard.press("Control+Shift+T");
    await expect(terminalTabs(page)).toHaveCount(before + 1);
  }
}

const box = async (page: Page, selector: string, index = 0) =>
  page.evaluate(
    ([s, i]) => {
      const r = document.querySelectorAll(s as string)[i as number]?.getBoundingClientRect();
      return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
    },
    [selector, index] as const,
  );

test("the first tab starts at the strip's left edge", async ({ page }) => {
  await openApp(page);
  const s = await box(page, ".tabstrip");
  const first = await box(page, ".tabstrip-tabs .tab");
  expect(first!.left - s!.left).toBeGreaterThanOrEqual(0);
  expect(first!.left - s!.left).toBeLessThanOrEqual(4);
});

test("page and session tabs share one height and baseline; only the active tab is filled", async ({ page }) => {
  await openApp(page);
  await openLocalTabs(page, 2);
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll(".tabstrip-tabs .tab")].map((t) => {
      const r = t.getBoundingClientRect();
      return { height: r.height, bottom: r.bottom, selected: t.getAttribute("aria-selected") === "true", fill: getComputedStyle(t).backgroundColor };
    }),
  );
  expect(geometry.length).toBe(3);
  for (const g of geometry) {
    expect(g.height).toBe(geometry[0]!.height);
    expect(g.bottom).toBe(geometry[0]!.bottom);
  }
  for (const g of geometry.filter((x) => !x.selected)) expect(g.fill).toBe("rgba(0, 0, 0, 0)");
  expect(geometry.find((x) => x.selected)!.fill).not.toBe("rgba(0, 0, 0, 0)");
});

test('"+" sits right after the last tab, also after tabs close, and is centred on the tabs', async ({ page }) => {
  await openApp(page);
  await openLocalTabs(page, 6);
  // Close three with the pointer (the × on hover), as a user would.
  for (let i = 0; i < 3; i += 1) {
    const last = terminalTabs(page).last();
    await last.hover();
    await last.locator(".tab-close").click();
  }
  await expect(terminalTabs(page)).toHaveCount(3);
  await expect
    .poll(async () => {
      const last = await box(page, ".tabstrip-tabs .tab", 3);
      const p = (await plus(page).boundingBox())!;
      return Math.round(p.x - last!.right);
    })
    .toBeLessThanOrEqual(8);
  const last = await box(page, ".tabstrip-tabs .tab", 3);
  const p = (await plus(page).boundingBox())!;
  expect(p.x - last!.right).toBeGreaterThanOrEqual(0);
  // Vertically centred on the tab, not on the strip's top or bottom edge.
  const tabMiddle = last!.top + last!.height / 2;
  expect(Math.abs(p.y + p.height / 2 - tabMiddle)).toBeLessThanOrEqual(2);
});

test("many tabs scroll sideways only: no vertical scroll, + stays reachable, the active tab is in view", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openApp(page);
  // The most a window holds (16 panes).
  await openLocalTabs(page, 16);
  const sizes = await scroller(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sizes.sw).toBeGreaterThan(sizes.cw);
  expect(sizes.sh).toBeLessThanOrEqual(sizes.ch);
  const stripSizes = await strip(page).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(stripSizes.sh).toBeLessThanOrEqual(stripSizes.ch);
  // "+" stays inside the strip at its right end.
  const s = (await strip(page).boundingBox())!;
  const p = (await plus(page).boundingBox())!;
  expect(p.x + p.width).toBeLessThanOrEqual(s.x + s.width + 0.5);
  // The newest (active) tab is fully visible.
  const active = (await page.locator('.tabstrip-tabs .tab[aria-selected="true"]').boundingBox())!;
  const view = (await scroller(page).boundingBox())!;
  expect(active.x).toBeGreaterThanOrEqual(view.x - 0.5);
  expect(active.x + active.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
  // The mouse wheel scrolls the strip sideways.
  await scroller(page).evaluate((el) => {
    el.scrollLeft = 0;
  });
  await scroller(page).hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test("tabs shrink evenly before the strip scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await openApp(page);
  await openLocalTabs(page, 4);
  // Four session tabs and "+" fit once the inactive tabs give up some width: nothing scrolls.
  const s = await scroller(page).evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft }));
  expect(s.sw).toBeLessThanOrEqual(s.cw);
  expect(s.left).toBe(0);
  const widths = await terminalTabs(page).evaluateAll((els) =>
    els.filter((e) => e.getAttribute("aria-selected") !== "true").map((e) => Math.round(e.getBoundingClientRect().width)),
  );
  expect(new Set(widths).size).toBe(1);
  expect(widths[0]!).toBeLessThan(180);
});

test("the active tab is wider than the inactive ones", async ({ page }) => {
  await openApp(page);
  await openLocalTabs(page, 3);
  await terminalTabs(page).nth(1).click();
  await expect(terminalTabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const widths = await terminalTabs(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
      return widths[1]! > widths[0]! && widths[1]! > widths[2]!;
    })
    .toBe(true);
  // Inactive tabs keep room for the status dot, a few letters and the close button.
  const inactive = (await terminalTabs(page).nth(0).boundingBox())!;
  expect(inactive.width).toBeGreaterThanOrEqual(64);
});

test("reduced motion: switching tabs does not animate", async ({ page }) => {
  await openApp(page);
  await openLocalTabs(page, 3);
  await terminalTabs(page).nth(0).click();
  const running = await page.evaluate(() =>
    document
      .querySelector(".tabstrip")!
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === "running").length,
  );
  expect(running).toBe(0);
  const durations = await terminalTabs(page).evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDuration));
  for (const d of durations) expect(d.split(",").every((x) => Number.parseFloat(x) === 0)).toBe(true);
});

/**
 * Samples the widths of two tabs every 8 ms while `act` runs, for `ms` (a timer rather than
 * requestAnimationFrame, which headless Chromium may run only a few times a second; layout reads
 * return the transition's value at that moment either way).
 */
async function sampleWidths(page: Page, a: number, b: number, act: () => Promise<void>, ms = 450) {
  await page.evaluate(
    ([ia, ib]) => {
      const w = window as unknown as { __frames: [number, number][]; __sampler: number };
      const tabs = () => [...document.querySelectorAll(".tabstrip-tabs > .tab:not(.tab-page)")];
      const sample = () => {
        const t = tabs();
        w.__frames.push([t[ia as number]!.getBoundingClientRect().width, t[ib as number]!.getBoundingClientRect().width]);
      };
      w.__frames = [];
      sample();
      w.__sampler = window.setInterval(sample, 8);
    },
    [a, b] as const,
  );
  await act();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: [number, number][]; __sampler: number };
    window.clearInterval(w.__sampler);
    return w.__frames;
  });
}

test("a pointer switch: the old tab narrows while the new one widens, in step, frame by frame", async ({ page }) => {
  // The DOM renderer, as the other terminal specs: software WebGL in a headless container keeps
  // the main thread too busy to sample.
  await openApp(page, { renderer: "compatibility" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
  await openLocalTabs(page, 3);
  await page.waitForTimeout(400);
  // Tab 2 is active; click tab 0. Sample [tab 0, tab 2] every frame.
  const frames = await sampleWidths(page, 0, 2, () => terminalTabs(page).nth(0).click());
  const first = frames[0]!;
  const last = frames.at(-1)!;
  expect(last[0]).toBeGreaterThan(first[0] + 40);
  expect(last[1]).toBeLessThan(first[1] - 40);
  // Monotonic: the new tab only grows and the old one only shrinks.
  for (let k = 1; k < frames.length; k += 1) {
    expect(frames[k]![0]).toBeGreaterThanOrEqual(frames[k - 1]![0] - 0.5);
    expect(frames[k]![1]).toBeLessThanOrEqual(frames[k - 1]![1] + 0.5);
  }
  // Simultaneous: both start on the same frame, and their sum never jumps (same duration and easing).
  const startA = frames.findIndex((f) => Math.abs(f[0] - first[0]) > 0.5);
  const startB = frames.findIndex((f) => Math.abs(f[1] - first[1]) > 0.5);
  expect(startA).toBeGreaterThan(0);
  expect(Math.abs(startA - startB)).toBeLessThanOrEqual(0);
  const sum = first[0] + first[1];
  for (const f of frames) expect(Math.abs(f[0] + f[1] - sum)).toBeLessThanOrEqual(2);
  // It is a glide, not a jump: several intermediate frames.
  const between = frames.filter((f) => f[0] > first[0] + 1 && f[0] < last[0] - 1).length;
  expect(between).toBeGreaterThanOrEqual(3);
  // The tabs never move by transform.
  const transformed = await terminalTabs(page).evaluateAll((els) => els.some((e) => e.getAnimations().some((x) => !(x instanceof CSSTransition))));
  expect(transformed).toBe(false);
});

test("a keyboard switch changes the widths in one step", async ({ page }) => {
  // The DOM renderer, as the other terminal specs: software WebGL in a headless container keeps
  // the main thread too busy to sample.
  await openApp(page, { renderer: "compatibility" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
  await openLocalTabs(page, 3);
  await page.waitForTimeout(400);
  await terminalTabs(page).nth(2).focus();
  await page.keyboard.press("ArrowLeft");
  const frames = await sampleWidths(page, 1, 2, () => page.keyboard.press("Enter"), 300);
  await expect(terminalTabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  const first = frames[0]!;
  const last = frames.at(-1)!;
  const between = frames.filter((f) => f[0] > first[0] + 1 && f[0] < last[0] - 1).length;
  expect(last[0]).toBeGreaterThan(first[0] + 40);
  expect(between).toBe(0);
});

test("closing with the pointer narrows the tab to nothing, then removes it", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
  await openLocalTabs(page, 3);
  await page.waitForTimeout(400);
  const target = terminalTabs(page).nth(1);
  await target.hover();
  const frames = await sampleWidths(page, 1, 2, () => target.locator(".tab-close").click(), 120);
  const widths = frames.map((f) => f[0]);
  expect(widths[0]).toBeGreaterThan(100);
  expect(widths.filter((w) => w > 1 && w < widths[0]! - 1).length).toBeGreaterThanOrEqual(2);
  for (let k = 1; k < widths.length; k += 1) expect(widths[k]!).toBeLessThanOrEqual(widths[k - 1]! + 0.5);
  await expect(terminalTabs(page)).toHaveCount(2);
});

test("status dots in tabs are plain 8 px dots, with no halo or ring", async ({ page }) => {
  await openApp(page);
  await openLocalTabs(page, 2);
  const dots = await page.locator(".tabstrip-tabs .tab-lead .status-dot").evaluateAll((els) =>
    els.map((e) => {
      const s = getComputedStyle(e);
      return { w: e.getBoundingClientRect().width, shadow: s.boxShadow, outline: s.outlineStyle };
    }),
  );
  expect(dots.length).toBe(2);
  for (const d of dots) {
    expect(d.w).toBe(8);
    expect(d.shadow).toBe("none");
    expect(d.outline).toBe("none");
  }
});

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

test("with motion on, a pointer switch animates the widths and a keyboard switch does not", async ({ page }) => {
  await openApp(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openLocalTabs(page, 3);
  await terminalTabs(page).nth(0).click();
  await expect(strip(page)).toHaveAttribute("data-input", "pointer");
  // (While pressed, the press feedback turns transitions off; they return on release.)
  await expect.poll(() => terminalTabs(page).nth(0).evaluate((e) => getComputedStyle(e).transitionProperty)).toContain("width");
  await terminalTabs(page).nth(0).press("ArrowRight");
  await expect(strip(page)).toHaveAttribute("data-input", "keyboard");
  const keyboard = await terminalTabs(page).nth(1).evaluate((e) => getComputedStyle(e).transitionProperty);
  expect(keyboard).not.toContain("width");
});

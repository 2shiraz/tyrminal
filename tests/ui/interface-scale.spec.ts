// Interface size against the UI test mock: the factor the interface asks the native web view to
// zoom by (emulated in the mock with CSS zoom). Auto follows the window; a chosen size overrides
// it and persists; the terminal refits to the new cell size.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp, openSettings, waitForTerminalText } from "./fixtures";

const zooms = (page: Page) => page.evaluate(() => (window as unknown as { __mockZoom?: number[] }).__mockZoom ?? []);
const scale = (page: Page) => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale") || 1));
const bodyFont = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));

test("interface size: Auto scales up on a 2560×1440 window, so body text is at least 15px", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await openApp(page);
  await expect.poll(() => zooms(page)).toEqual([1.35]);
  const factor = await scale(page);
  expect(factor).toBeGreaterThan(1);
  // Native zoom multiplies CSS pixels: what the user sees is the font size times the factor.
  expect((await bodyFont(page)) * factor).toBeGreaterThanOrEqual(15);
});

test("interface size: 100% at the reference window, nothing is zoomed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.waitForTimeout(300);
  expect(await zooms(page)).toEqual([]);
});

test("interface size: a chosen size overrides Auto and persists across a restart", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await openApp(page);
  await expect.poll(() => zooms(page)).toEqual([1.35]);
  await openSettings(page, "Appearance");
  await page.getByRole("combobox", { name: "Interface size" }).selectOption("110");
  await expect.poll(() => zooms(page)).toEqual([1.35, 1.1]);
  // Resizing does not change a chosen size.
  await page.setViewportSize({ width: 2400, height: 1400 });
  await page.waitForTimeout(400);
  expect((await zooms(page)).at(-1)).toBe(1.1);

  await page.reload();
  await expect.poll(async () => (await zooms(page)).at(-1)).toBe(1.1);
  await openSettings(page, "Appearance");
  await expect(page.getByRole("combobox", { name: "Interface size" })).toHaveValue("110");
});

test("interface size: Cmd/Ctrl + = and 0 change it outside a terminal, and a terminal refits", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await connectHost(page, "api-gateway");
  await waitForTerminalText(page, "deploy@api-gateway");
  const resizes = () =>
    page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string; args: { cols: number } }[] }).__mockCalls.filter((c) => c.cmd === "session_resize").map((c) => c.args.cols));
  const before = await resizes();

  // Focus outside the terminal: the interface grows, and the terminal refits to fewer columns.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement?.closest(".terminal-pane") == null)).toBe(true);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(async () => (await zooms(page)).at(-1)).toBe(1.1);
  await expect.poll(async () => (await resizes()).length).toBeGreaterThan(before.length);
  const cols = await resizes();
  expect(cols.at(-1)).toBeLessThan(before.at(-1) ?? Number.POSITIVE_INFINITY);

  await page.keyboard.press(`${mod}+Digit0`);
  await expect.poll(async () => (await zooms(page)).at(-1)).toBe(1);
});

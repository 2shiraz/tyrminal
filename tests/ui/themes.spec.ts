// Application color themes (Settings → Appearance). Production frontend with the test-only mock
// backend: this checks the picker, the tokens it selects and what is saved, not native storage.
import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const root = (page: Page) => page.locator("html");
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const saved = (page: Page) => page.evaluate(() => (window as unknown as { __mockState: { prefs: { palette?: string } } }).__mockState.prefs.palette);
const themes = (page: Page) => page.getByRole("radiogroup", { name: "Color theme" });

test("the default theme is Cobalt, a blue, in dark and in light", async ({ page }) => {
  await openApp(page);
  await expect(root(page)).not.toHaveAttribute("data-palette", /.*/);
  expect(await token(page, "--accent")).toBe("#6aa5ff");
  expect(await token(page, "--bg-app")).toBe("#0c111b");
  await openApp(page, { theme: "light" });
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  expect(await token(page, "--accent")).toBe("#1f5fd1");
});

test("choosing a theme applies at once, is saved, and each theme has a light mode", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const list = themes(page);
  await expect(list.getByRole("radio")).toHaveCount(5);
  await expect(list.getByRole("radio", { name: /^Cobalt/ })).toBeChecked();

  await list.getByRole("radio", { name: /^Verdigris/ }).click();
  await expect(root(page)).toHaveAttribute("data-palette", "verdigris");
  await expect(list.getByRole("radio", { name: /^Verdigris/ })).toBeChecked();
  expect(await token(page, "--accent")).toBe("#68c9b7");
  await expect.poll(() => saved(page)).toBe("verdigris");

  // The mode is a separate choice and keeps the theme.
  await page.getByRole("radiogroup", { name: "Mode" }).getByText("Light", { exact: true }).click();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-palette", "verdigris");
  expect(await token(page, "--accent")).toBe("#176d60");

  // Back to the default: the attribute goes, so the plain tokens apply.
  await list.getByRole("radio", { name: /^Cobalt/ }).click();
  await expect(root(page)).not.toHaveAttribute("data-palette", /.*/);
  await expect.poll(() => saved(page)).toBe("cobalt");
});

test("arrow keys move the choice like any radio group, with one tab stop", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const list = themes(page);
  await list.getByRole("radio", { name: /^Cobalt/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(list.getByRole("radio", { name: /^Verdigris/ })).toBeChecked();
  await expect(list.getByRole("radio", { name: /^Verdigris/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(list.getByRole("radio", { name: /^High contrast/ })).toBeChecked();
  await expect(root(page)).toHaveAttribute("data-palette", "contrast");
  await page.keyboard.press("ArrowRight");
  await expect(list.getByRole("radio", { name: /^Cobalt/ })).toBeChecked();
  expect(await list.locator('[role="radio"][tabindex="0"]').count()).toBe(1);
});

test("a stored theme is used at start; one this version does not know shows the default", async ({ page }) => {
  await openApp(page, { palette: "graphite" });
  await expect(root(page)).toHaveAttribute("data-palette", "graphite");
  expect(await token(page, "--accent")).toBe("#a9a6f7");
  await openApp(page, { palette: "a-theme-from-a-newer-version" });
  await expect(root(page)).not.toHaveAttribute("data-palette", /.*/);
  await openSettings(page);
  await expect(themes(page).getByRole("radio", { name: /^Cobalt/ })).toBeChecked();
});

test("the terminal keeps its own color scheme when the app theme changes", async ({ page }) => {
  await openApp(page);
  const before = await token(page, "--scheme-bg");
  await openSettings(page);
  await themes(page).getByRole("radio", { name: /^Graphite/ }).click();
  await expect(root(page)).toHaveAttribute("data-palette", "graphite");
  expect(await token(page, "--scheme-bg")).toBe(before);
});

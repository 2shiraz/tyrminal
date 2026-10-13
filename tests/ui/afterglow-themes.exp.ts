// Afterglow theme cards and the new-tab page (experimental UI, branch only; plan §6 moment 7,
// §7.4). UI-only mock backend; never counts as native verification.
import { expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

test("theme cards choose the scheme exactly as the select does; the select stays the accessible control", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.keyboard.press("Control+Shift+T");
  await page.keyboard.press("Control+Shift+S");
  await page.locator(".panel-sections").getByRole("tab", { name: "Appearance", exact: true }).click();
  const cards = page.locator(".theme-card");
  await expect(cards.first()).toBeVisible();
  // A pointer shortcut only: hidden from assistive technology and out of the tab order.
  await expect(page.locator(".theme-cards")).toHaveAttribute("aria-hidden", "true");
  expect(await cards.evaluateAll((els) => els.every((e) => e.getAttribute("tabindex") === "-1"))).toBe(true);
  const select = page.getByRole("combobox", { name: "Color scheme" });
  await expect(select).toHaveValue("tyrminal-night");
  await expect(page.locator('.theme-card[data-current] .theme-card-name')).toHaveText("Afterglow Night");

  await page.locator(".theme-card", { hasText: "Dracula" }).click();
  await expect(select).toHaveValue("dracula");
  await expect(page.locator('.theme-card[data-current] .theme-card-name')).toHaveText("Dracula");
  await expect(page.locator(".theme-card[data-current] .theme-check")).toBeVisible();
});

test("a new tab's start page keeps the app's colours in its tab and status bar", async ({ page }) => {
  await openApp(page, { theme: "light" });
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.locator(".start-page")).toBeVisible();
  const colours = await page.evaluate(() => ({
    bar: getComputedStyle(document.querySelector(".statusbar")!).backgroundColor,
    canvas: getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim(),
  }));
  expect(colours.bar).toBe("rgb(246, 246, 249)");
  expect(colours.canvas).toBe("#f6f6f9");
});

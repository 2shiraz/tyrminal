// Broadcast target review with exclusion (P-13). Mock backend: per-session input is recorded,
// so each assertion names exactly which sessions received what. Never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { waitForTerminalText } from "./fixtures";
import { inputs, openLocal, paletteRun, sentSince } from "./input-helpers";

async function threePanes(page: Page) {
  await openLocal(page);
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(2);
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(3);
  await waitForTerminalText(page, "$");
}

async function focusPane(page: Page, index: number) {
  await page.locator(".pane").nth(index).locator(".xterm-screen").click();
  await expect(page.locator(".pane").nth(index).locator(".xterm-helper-textarea")).toBeFocused();
}

/** Opens the review for the active tab. */
async function review(page: Page) {
  await paletteRun(page, "Type into every pane");
  const dialog = page.getByRole("alertdialog", { name: /Type into these \d panes\?/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("broadcast review: every pane is listed and can be left out; at least two must stay", async ({ page }) => {
  await threePanes(page);
  const dialog = await review(page);
  const boxes = dialog.getByRole("checkbox");
  await expect(boxes).toHaveCount(3);
  for (const box of await boxes.all()) await expect(box).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Type into 3 panes" })).toBeEnabled();

  await boxes.nth(1).uncheck();
  await expect(page.getByRole("alertdialog", { name: "Type into these 2 panes?" })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("1 pane left out: it keeps its own input.");
  await boxes.nth(2).uncheck();
  await expect(dialog.getByRole("status")).toHaveText("Choose at least two panes.");
  await expect(dialog.getByRole("button", { name: "Type into 1 panes" })).toBeDisabled();
  await boxes.nth(2).check();
  await expect(dialog.getByRole("button", { name: "Type into 2 panes" })).toBeEnabled();
});

test("broadcast: a pane left out neither receives input nor relays its own", async ({ page }) => {
  await threePanes(page);
  const dialog = await review(page);
  // Leave out the middle pane (the second session).
  await dialog.getByRole("checkbox").nth(1).uncheck();
  await dialog.getByRole("button", { name: "Type into 2 panes" }).click();
  await expect(page.getByTestId("broadcast")).toHaveText("Typing into 2 panes");
  await expect(page.locator('.pane[data-broadcast="true"]')).toHaveCount(2);
  await expect(page.locator('.pane[data-broadcast="excluded"]')).toHaveCount(1);
  await expect(page.locator('.pane[data-broadcast="excluded"] .pane-header')).toContainText("Left out of broadcast");

  // Typed in a confirmed pane: reaches both confirmed panes, not the one left out.
  await focusPane(page, 0);
  let before = await inputs(page);
  await page.keyboard.type("uptime");
  await expect.poll(() => sentSince(page, before)).toEqual(["uptime", "", "uptime"]);

  // Typed in the pane left out: stays there.
  await focusPane(page, 1);
  before = await inputs(page);
  await page.keyboard.type("whoami");
  await expect.poll(() => sentSince(page, before)).toEqual(["", "whoami", ""]);
  await page.waitForTimeout(100);
  expect(await sentSince(page, before)).toEqual(["", "whoami", ""]);
});

test("broadcast: a pane added to the tab later is not a receiver; a confirmed pane dropping stops it", async ({ page }) => {
  await openLocal(page);
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(2);
  const dialog = await review(page);
  await dialog.getByRole("button", { name: "Type into 2 panes" }).click();
  await expect(page.getByTestId("broadcast")).toHaveText("Typing into 2 panes");

  // A third pane opened while broadcasting was never reviewed: it gets nothing.
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(3);
  await expect(page.locator('.pane[data-broadcast="excluded"]')).toHaveCount(1);
  await focusPane(page, 0);
  const before = await inputs(page);
  await page.keyboard.type("date");
  await expect.poll(() => sentSince(page, before)).toEqual(["date", "date", ""]);

  // The unreviewed pane dropping does not matter; a confirmed one dropping ends broadcast.
  await page.evaluate(() => (window as unknown as { __mockDropAt: (i: number) => void }).__mockDropAt(2));
  await expect(page.locator('.pane .status-dot[data-tone="bad"]')).toHaveCount(1);
  await expect(page.getByTestId("broadcast")).toHaveText("Typing into 2 panes");
  await page.evaluate(() => (window as unknown as { __mockDropAt: (i: number) => void }).__mockDropAt(1));
  await expect(page.getByTestId("broadcast")).toHaveCount(0);
  await expect(page.locator(".pane[data-broadcast]")).toHaveCount(0);
});

// Command-finished notifications (P-23). The finish comes only from shell-integration marks
// (OSC 133), played here as an integrated shell prints them. Mock backend: the native text is
// mirrored by the mock and every request is recorded. Never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const START = new Date("2026-10-11T12:00:00Z").getTime();
const OSC = (s: string) => `\u001b]133;${s}\u0007`;
const outputAt = (page: Page, index: number, text: string) =>
  page.evaluate(([i, t]) => (window as unknown as { __mockOutputAt: (i: number, t: string) => void }).__mockOutputAt(i as number, t as string), [index, text] as const);
const notices = (page: Page) => page.evaluate(() => (window as unknown as { __mockNotices?: { tabTitle: string; exitStatus: number | null; durationMs: number }[] }).__mockNotices ?? []);

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

/** A command in session `index` that runs for `seconds` (the page clock moves) and exits with `exit`. */
async function command(page: Page, index: number, text: string, seconds: number, exit: number) {
  await outputAt(page, index, `\r\n${OSC("A")}$ ${OSC("B")}${text}\r\n${OSC("C")}`);
  await page.waitForTimeout(80);
  await page.clock.setFixedTime(START + seconds * 1000);
  await outputAt(page, index, `done\r\n${OSC(`D;${exit}`)}`);
  await page.waitForTimeout(80);
}

/** The SSH tab in the background, a local terminal in front. */
async function twoTabs(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(2);
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

test("a long command finishing in a background tab notifies with tab, status and duration only, and marks the tab", async ({ page }) => {
  await twoTabs(page);
  await command(page, 0, "pg_dump --password=hunter2 prod > dump.sql", 75, 0);
  await expect.poll(() => notices(page)).toHaveLength(1);
  const [asked] = await notices(page);
  expect(asked).toEqual({ tabTitle: expect.stringContaining("api-gateway"), exitStatus: 0, durationMs: 75_000 });
  // Nothing from the command line or its output is sent for the notification.
  expect(JSON.stringify(asked)).not.toMatch(/pg_dump|hunter2|dump\.sql|done/);
  await expect(page.getByTestId("command-finished")).toHaveText(/api-gateway: Command finished successfully after 1 min 15 s\./);
  const tab = page.getByRole("tab", { name: /api-gateway/ });
  await expect(tab.locator(".tab-finished")).toContainText("command finished");
  // Showing the tab clears the mark.
  await tab.click();
  await expect(tab.locator(".tab-finished")).toHaveCount(0);
});

test("a failed command is marked as failed", async ({ page }) => {
  await twoTabs(page);
  await command(page, 0, "make test", 30, 2);
  await expect.poll(() => notices(page)).toHaveLength(1);
  await expect(page.getByTestId("command-finished")).toHaveText(/Command failed with exit status 2 after 30 s\./);
  await expect(page.getByRole("tab", { name: /api-gateway/ }).locator(".tab-finished[data-failed]")).toContainText("command failed with exit status 2");
});

test("no notification for a short command, for the tab in view, without marks, or when turned off", async ({ page }) => {
  await twoTabs(page);
  // Shorter than the 10 s default.
  await command(page, 0, "ls", 5, 0);
  // The tab in front (the local terminal, session 1).
  await command(page, 1, "sleep 60", 120, 0);
  // Output that merely looks finished, without marks.
  await outputAt(page, 0, "\r\nBuild finished (exit 0) after 300s\r\n");
  await page.waitForTimeout(150);
  expect(await notices(page)).toEqual([]);

  // Turned off in Settings.
  await openSettings(page, "Terminal");
  await page.getByLabel("Notify when a long command finishes").uncheck();
  await page.getByRole("tab", { name: /Local/ }).click();
  await command(page, 0, "sleep 600", 700, 0);
  await page.waitForTimeout(150);
  expect(await notices(page)).toEqual([]);
});

test("the minimum duration is a setting", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSettings(page, "Terminal");
  await page.getByLabel(/For commands that run at least/).fill("3");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockState: { prefs: { commandNotifications: { minSeconds: number } } } }).__mockState.prefs.commandNotifications.minSeconds)).toBe(3);
  await connect(page);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(2);
  await command(page, 0, "sleep 4", 4, 0);
  await expect.poll(() => notices(page)).toHaveLength(1);
});

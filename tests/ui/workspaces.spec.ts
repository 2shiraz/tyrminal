// Workspaces: tab status indicators, duplicate and reorder, against the test-only mock backend.
// UI evidence only; it never moves a feature to VERIFIED.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const drop = (page: Page) => page.evaluate(() => (window as unknown as { __mockDrop: () => void }).__mockDrop());

async function connectFromPalette(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  const input = page.getByRole("combobox", { name: /Type a command/ });
  await expect(input).toBeFocused();
  await input.fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const terminalTabs = (page: Page) => page.getByRole("tablist", { name: "Open sessions" }).locator(".tab:not(.tab-page)");

test("status: output in a background tab is marked unread until the tab is shown", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  await expect(terminalTabs(page)).toHaveCount(2);
  const local = page.getByRole("tab", { name: /Local terminal/ });
  await expect(local).toHaveAttribute("data-status", "ok");
  // Output in the tab in front is seen: no marker.
  await output(page, "visible line\r\n");
  await expect(local).not.toHaveAttribute("data-unread", /.*/);

  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await output(page, "background line\r\n");
  await expect(local).toHaveAttribute("data-unread", "true");
  await expect(local).toHaveAccessibleName(/new output/);
  // The sidebar's session list says the same.
  await expect(page.getByRole("list", { name: "Open sessions" }).getByRole("button", { name: /Local terminal.*new output/ })).toBeVisible();

  await local.click();
  await expect(local).not.toHaveAttribute("data-unread", /.*/);
  await expect(local).not.toHaveAccessibleName(/new output/);
});

test("status: a waiting prompt and a dropped connection show on the tab", async ({ page }) => {
  await openApp(page, { trustPromptFor: "db-primary" });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog", { name: /Verify this server/ })).toBeVisible();
  const db = page.getByRole("tab", { name: /db-primary/ });
  await expect(db).toHaveAttribute("data-status", "attention");
  await expect(db).toHaveAccessibleName(/needs your input/);
  await page.getByRole("button", { name: "Do not connect" }).click();

  await connectFromPalette(page, "api-gateway");
  const api = page.getByRole("tab", { name: /api-gateway/ });
  await expect(api).toHaveAttribute("data-status", "ok");
  await drop(page);
  await expect(api).toHaveAttribute("data-status", "bad");
  await expect(api).toHaveAccessibleName(/disconnected/);
});

test("status: a split tab shows its most urgent pane, not only the focused one", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  const tab = page.getByRole("tab", { name: /api-gateway/ });
  await expect(tab).toHaveAttribute("data-status", "ok");
  // The newest session is the second pane, which has focus. Move focus to the first, drop the second.
  await page.keyboard.press("Alt+ArrowLeft");
  await drop(page);
  await expect(tab).toHaveAttribute("data-status", "bad");
});

test("duplicate: copies the arrangement after the source with new sessions, within 16 panes", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".workspace:not([hidden]) .pane")).toHaveCount(2);
  await page.keyboard.press("Control+Shift+R");
  await page.getByRole("textbox", { name: "Rename tab" }).fill("gateway pair");
  await page.keyboard.press("Enter");
  // The original tab's two sessions are open before the copy is made.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);

  await page.getByRole("tab", { name: /gateway pair/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate tab" }).click();
  // Inserted right after the source (before the local terminal), in front, same layout and name.
  await expect(terminalTabs(page)).toHaveCount(3);
  await expect(terminalTabs(page).nth(1)).toHaveText(/gateway pair/);
  await expect(terminalTabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(terminalTabs(page).nth(2)).toHaveText(/Local terminal/);
  await expect(page.locator(".workspace:not([hidden]) .pane")).toHaveCount(2);
  // Each copied pane opens a session of its own; nothing typed in the original is replayed.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(4);

  // 5 panes open; grow the copy to 8 (11 open), then a second copy would need 19: refused.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(11);
  await terminalTabs(page).nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate tab" }).click();
  await expect(page.getByText(/Not enough room: a copy needs 8 more panes/)).toBeVisible();
  await expect(terminalTabs(page)).toHaveCount(3);
  await expect(page.locator(".pane")).toHaveCount(11);
});

test("reorder: tabs move by drag and drop", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  await expect(terminalTabs(page)).toHaveCount(2);
  await page.getByRole("tab", { name: /Local terminal/ }).dragTo(page.getByRole("tab", { name: /api-gateway/ }), { targetPosition: { x: 4, y: 8 } });
  await expect(terminalTabs(page).nth(0)).toHaveText(/Local terminal/);
  await expect(terminalTabs(page).nth(1)).toHaveText(/api-gateway/);
});

// Palette completeness (UX-03) and the connection details view (CON-15). Mock backend; never
// native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";
import { paletteRun, privateClipboard } from "./input-helpers";

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

/** Whether the palette offers an entry with exactly this label when the user types it. */
async function offers(page: Page, label: string): Promise<boolean> {
  const input = page.getByRole("combobox", { name: /Type a command/ });
  await input.fill(label);
  const names = await page.getByRole("option").evaluateAll((els) => els.map((e) => (e.querySelector(".truncate")?.textContent ?? "").trim()));
  return names.includes(label);
}

test("palette: every application action is reachable where it can act", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  // On a page (no terminal) tab and pane actions are not offered.
  await page.keyboard.press("Control+Shift+K");
  for (const absent of ["Next tab", "Copy selection", "Focus pane on the left", "Show connection log"]) expect(await offers(page, absent), absent).toBe(false);
  await page.keyboard.press("Escape");

  await connect(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(2);
  await page.keyboard.press("Control+Shift+Tab");
  await page.keyboard.press("Control+Shift+K");
  for (const expected of [
    // Shortcut actions
    "Local terminal",
    "Split pane right",
    "Split pane down",
    "Find in terminal",
    "Zoom in terminal",
    "Zoom out terminal",
    "Reset terminal zoom",
    "Close pane",
    "Show / hide snippets panel",
    "Show / hide files (SFTP)",
    "Show / hide sidebar",
    "Lock vault",
    "Settings",
    "Next tab",
    "Previous tab",
    "Rename tab…",
    "Focus pane on the left",
    "Focus pane on the right",
    "Focus pane above",
    "Focus pane below",
    "Move pane left",
    "Move pane right",
    "Move pane up",
    "Move pane down",
    "Copy selection",
    "Paste",
    // Actions without a shortcut
    "Close tab",
    "Close other tabs",
    "Show connection log",
  ]) {
    expect(await offers(page, expected), expected).toBe(true);
  }
});

test("palette: tab and pane actions run the same code as their shortcuts", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  const focusedIndex = () => page.locator(".pane").evaluateAll((els) => els.findIndex((e) => e.getAttribute("data-focused") === "true"));
  expect(await focusedIndex()).toBe(1);
  await paletteRun(page, "Focus pane on the left");
  await expect.poll(focusedIndex).toBe(0);

  // Paste goes through the terminal's paste path (single line: sent straight away).
  await page.evaluate(() => navigator.clipboard.writeText("whoami"));
  await paletteRun(page, "Paste");
  await waitForTerminalText(page, "whoami");

  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(2);
  await paletteRun(page, "Previous tab");
  await expect(page.getByRole("tab", { name: /api-gateway/ })).toHaveAttribute("aria-selected", "true");
  await paletteRun(page, "Close other tabs");
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(1);
  await paletteRun(page, "Close tab");
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(0);
});

test("connection log (CON-15): its lines are copied as text", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await connect(page, "api-gateway");
  await paletteRun(page, "Show connection log");
  const dialog = page.getByRole("dialog", { name: "Connection log: api-gateway" });
  await expect(dialog.getByTestId("connection-log")).toContainText("key exchange mlkem768x25519-sha256");
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("signed in");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toHaveLength(4);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("connection log (CON-15): a refused request is shown, not hidden", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await page.evaluate(() => {
    (window as unknown as { __mockDiagnosticsError: boolean }).__mockDiagnosticsError = true;
  });
  await paletteRun(page, "Show connection log");
  const dialog = page.getByRole("dialog", { name: /Connection log/ });
  await expect(dialog.getByRole("alert")).toContainText("No details are kept for that session any more.");
  await expect(dialog.getByRole("button", { name: "Copy" })).toHaveCount(0);
});

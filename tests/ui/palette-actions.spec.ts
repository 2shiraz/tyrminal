// Palette completeness (UX-03) and the connection details view (CON-15). Mock backend; never
// native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";
import { paletteRun } from "./input-helpers";

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
  for (const absent of ["Next tab", "Copy selection", "Focus pane on the left", "Connection details…"]) expect(await offers(page, absent), absent).toBe(false);
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
    "Connection details…",
  ]) {
    expect(await offers(page, expected), expected).toBe(true);
  }
});

test("palette: tab and pane actions run the same code as their shortcuts", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, { renderer: "compatibility" });
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

test("connection details: from the palette and from a failed connection; lines are copied as text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await paletteRun(page, "Connection details");
  const dialog = page.getByRole("dialog", { name: "Connection details: api-gateway" });
  const list = dialog.getByRole("list", { name: "Connection steps" });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(list).toContainText("matches the saved key");
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Copied the connection details.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toHaveLength(5);
  expect(copied).toContain("Authenticated as deploy with public key");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".pane[data-focused=true] .xterm-helper-textarea")).toBeFocused();

  // After a failure the notice links to the same view. A line cannot carry control characters.
  await page.evaluate(() => {
    const w = window as unknown as { __mockDiagnostics: string[]; __mockDrop: (code: string) => void };
    w.__mockDiagnostics = ["Connecting to 203.0.113.10 port 22", "Connection lost\u001b[2J during key exchange"];
    w.__mockDrop("DISCONNECTED");
  });
  const notice = page.getByRole("alert").filter({ hasText: "server closed the connection" });
  await notice.getByRole("button", { name: "Show connection details" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").nth(1)).toHaveText("Connection lost�[2J during key exchange");
});

test("connection details: a refused request is shown, not hidden", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await page.evaluate(() => {
    (window as unknown as { __mockDiagnosticsError: boolean }).__mockDiagnosticsError = true;
  });
  await paletteRun(page, "Connection details");
  const dialog = page.getByRole("dialog", { name: /Connection details/ });
  await expect(dialog.getByRole("alert")).toHaveText("No details are kept for that session any more.");
  await expect(dialog.getByRole("button", { name: "Copy" })).toBeDisabled();
});

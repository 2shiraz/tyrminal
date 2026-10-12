// Mouse mappings (TRM-08): right click and middle click can paste, through the paste review,
// and never take a click an application asked to receive (unless Shift is held). Mock backend.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";
import { inputs, privateClipboard, sentSince } from "./input-helpers";

async function settings(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
}

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const screen = (page: Page) => page.locator(".pane:not([hidden]) .xterm-screen");
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (t: string) => void }).__mockOutput(t), text);


test("right click: select word, paste or nothing; the choice is saved", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await settings(page);
  const right = page.getByRole("radiogroup", { name: "Right click" });
  await right.locator("label").filter({ hasText: /^Paste$/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockState: { prefs: { workspace?: { rightClickPaste: boolean; rightClickSelectsWord: boolean } } } }).__mockState.prefs.workspace)).toMatchObject({
    rightClickPaste: true,
    rightClickSelectsWord: false,
  });

  await connect(page);
  await expect(page.locator(".pane:not([hidden]) .terminal-host")).toHaveAttribute("data-mouse", /right-paste/);
  await page.evaluate(() => navigator.clipboard.writeText("uptime"));
  const before = await inputs(page);
  await screen(page).click({ button: "right" });
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("uptime");

  // Several lines are reviewed first, as for any paste.
  await page.evaluate(() => navigator.clipboard.writeText("echo a\necho b\n"));
  await screen(page).click({ button: "right" });
  const dialog = page.getByRole("dialog", { name: "Paste several lines?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await sentSince(page, before)).join("")).toBe("uptime");

  // Nothing: a right click sends nothing.
  await settings(page);
  await right.locator("label").filter({ hasText: /^Nothing$/ }).click();
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await expect(page.locator(".pane:not([hidden]) .terminal-host")).toHaveAttribute("data-mouse", "default");
  await page.evaluate(() => navigator.clipboard.writeText("whoami"));
  await screen(page).click({ button: "right" });
  await page.waitForTimeout(200);
  expect((await sentSince(page, before)).join("")).toBe("uptime");
});

test("middle click pastes only when turned on", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await connect(page);
  await page.evaluate(() => navigator.clipboard.writeText("hostname"));
  const before = await inputs(page);
  await screen(page).click({ button: "middle" });
  // What X11 does after a middle click: a paste event carrying the primary selection.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "Local terminal");
    document.querySelector(".pane:not([hidden]) .xterm-helper-textarea")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  // Off: nothing is sent, neither the clipboard nor the platform's primary selection.
  expect((await sentSince(page, before)).join("")).toBe("");
  const offset = await inputs(page);

  await settings(page);
  await page.getByLabel("Middle click pastes").check();
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await expect(page.locator(".pane:not([hidden]) .terminal-host")).toHaveAttribute("data-mouse", /middle-paste/);
  await screen(page).click({ button: "middle" });
  await expect.poll(async () => (await sentSince(page, offset)).join("")).toBe("hostname");
});

test("an application that asked for mouse reports gets the click; Shift pastes anyway", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await settings(page);
  await page.getByRole("radiogroup", { name: "Right click" }).locator("label").filter({ hasText: /^Paste$/ }).click();
  await connect(page);
  await page.evaluate(() => navigator.clipboard.writeText("secret-ish clipboard"));
  // The application turns on mouse reporting (X10/normal tracking, SGR encoding).
  await output(page, "\u001b[?1000h\u001b[?1006h");
  const before = await inputs(page);
  await screen(page).click({ button: "right" });
  // A mouse report goes to the application; the clipboard does not.
  await expect.poll(async () => (await sentSince(page, before)).join("")).toMatch(/^\u001b\[<2;\d+;\d+M/);
  expect((await sentSince(page, before)).join("")).not.toContain("clipboard");

  await page.keyboard.down("Shift");
  await screen(page).click({ button: "right" });
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await sentSince(page, before)).join("")).toContain("secret-ish clipboard");
});

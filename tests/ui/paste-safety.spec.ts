// Paste safety (P-25, extends P-14): the review names the target, opens for a single line that
// would run, shows hidden characters visibly, and a bracketed-paste end marker is never sent.
// Mock backend: what the session received is recorded per session. Never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (t: string) => void }).__mockOutput(t), text);

/** A paste exactly as the platform delivers it to the terminal's input element. */
const paste = (page: Page, text: string) =>
  page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    document.querySelector(".terminal-pane:not([hidden]) .xterm-helper-textarea, .pane:not([hidden]) .xterm-helper-textarea")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);

/** Everything the session received since `mark()`, without terminal query replies. */
async function received(page: Page): Promise<string> {
  const all = await page.evaluate(() => Object.values((window as unknown as { __mockInputBySession?: Record<string, string> }).__mockInputBySession ?? {}).join(""));
  return all.replace(/\u001b\[\d+;\d+R/g, "");
}

const review = (page: Page) => page.getByRole("dialog", { name: /^Paste / });

test("a plain single line without a newline goes straight through", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await paste(page, "uptime");
  await expect.poll(() => received(page)).toContain("uptime");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("a single line ending in a newline is reviewed first, naming the session it goes to", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  const before = await received(page);
  await paste(page, "sudo reboot\n");
  const dialog = review(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("api-gateway");
  await expect(dialog).toContainText("deploy@10.20.0.11");
  await expect(dialog).toContainText(/runs as soon as it is pasted/);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.waitForTimeout(100);
  expect(await received(page)).toBe(before);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(100);
  expect(await received(page)).toBe(before);
});

test("control characters, ESC, bidi overrides and zero-width characters are shown and warned about", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  const before = await received(page);
  // Looks like `ls notes.txt` but carries a color escape, a bidi override, a zero-width space and a NUL.
  await paste(page, "ls \u001b[8mrm -rf ~\u001b[0m notes‮txt.exe​\u0000");
  const dialog = review(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(/hidden characters?/);
  const shown = dialog.locator(".paste-preview");
  await expect(shown).toContainText("rm -rf ~");
  for (const label of ["ESC", "U+202E", "U+200B", "NUL"]) await expect(shown.locator(".paste-hidden", { hasText: label }).first()).toBeVisible();
  expect(await dialog.locator(".paste-hidden").count()).toBe(5);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(100);
  expect(await received(page)).toBe(before);
});

test("the control-character review cannot be turned off; turning off the multi-line review only skips plain pastes", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Confirm multi-line pastes").uncheck();
  await connect(page);
  await paste(page, "echo one\necho two\n");
  await expect.poll(() => received(page)).toContain("echo two");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await paste(page, "echo \u001b[2Jcleared");
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole("alert")).toContainText(/hidden characters?/);
});

test("a bracketed-paste end marker inside the text is never sent: refused until removed in the review", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  // The shell turns on bracketed paste.
  await output(page, "\u001b[?2004h");
  const before = await received(page);
  await paste(page, "echo safe\u001b[201~rm -rf ~\n");
  const dialog = review(page);
  await expect(dialog.getByRole("alert")).toContainText("end marker");
  const send = dialog.getByRole("button", { name: "Paste", exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByRole("button", { name: "Remove the end marker" }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(async () => (await received(page)).slice(before.length)).toContain("rm -rf ~");
  const sent = (await received(page)).slice(before.length);
  // Exactly one end marker: the terminal's own, closing the paste.
  expect(sent.split("\u001b[201~").length - 1).toBe(1);
  expect(sent.endsWith("\u001b[201~")).toBe(true);
  expect(sent.startsWith("\u001b[200~")).toBe(true);
});

test("an end marker is refused even without bracketed paste mode, and a paste from the keyboard path too", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  const before = await received(page);
  await paste(page, "a\u001b[201~b");
  const dialog = review(page);
  await expect(dialog.getByRole("button", { name: "Paste", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(100);
  expect(await received(page)).toBe(before);
});

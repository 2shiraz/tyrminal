// Command boundaries from shell integration (OSC 133). Mock backend: the marks are played as a
// shell with integration would print them. Never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";
import { paletteRun } from "./input-helpers";

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (t: string) => void }).__mockOutput(t), text);
const OSC = (s: string) => `\u001b]133;${s}\u0007`;

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

/** One command as an integrated shell prints it: prompt, command line, output, exit status. */
function command(n: number, exit: number, lines = 3): string {
  const out = Array.from({ length: lines }, (_, i) => `output ${n}.${i + 1}`).join("\r\n");
  return `${OSC("A")}$ ${OSC("B")}cmd-${n}\r\n${OSC("C")}${out}\r\n${OSC(`D;${exit}`)}`;
}

/** The first visible row's text. */
const topRow = (page: Page) => page.locator(".pane:not([hidden]) .xterm-rows > div").first().innerText();

test("separators above each later prompt, a gutter mark for a failed command, and the marks are never printed", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await output(page, `\r\n${command(1, 0)}${command(2, 2)}${command(3, 0)}${OSC("A")}$ ${OSC("B")}`);
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText("cmd-3");
  // Four prompts: separators above the three after the first.
  await expect(page.locator(".pane:not([hidden]) .cmd-separator")).toHaveCount(3);
  // Only cmd-2 failed.
  const failed = page.locator(".pane:not([hidden]) .cmd-failed");
  await expect(failed).toHaveCount(1);
  await expect(failed).toHaveAttribute("title", "Exit status 2");
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).not.toContainText("133;");
});

test("jump to the previous and next command with the keyboard and the palette", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  let text = "\r\n";
  // Each command prints more than a screen, so every prompt can be scrolled to the top.
  for (let n = 1; n <= 8; n += 1) text += command(n, 0, 60);
  text += `${OSC("A")}$ ${OSC("B")}`;
  await output(page, text);
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText("output 8.60");

  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect.poll(() => topRow(page)).toMatch(/^\$ cmd-8/);
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect.poll(() => topRow(page)).toMatch(/^\$ cmd-7/);
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect.poll(() => topRow(page)).toMatch(/^\$ cmd-8/);
  await paletteRun(page, "Jump to the previous command");
  await expect.poll(() => topRow(page)).toMatch(/^\$ cmd-7/);
});

test("without shell integration nothing changes, and the jump keys reach no shell", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await output(page, "\r\nplain prompt $ ls\r\nfile\r\n");
  await expect(page.locator(".pane:not([hidden]) .cmd-separator")).toHaveCount(0);
  const before = await page.evaluate(() => (window as unknown as { __mockReceived?: string }).__mockReceived ?? "");
  await page.keyboard.press("Control+Shift+ArrowUp");
  await page.waitForTimeout(100);
  // The chord is an application shortcut: nothing was sent to the session.
  expect(await page.evaluate(() => (window as unknown as { __mockReceived?: string }).__mockReceived ?? "")).toBe(before);
});

test("marks printed by a full-screen application are ignored", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await output(page, `\r\n${command(1, 0)}\u001b[?1049h${command(2, 1)}${command(3, 1)}\u001b[?1049l${OSC("A")}$ `);
  await expect(page.locator(".pane:not([hidden]) .cmd-separator")).toHaveCount(1);
  await expect(page.locator(".pane:not([hidden]) .cmd-failed")).toHaveCount(0);
});

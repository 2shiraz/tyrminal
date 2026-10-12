// The shell's current folder (from the opt-in shell integration's OSC 7 marks) used by the files
// panel and by tab duplication, against the UI test mock. The local terminal's starting folder is
// tested against real shells in crates/core/tests/sessions_lab.rs. The mock never makes a row VERIFIED.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const ESC = "\u001b";
const ST = `${ESC}\\`;
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const received = (page: Page) => page.evaluate(() => (window as unknown as { __mockReceived?: string }).__mockReceived ?? "");
const callsOf = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const commandLine = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __mockState: { sessions: Map<string, { line: string }> } }).__mockState.sessions.values()].at(-1)?.line ?? null);

const folderMark = (host: string, encodedPath: string) => `${ESC}]7;file://${host}${encodedPath}${ST}`;
const promptMark = `${ESC}]133;A${ST}`;

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Connect to api-gateway" }).click();
  await waitForTerminalText(page, "deploy@api-gateway");
}

async function duplicateTab(page: Page, name: RegExp) {
  const before = await page.getByRole("tab").count();
  await page.getByRole("tab", { name }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate tab" }).click();
  await expect(page.getByRole("tab")).toHaveCount(before + 1);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Files" });
const folderField = (page: Page) => panel(page).getByRole("textbox", { name: "Folder on the server" });

test("the files panel opens in the shell's folder and can go back to it", async ({ page }) => {
  await connected(page);
  await output(page, `${folderMark("api-gateway", "/home/deploy/app")}marked\r\n`);
  await waitForTerminalText(page, "marked");

  await page.keyboard.press("Control+Shift+O");
  await expect(folderField(page)).toHaveValue("/home/deploy/app");
  const toShell = panel(page).getByRole("button", { name: "Go to the shell's folder (/home/deploy/app)" });
  await expect(toShell).toBeDisabled();
  await panel(page).getByRole("button", { name: "Up one folder" }).click();
  await expect(folderField(page)).toHaveValue("/home/deploy");
  await toShell.click();
  await expect(folderField(page)).toHaveValue("/home/deploy/app");
  await expect(panel(page).getByRole("grid", { name: /^Contents of \// }).getByRole("button")).toHaveText([/config\.yml/]);
});

test("a shell folder the server cannot list falls back to the login folder", async ({ page }) => {
  await connected(page);
  await output(page, `${folderMark("api-gateway", "/srv/gone")}marked\r\n`);
  await waitForTerminalText(page, "marked");
  await page.keyboard.press("Control+Shift+O");
  await expect(folderField(page)).toHaveValue("/home/deploy");
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

test("a duplicated SSH tab changes to the folder at its first integrated prompt", async ({ page }) => {
  await connected(page);
  // A folder name with a quote and a space: it must reach the shell as one literal argument.
  await output(page, `${folderMark("api-gateway", "/srv/it%27s%20here")}marked\r\n`);
  await waitForTerminalText(page, "marked");
  await duplicateTab(page, /api-gateway/);
  await waitForTerminalText(page, "deploy@api-gateway");
  // Nothing is typed until the new shell shows the integration's prompt mark.
  await output(page, "plain prompt$ ");
  expect(await received(page)).not.toContain("cd --");
  await output(page, promptMark);
  await expect.poll(() => received(page)).toContain("cd -- '/srv/it'\\''s here'\r");
  // Only once: a later prompt types nothing more.
  await output(page, promptMark);
  await expect.poll(async () => (await received(page)).split("cd --").length - 1).toBe(1);
});

test("typing in the duplicated tab first cancels the folder change", async ({ page }) => {
  await connected(page);
  await output(page, `${folderMark("api-gateway", "/home/deploy/app")}marked\r\n`);
  await waitForTerminalText(page, "marked");
  await duplicateTab(page, /api-gateway/);
  await waitForTerminalText(page, "deploy@api-gateway");
  await page.keyboard.type("uptime");
  await expect.poll(() => commandLine(page)).toBe("uptime");
  await output(page, promptMark);
  await output(page, "after-prompt\r\n");
  await waitForTerminalText(page, "after-prompt");
  expect(await received(page)).not.toContain("cd --");
});

test("a duplicated local terminal asks to start in the shell's folder", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Local terminal");
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "tyr@laptop");
  await output(page, `${folderMark("laptop", "/tmp/work%20dir")}marked\r\n`);
  await waitForTerminalText(page, "marked");
  await duplicateTab(page, /Local terminal/);
  await expect.poll(async () => (await callsOf(page, "session_open_local")).map((c) => c.args.startIn)).toEqual([null, "/tmp/work dir"]);
});

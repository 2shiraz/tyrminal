// Command history suggestions (AUT-01) against the UI test mock (UI evidence only; the vault side
// is tested in crates/core/tests/command_history.rs). Commands come only from shell-integration
// marks, nothing leaves the page while history is off, a suggestion is inserted and never run,
// and remembered commands can be deleted one by one or cleared.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const ESC = "\u001b";
const ST = `${ESC}\\`;

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const added = async (page: Page) => ((await calls(page, "history_add")) as { args: { command: string } }[]).map((c) => c.args.command);
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const commandLine = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __mockState: { sessions: Map<string, { line: string }> } }).__mockState.sessions.values()].at(-1)?.line ?? null);

/** A prompt and a command as an integrated Bash prints them. */
const ran = (command: string) =>
  `\r\n${ESC}]133;A${ST}deploy@api-gateway:~$ ${ESC}]133;B${ST}${command}\r\n${ESC}]133;C${ST}output of ${command}\r\n${ESC}]133;D;0${ST}`;

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Connect to api-gateway" }).click();
  await waitForTerminalText(page, "deploy@api-gateway");
}

const openSuggestions = async (page: Page) => {
  await page.keyboard.press("Control+Shift+E");
  const dialog = page.getByRole("dialog", { name: "Suggestions" });
  await expect(dialog).toBeVisible();
  return dialog;
};

test("history is off by default: commands never leave the page and nothing is suggested", async ({ page }) => {
  await connected(page);
  await output(page, ran("git status"));
  await waitForTerminalText(page, "output of git status");
  // Give the capture a chance to run (it is asynchronous), then check nothing was sent.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect(await calls(page, "history_add")).toHaveLength(0);
  const dialog = await openSuggestions(page);
  await dialog.getByLabel("Type to find a command, snippet or path").fill("git");
  await expect(dialog.getByRole("group", { name: "History" })).toHaveCount(0);
  expect(await calls(page, "history_suggest")).toHaveLength(0);
});

test("history: commands from shell marks are suggested, inserted without running, and a password typed during a command is never kept", async ({ page }) => {
  await connected(page);
  let dialog = await openSuggestions(page);
  await dialog.getByRole("button", { name: "History…" }).click();
  const manager = page.getByRole("dialog", { name: "Command history" });
  await manager.getByRole("switch", { name: /Remember commands for suggestions/ }).check();
  await manager.getByRole("button", { name: "Back to suggestions" }).click();
  await page.keyboard.press("Escape");

  await output(page, ran("git status --short"));
  await output(page, ran(" export TOKEN=leading-space"));
  // A command that asks for a password while it runs: the answer is typed after the
  // command-start mark, so it is not between any prompt marks.
  await output(page, `\r\n${ESC}]133;A${ST}deploy@api-gateway:~$ ${ESC}]133;B${ST}sudo apt update\r\n${ESC}]133;C${ST}[sudo] password for deploy: `);
  await page.locator(".terminal-pane:not([hidden]) .xterm").click();
  await page.keyboard.type("hunter2-canary");
  await page.keyboard.press("Enter");
  await output(page, `\r\nupdated\r\n${ESC}]133;D;0${ST}`);
  // A line typed with a leading space is never sent; nor is the password.
  await expect.poll(() => added(page)).toEqual(["git status --short", "sudo apt update"]);
  const sent = (await added(page)).join("\n");
  expect(sent).not.toContain("hunter2");
  expect(sent).not.toContain("TOKEN");

  dialog = await openSuggestions(page);
  await dialog.getByLabel("Type to find a command, snippet or path").fill("git st");
  const group = dialog.getByRole("group", { name: "History" });
  await expect(group.getByRole("option")).toHaveText(["git status --short"]);
  await expect(group.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  const before = await commandLine(page);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => commandLine(page)).toBe(`${before}git status --short`);
  // Inserted, not run: no Enter reached the shell.
  await expect(page.locator(".terminal-pane:not([hidden]) .xterm-rows")).not.toContainText("git status --short: synthetic output");

  // The empty query lists recent commands.
  dialog = await openSuggestions(page);
  await expect(dialog.getByRole("group", { name: "History" }).getByRole("option")).toHaveText(["sudo apt update", "git status --short"]);
});

test("history: remembered commands can be deleted one by one and cleared after a confirmation", async ({ page }) => {
  await connected(page);
  let dialog = await openSuggestions(page);
  await dialog.getByRole("button", { name: "History…" }).click();
  let manager = page.getByRole("dialog", { name: "Command history" });
  await manager.getByRole("switch", { name: /Remember commands/ }).check();
  await expect(manager.getByText("No commands remembered yet.")).toBeVisible();
  await page.keyboard.press("Escape");
  for (const c of ["uptime", "df -h", "journalctl -u nginx"]) await output(page, ran(c));
  await expect.poll(() => added(page)).toHaveLength(3);

  dialog = await openSuggestions(page);
  await dialog.getByRole("button", { name: "History…" }).click();
  manager = page.getByRole("dialog", { name: "Command history" });
  const list = manager.getByRole("list", { name: "Command history" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").first()).toContainText("api-gateway");
  await manager.getByLabel("Filter commands").fill("df");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await manager.getByRole("button", { name: "Forget df -h" }).click();
  await expect(manager.getByText("No remembered command matches.")).toBeVisible();
  await manager.getByLabel("Filter commands").fill("");
  await expect(list.getByRole("listitem")).toHaveCount(2);

  // Turning history off keeps the list.
  await manager.getByRole("switch", { name: /Remember commands/ }).uncheck();
  await expect(manager.getByText("History is off.")).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(2);

  await manager.getByRole("button", { name: "Clear history…" }).click();
  const confirm = manager.getByRole("alertdialog", { name: "Clear command history?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("2 commands deleted")).toBeVisible();
  await expect(manager.getByText("No commands remembered yet.")).toBeVisible();
});

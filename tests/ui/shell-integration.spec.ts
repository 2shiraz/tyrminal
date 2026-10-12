// Shell integration (AUT-06/07) against the UI test mock: OSC 133/OSC 7 marks from the terminal
// set the shell context that suggestions use; malformed marks are ignored; the setup dialog shows
// the exact block and writes nothing until Install is pressed. The mock never makes a row VERIFIED.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp, waitForTerminalText } from "./fixtures";

const ESC = "\u001b";
const ST = `${ESC}\\`;
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const callsOf = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const commandLine = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __mockState: { sessions: Map<string, { line: string }> } }).__mockState.sessions.values()].at(-1)?.line ?? null);

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await connectHost(page, "api-gateway");
  await waitForTerminalText(page, "deploy@api-gateway");
}

const openSuggestions = async (page: Page) => {
  await page.keyboard.press("Control+Shift+E");
  const dialog = page.getByRole("dialog", { name: "Suggestions" });
  await expect(dialog).toBeVisible();
  return dialog;
};

/** One prompt and command as an integrated Bash prints them. */
const promptAndCommand = (folder: string, command: string, status: number) =>
  `\r\n${ESC}]133;A${ST}deploy@api-gateway:${folder}$ ${ESC}]133;B${ST}${command}\r\n${ESC}]133;C${ST}some output\r\n${ESC}]133;D;${status}${ST}${ESC}]7;file://api-gateway${folder}${ST}`;

test("marks from the shell set the folder that relative path suggestions start from", async ({ page }) => {
  await connected(page);
  await output(page, promptAndCommand("/home/deploy/app", "ls -la", 2));
  await waitForTerminalText(page, "some output");

  const dialog = await openSuggestions(page);
  const context = dialog.getByTestId("shell-context");
  await expect(context).toContainText("Folder: /home/deploy/app");
  await expect(context).toContainText("Last command: ls -la (exit status 2)");
  await dialog.getByLabel("Type to find a command, snippet or path").fill("./con");
  const paths = dialog.getByRole("group", { name: "Files and folders on the server" });
  await expect(paths.getByRole("option")).toHaveCount(1);
  await expect(paths.getByRole("option")).toContainText("./config.yml");
  await expect(dialog.getByText("Relative paths start from /home/deploy/app")).toBeVisible();
  await paths.getByRole("option").click();
  await expect.poll(() => commandLine(page)).toBe("./config.yml");
});

test("malformed or unsafe marks are ignored", async ({ page }) => {
  await connected(page);
  await output(page, `${ESC}]7;file://api-gateway/home/deploy${ST}`);
  // Control characters (encoded or raw), relative paths, non-file schemes and broken encoding.
  for (const bad of ["file://h/tmp/%1Bevil", "file://h/tmp/%E2%80%AEgnp", "file://hrelative", "https://h/tmp", "file://h/tmp/%zz", "file://h/tmp/%FFFFFFFFFFFFFFC3%FFFFFFFFFFFFFFBC", `file://h/${"a".repeat(5000)}`]) {
    await output(page, `${ESC}]7;${bad}${ST}`);
  }
  // A status without a started command, and an out-of-range status, are not reported.
  await output(page, `${ESC}]133;D;7${ST}${ESC}]133;C${ST}${ESC}]133;D;99999${ST}done-marks\r\n`);
  await waitForTerminalText(page, "done-marks");
  const dialog = await openSuggestions(page);
  const context = dialog.getByTestId("shell-context");
  await expect(context).toContainText("Folder: /home/deploy");
  await expect(context).not.toContainText("tmp");
  await expect(context).not.toContainText("exit status");
});

test("the setup dialog shows the exact block and installs only on request", async ({ page }) => {
  await connected(page);
  const suggestions = await openSuggestions(page);
  await suggestions.getByRole("button", { name: "Shell integration…" }).click();
  const dialog = page.getByRole("dialog", { name: "Shell integration" });
  await expect(dialog.getByTestId("integration-status")).toContainText("Startup file: ~/.bashrc · Not installed.");
  await expect(dialog.getByLabel("Exact text that will be added")).toContainText("# >>> tyrminal shell integration v1 >>>");
  await expect(dialog.getByRole("note")).toContainText("login shell is sh");
  await expect(dialog.getByText("copied to ~/.bashrc.tyrminal-backup")).toBeVisible();
  // Looking writes nothing; focus starts on Close, not Install.
  expect(await callsOf(page, "prompt_marks_install")).toHaveLength(0);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

  await dialog.getByRole("button", { name: "Install" }).click();
  await expect(dialog.getByTestId("integration-status")).toContainText("Installed (version 1).");
  await expect(dialog.getByRole("status")).toContainText("Open a new terminal (or reconnect)");
  const install = await callsOf(page, "prompt_marks_install");
  expect(install).toHaveLength(1);
  expect((install[0]?.args as { target: { kind: string } }).target.kind).toBe("session");
  await expect(dialog.getByRole("button", { name: "Install" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(dialog.getByTestId("integration-status")).toContainText("Not installed.");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a local terminal offers Bash or Zsh on this computer from the palette", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Local terminal");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("shell integration");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Shell integration" });
  await expect(dialog.getByText("On this computer")).toBeVisible();
  await dialog.getByLabel("Shell").selectOption("zsh");
  await expect(dialog.getByTestId("integration-status")).toContainText("Startup file: ~/.zshrc");
  await dialog.getByRole("button", { name: "Install" }).click();
  await expect(dialog.getByTestId("integration-status")).toContainText("Installed");
  const install = await callsOf(page, "prompt_marks_install");
  expect((install[0]?.args as { target: unknown }).target).toEqual({ kind: "local", shell: "zsh" });
});

// Search across open sessions (P-28) and one command's output (P-29) against the UI test mock.
// The mock prints shell-integration marks (OSC 133) the way the real integration does; the
// native suite checks the same against a real shell.
import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

async function palette(page: Page, label: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(label);
  const option = page.getByRole("option", { name: new RegExp(label) });
  await expect(option).toHaveCount(1);
  await option.click();
}

test("search finds text in every open session, grouped by tab, and jumps to it", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await output(page, "\r\nalpha needle-one omega\r\n");
  await connect(page, "build-runner-03");
  await output(page, "\r\nbeta NEEDLE-two\r\n");
  await waitForTerminalText(page, "NEEDLE-two");

  await palette(page, "Search all sessions");
  const dialog = page.getByRole("dialog", { name: "Search all sessions" });
  await dialog.getByLabel("Text to find in every open session").fill("needle");
  await expect(dialog.getByRole("status")).toHaveText("2 matches in 2 tabs");
  const gateway = dialog.getByRole("region", { name: /api-gateway/ });
  await expect(gateway.getByRole("button")).toHaveText(["alpha needle-one omega"]);
  // Match case narrows it to one.
  await dialog.getByLabel("Match case").check();
  await expect(dialog.getByRole("status")).toHaveText("1 match in 1 tab");
  await dialog.getByLabel("Match case").uncheck();
  await expect(dialog.getByRole("status")).toHaveText("2 matches in 2 tabs");

  // Choosing the match in the background tab brings that tab to the front and selects it.
  await gateway.getByRole("button").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /api-gateway/ })).toHaveAttribute("aria-selected", "true");
  await waitForTerminalText(page, "needle-one");
  // Nothing was sent anywhere: the search never leaves the page.
  expect(JSON.stringify(await page.evaluate(() => (window as unknown as { __mockCalls: unknown[] }).__mockCalls))).not.toContain("needle");
});

test("a command's output is copied or saved without the prompt and command line, and only with marks", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");

  // Without shell integration marks, the action is not offered.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("command's output");
  await expect(page.getByRole("option", { name: /command's output/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A prompt, a command, its output, its end (exit 3), and the next prompt, with OSC 133 marks.
  const osc = (s: string) => `\x1b]133;${s}\x07`;
  await output(page, `\r\n${osc("A")}deploy$ ${osc("B")}ls -1 /srv\r\n${osc("C")}file-a\r\nfile-b\r\n${osc("D;3")}${osc("A")}deploy$ ${osc("B")}`);
  await waitForTerminalText(page, "file-b");

  await palette(page, "command's output");
  const dialog = page.getByRole("dialog", { name: /Command output/ });
  const row = dialog.getByTestId("command-list").getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("ls -1 /srv");
  await expect(row).toContainText("Exit 3");
  await row.getByRole("button", { name: "Copy the output of ls -1 /srv" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("file-a\nfile-b");
  await row.getByRole("button", { name: "Save the output of ls -1 /srv to a file" }).click();
  await expect(page.getByText("Output saved to command-output.txt")).toBeVisible();
  expect(await calls(page, "terminal_output_save")).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __mockSavedOutput: string }).__mockSavedOutput)).toBe("file-a\nfile-b");
});

// Suggestions in the terminal (AUT-02/03/04/12, P-14) against the UI test mock: a choice is put
// on the command line and never run; multi-line snippets go through the review; remote names with
// control characters cannot be inserted; suggestions can be paused per session.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp, waitForTerminalText } from "./fixtures";

/** The command line the mock shell has received so far (what was typed, not yet run). */
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

test("a command suggestion is typed on the command line but not run", async ({ page }) => {
  await connected(page);
  const dialog = await openSuggestions(page);
  await dialog.getByLabel("Type to find a command, snippet or path").fill("syst");
  const list = dialog.getByTestId("suggestions");
  await expect(list.getByRole("group", { name: "Commands" }).getByRole("option").first()).toContainText("systemctl");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => commandLine(page)).toBe("systemctl ");
  // No Enter was sent: the mock shell would have printed "synthetic output".
  await expect(page.locator(".terminal-pane:not([hidden]) .xterm-rows")).not.toContainText("synthetic output");
});

test("remote paths complete from the login folder and are shell-quoted", async ({ page }) => {
  await connected(page);
  const dialog = await openSuggestions(page);
  await dialog.getByLabel("Type to find a command, snippet or path").fill("~/dep");
  const paths = dialog.getByRole("group", { name: "Files and folders on the server" });
  await expect(paths.getByRole("option")).toHaveCount(1);
  await expect(paths.getByRole("option")).toContainText("~/deploy.sh");
  await paths.getByRole("option").click();
  await expect.poll(() => commandLine(page)).toBe("~/deploy.sh");

  // A name with a space is quoted; one with a control character is shown but cannot be inserted.
  await page.evaluate(() => {
    const w = window as unknown as { __mockAddFile?: (p: string) => void };
    w.__mockAddFile?.("/home/deploy/my notes.txt");
    w.__mockAddFile?.("/home/deploy/my\u001bevil");
  });
  const again = await openSuggestions(page);
  await again.getByLabel("Type to find a command, snippet or path").fill("~/my");
  const options = again.getByRole("group", { name: "Files and folders on the server" }).getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.filter({ hasText: "control characters" })).toHaveAttribute("aria-disabled", "true");
  await options.filter({ hasText: "control characters" }).click({ force: true });
  await expect(again).toBeVisible();
  await options.filter({ hasText: "notes" }).click();
  await expect.poll(() => commandLine(page)).toBe("~/deploy.sh~/'my notes.txt'");
});

test("a multi-line snippet opens the review instead of being typed", async ({ page }) => {
  await connected(page);
  const dialog = await openSuggestions(page);
  await dialog.getByLabel("Type to find a command, snippet or path").fill("restart");
  const snippets = dialog.getByRole("group", { name: "Snippets" });
  await expect(snippets.getByRole("option").first()).toContainText("2 lines");
  await snippets.getByRole("option").first().click();
  await expect(page.getByRole("alertdialog", { name: "Paste “Restart service”?" })).toBeVisible();
  expect(await commandLine(page)).toBe("");
});

test("suggestions pause for a session and resume on request", async ({ page }) => {
  await connected(page);
  const dialog = await openSuggestions(page);
  await dialog.getByRole("button", { name: "Pause for this session" }).click();
  await page.keyboard.press("Control+Shift+E");
  const paused = page.getByRole("dialog", { name: "Suggestions are paused" });
  await expect(paused).toContainText("for this session");
  await paused.getByRole("button", { name: "Resume suggestions" }).click();
  await expect(page.getByLabel("Type to find a command, snippet or path")).toBeVisible();
});

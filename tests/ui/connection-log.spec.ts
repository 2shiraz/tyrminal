// The per-session connection log (redacted diagnostics kept by the core), reached from the command
// palette while connected and from the failure notice once a connection ended. Against the UI test
// mock; the redaction itself is tested in crates/core. The mock never makes a row VERIFIED.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp, waitForTerminalText } from "./fixtures";

const callsOf = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await connectHost(page, "api-gateway");
  await waitForTerminalText(page, "deploy@api-gateway");
}

const logDialog = (page: Page) => page.getByRole("dialog", { name: /^Connection log: / });

async function expectLog(page: Page) {
  const dialog = logDialog(page);
  await expect(dialog).toBeVisible();
  const log = dialog.getByTestId("connection-log");
  await expect(log).toContainText("connecting to 192.0.2.10:22 directly");
  await expect(log).toContainText("host key ssh-ed25519");
  await expect(log).toContainText("signed in");
  // Plain text: one line per entry, nothing rendered as markup.
  expect((await log.innerText()).split("\n")).toHaveLength(4);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
}

test("the connection log opens from the command palette for the focused SSH session", async ({ page }) => {
  await connected(page);
  await page.getByRole("button", { name: "Search or run a command" }).click();
  await page.getByRole("combobox", { name: /Type a command/ }).fill("connection log");
  await page.getByRole("option", { name: /Show connection log/ }).click();
  await expect(logDialog(page)).toHaveAccessibleName(/api-gateway/);
  await expectLog(page);
});

test("the connection log opens from the notice of a failed connection", async ({ page }) => {
  await connected(page);
  const sessionId = await page.evaluate(() => [...(window as unknown as { __mockState: { sessions: Map<string, unknown> } }).__mockState.sessions.keys()].at(-1));
  await page.evaluate(() => (window as unknown as { __mockDrop: (c: string) => void }).__mockDrop("AUTH_FAILED"));
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connection log", exact: true }).click();
  // The log of the session that failed, kept by the core after it ended.
  await expect.poll(async () => (await callsOf(page, "session_diagnostics")).at(-1)?.args.sessionId).toBe(sessionId);
  await expectLog(page);
});

test("a local terminal offers no connection log", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+T");
  await page.getByRole("button", { name: "Search or run a command" }).click();
  await page.getByRole("combobox", { name: /Type a command/ }).fill("connection log");
  await expect(page.getByRole("option", { name: /Show connection log/ })).toHaveCount(0);
});

// Startup snippets (SNP-08) and variable references in the snippet review (SNP-14) against the UI
// test mock. Typing after trust and the connection-log lines are tested against the real server
// in crates/core/tests/sessions_lab.rs and tests/native/environment.test.mjs.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const received = (page: Page) => page.evaluate(() => (window as unknown as { __mockReceived?: string }).__mockReceived ?? "");

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
}

test("a group's startup snippets run, in order, in its hosts' new shells", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await nav(page, "Hosts");
  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "Environment…" }).click();
  const group = page.getByRole("dialog", { name: "Environment for Production" });
  const section = group.getByTestId("startup-section");
  await expect(section.getByRole("radio", { name: /Use the group's list/ })).toBeChecked();
  await section.getByRole("radio", { name: /Run these snippets/ }).check();
  await section.getByRole("combobox", { name: "Add a snippet" }).selectOption({ label: "Disk usage" });
  await section.getByRole("combobox", { name: "Add a snippet" }).selectOption({ label: "Ops/Top memory users" });
  const list = section.getByRole("list", { name: "Startup snippets" });
  await expect(list.getByRole("listitem")).toHaveText([/Disk usage/, /Top memory users/]);
  // Reorder: Top memory users first.
  await list.getByRole("button", { name: "Move Top memory users earlier" }).click();
  await expect(list.getByRole("listitem").first()).toContainText("Top memory users");
  await group.getByRole("button", { name: "Done" }).click();
  await expect(group).toHaveCount(0);
  const saved = await calls(page, "startup_set");
  expect(saved.at(-1)!.args).toMatchObject({ target: { kind: "group" }, snippetIds: [expect.any(String), expect.any(String)] });

  // A host in the group shows where its list comes from.
  await page.getByRole("button", { name: "More actions for api-gateway" }).first().click();
  await page.getByRole("menuitem", { name: "Environment…" }).click();
  const host = page.getByRole("dialog", { name: "Environment for api-gateway" });
  await expect(host.getByTestId("startup-section")).toContainText("Currently the list from Production");
  await host.getByRole("button", { name: "Done" }).click();

  // Connecting types both, in order, once the shell is open.
  await connect(page, "api-gateway");
  await waitForTerminalText(page, "df -h: synthetic output");
  const typed = await received(page);
  expect(typed.indexOf("ps aux")).toBeGreaterThanOrEqual(0);
  expect(typed.indexOf("ps aux")).toBeLessThan(typed.indexOf("df -h"));
});

test("startup snippets wait for the host-key decision", async ({ page }) => {
  await openApp(page, { renderer: "compatibility", trustPromptFor: "staging-web" });
  await page.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke("startup_set", {
      target: { kind: "host", hostId: (106).toString(16).padStart(32, "0") },
      snippetIds: [(201).toString(16).padStart(32, "0")],
    }),
  );
  await connect(page, "staging-web");
  const trust = page.getByRole("alertdialog", { name: "Verify this server before connecting" });
  await expect(trust).toBeVisible();
  expect(await received(page)).not.toContain("df -h");
  await trust.getByRole("button", { name: "Trust once" }).click();
  await waitForTerminalText(page, "df -h: synthetic output");
});

test("snippets: variables a snippet uses are listed with how the session set them", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await nav(page, "Hosts");
  await page.getByRole("button", { name: "More actions for api-gateway" }).first().click();
  await page.getByRole("menuitem", { name: "Environment…" }).click();
  const host = page.getByRole("dialog", { name: "Environment for api-gateway" });
  for (const [i, [name, value]] of [["TYR_APP", "orders"], ["NOT_ACCEPTED", "1"]].entries()) {
    await host.getByRole("button", { name: "Add variable" }).click();
    await host.getByLabel(`Name ${i + 1}`).fill(name!);
    await host.getByLabel(`Value ${i + 1}`).fill(value!);
  }
  await host.getByRole("button", { name: "Done" }).click();
  await expect(host).toHaveCount(0);

  await nav(page, "Snippets");
  await page.getByRole("button", { name: "New snippet" }).click();
  const editor = page.getByRole("dialog", { name: "New snippet" });
  await editor.getByLabel("Name").fill("Show app");
  await editor.getByLabel("Command").fill('echo "$TYR_APP ${NOT_ACCEPTED} $HOME \\$LITERAL"');
  await editor.getByRole("button", { name: "Save" }).click();

  await connect(page, "api-gateway");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.keyboard.press("Control+Shift+S");
  const panel = page.getByRole("complementary", { name: "Snippets" });
  // One line, but it uses a variable the server refused: reviewed first, nothing sent yet.
  await panel.getByRole("button", { name: "Run Show app in the terminal" }).click();
  const review = page.getByRole("alertdialog", { name: /Run “Show app”/ });
  const refs = review.getByRole("list", { name: "Variables this snippet uses" });
  await expect(refs.locator('[data-state="set"]')).toContainText("$TYR_APP");
  await expect(refs.locator('[data-state="refused"]')).toContainText("$NOT_ACCEPTED");
  await expect(refs.locator('[data-state="unknown"]')).toContainText("$HOME");
  await expect(refs).not.toContainText("LITERAL");
  await expect(review).toContainText("1 line will be sent to:");
  expect(await calls(page, "snippet_send")).toHaveLength(0);
  await review.getByRole("button", { name: "Run 1 line" }).click();
  await expect.poll(async () => (await calls(page, "snippet_send")).length).toBe(1);

  // A one-line snippet that uses no refused variable is sent at once, as before.
  await panel.getByRole("button", { name: "Run Disk usage in the terminal" }).click();
  await expect.poll(async () => (await calls(page, "snippet_send")).length).toBe(2);
});

test("a startup snippet with a line too long for a terminal is flagged as skipped", async ({ page }) => {
  await openApp(page);
  await nav(page, "Snippets");
  await page.getByRole("button", { name: "New snippet" }).click();
  const editor = page.getByRole("dialog", { name: "New snippet" });
  await editor.getByLabel("Name").fill("Huge line");
  await editor.getByLabel("Command").fill(`echo ok\necho ${"é".repeat(500)}`);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await nav(page, "Hosts");
  await page.getByRole("button", { name: "More actions for api-gateway" }).first().click();
  await page.getByRole("menuitem", { name: "Environment…" }).click();
  const section = page.getByRole("dialog", { name: "Environment for api-gateway" }).getByTestId("startup-section");
  await section.getByRole("radio", { name: /Run these snippets/ }).check();
  await section.getByRole("combobox", { name: "Add a snippet" }).selectOption({ label: "Disk usage" });
  await expect(section.getByRole("alert")).toHaveCount(0);
  await section.getByRole("combobox", { name: "Add a snippet" }).selectOption({ label: "Huge line" });
  const items = section.getByRole("list", { name: "Startup snippets" }).getByRole("listitem");
  // 500 × "é" is 1000 bytes; with "echo " in front the second line is over the limit.
  await expect(items.nth(1).getByRole("alert")).toHaveText(/Line 2 is longer than 1000 bytes; terminals in line mode can't take it, so this snippet is not typed at startup/);
  await expect(items.nth(0).getByRole("alert")).toHaveCount(0);
});

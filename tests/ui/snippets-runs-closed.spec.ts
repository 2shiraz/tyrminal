// Snippet runs on hosts without an open session, by group, and on every open session (SNP-05/06/07)
// against the UI test mock. The connections themselves (trust prompt, changed key, sign-in that
// needs input, cancel and lock mid-run, exec channels only) are tested against the SSH lab in
// crates/core/tests/sessions_lab.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

type Call = { cmd: string; args: Record<string, unknown> };
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: Call[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

async function connect(page: Page, ...labels: string[]) {
  for (const label of labels) {
    await primary(page).getByRole("button", { name: /^Hosts/ }).click();
    await page.getByRole("button", { name: `Connect to ${label}` }).click();
  }
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(labels.length);
}

async function runOnHosts(page: Page, snippet: string) {
  await primary(page).getByRole("button", { name: /^Snippets/ }).click();
  await page.getByRole("button", { name: `More actions for ${snippet}` }).click();
  await page.getByRole("menuitem", { name: "Run on hosts…" }).click();
  return page.getByRole("dialog", { name: `Run “${snippet}” on hosts` });
}

const row = (page: Page, host: string) => page.getByTestId("run-results").locator(`[data-host="${host}"]`);

test("closed hosts run on their own connection; an unknown key is asked about, never assumed", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, { trustPromptFor: "edge-cache" });
  await connect(page, "api-gateway");
  const dialog = await runOnHosts(page, "Disk usage");
  for (const label of ["api-gateway", "edge-cache", "build-runner-03"]) await dialog.getByRole("checkbox", { name: `Select ${label}` }).check();
  await dialog.getByRole("button", { name: "Review 3 hosts" }).click();

  const review = page.getByRole("dialog", { name: "Run “Disk usage”?" });
  await expect(review.locator("pre")).toHaveText("df -h");
  await expect(review).toContainText("2 hosts have no open session");
  await expect(review.getByLabel("Hosts at once")).toHaveValue("4");
  expect(await calls(page, "session_open_exec")).toHaveLength(0);
  await review.getByRole("button", { name: "Run on 3 hosts" }).click();

  // The trust question waits for the user; the other hosts carry on meanwhile.
  const trust = page.getByRole("region", { name: "Host key of edge-cache" });
  await expect(trust).toContainText("SHA256:k3J9vT0yQ2uX5rB8nM1cP4sD7fG0hL3wZ6qE9tY2iA8");
  await expect(row(page, "edge-cache")).toContainText("Waiting for your decision");
  await expect(row(page, "api-gateway")).toContainText("Succeeded");
  await page.waitForTimeout(300);
  expect(await calls(page, "session_trust_answer")).toHaveLength(0);
  await trust.getByRole("button", { name: "Trust once" }).click();
  await expect(row(page, "edge-cache")).toContainText("Succeeded");

  const opened = await calls(page, "session_open_exec");
  expect(opened.map((c) => c.args.interactive)).toEqual([true, true]);
  // build-runner-03 hangs in the mock: cancel stops it and drops every run-only connection.
  await expect(row(page, "build-runner-03")).toContainText("Running");
  await page.getByRole("button", { name: "Cancel runs" }).click();
  await expect(row(page, "build-runner-03")).toContainText("Cancelled");
  await expect.poll(async () => (await calls(page, "session_close")).length).toBe(2);
  await expect(page.getByTestId("run-summary")).toHaveText("2 succeeded, 1 failed");

  // Each host's output can be copied.
  await row(page, "edge-cache").locator("summary").click();
  await row(page, "edge-cache").getByRole("button", { name: "Copy the output of edge-cache" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ran on edge-cache\n");
});

test("a changed host key fails that host with the standard error", async ({ page }) => {
  await openApp(page, { hostKeyChangedFor: "edge-cache" });
  const dialog = await runOnHosts(page, "Disk usage");
  await dialog.getByRole("checkbox", { name: "Select edge-cache" }).check();
  await dialog.getByRole("button", { name: "Review 1 host" }).click();
  await page.getByRole("button", { name: "Run on 1 host" }).click();
  await expect(row(page, "edge-cache")).toContainText("The server's identity has changed");
  expect(await calls(page, "session_trust_answer")).toHaveLength(0);
  expect(await calls(page, "snippet_exec")).toHaveLength(0);
});

test("hosts that need sign-in input are asked in turn, or skipped when the user says so", async ({ page }) => {
  await openApp(page, { passwordPromptFor: "db-primary" });
  let dialog = await runOnHosts(page, "Disk usage");
  await dialog.getByRole("checkbox", { name: "Select db-primary" }).check();
  await dialog.getByRole("button", { name: "Review 1 host" }).click();
  await page.getByLabel("Skip hosts that need sign-in input").check();
  await page.getByRole("button", { name: "Run on 1 host" }).click();
  await expect(row(page, "db-primary")).toContainText("Skipped: needs sign-in");
  expect((await calls(page, "session_open_exec")).map((c) => c.args.interactive)).toEqual([false]);
  expect(await calls(page, "session_auth_answer")).toHaveLength(0);
  await page.getByRole("button", { name: "Done" }).click();

  dialog = await runOnHosts(page, "Disk usage");
  await dialog.getByRole("checkbox", { name: "Select db-primary" }).check();
  await dialog.getByRole("button", { name: "Review 1 host" }).click();
  await page.getByRole("button", { name: "Run on 1 host" }).click();
  const signIn = page.getByRole("region", { name: "Sign in to db-primary" });
  await expect(row(page, "db-primary")).toContainText("Waiting for sign-in");
  await signIn.getByLabel("Password").fill("synthetic-password");
  await signIn.getByRole("button", { name: "Sign in" }).click();
  await expect(row(page, "db-primary")).toContainText("Succeeded");
});

test("groups select their hosts and subgroups at once; a saved target keeps the group", async ({ page }) => {
  await openApp(page);
  const dialog = await runOnHosts(page, "Disk usage");
  const production = dialog.getByRole("checkbox", { name: "Select group Production" });
  await production.check();
  await expect(dialog.getByRole("checkbox", { name: "Select api-gateway" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Select db-primary" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Select group Databases" })).toBeChecked();
  // One host off: the group is partly selected.
  await dialog.getByRole("checkbox", { name: "Select db-primary" }).uncheck();
  await expect(production).toHaveJSProperty("indeterminate", true);
  await expect(dialog.getByRole("checkbox", { name: "Select group Databases" })).not.toBeChecked();
  await production.check();
  await expect(production).toHaveJSProperty("indeterminate", false);

  await dialog.getByLabel("Target name").fill("prod");
  await dialog.getByRole("button", { name: "Save selection" }).click();
  const [saved] = await calls(page, "execution_target_save");
  expect(saved?.args.target).toMatchObject({ name: "prod", groupIds: [expect.any(String)], hostIds: [] });

  await dialog.getByRole("button", { name: "Select all" }).click();
  await expect(dialog.getByRole("button", { name: "Review 6 hosts" })).toBeEnabled();
  await dialog.getByRole("checkbox", { name: "Select group Production" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Select group Lab" }).uncheck();
  await expect(dialog.getByRole("button", { name: "Review 3 hosts" })).toBeEnabled();

  // A saved group target is worked out into hosts when it is picked.
  await dialog.getByLabel("Saved targets").selectOption({ label: "prod (1 group)" });
  await expect(dialog.getByRole("button", { name: "Review 2 hosts" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Review 2 hosts" }).click();
  const review = page.getByTestId("run-review");
  await expect(review.getByRole("listitem")).toHaveText([/api-gateway/, /db-primary/]);
});

test("run on all open sessions goes straight to the review of exactly those sessions", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway", "staging-web");
  await primary(page).getByRole("button", { name: /^Snippets/ }).click();
  await page.getByRole("button", { name: "More actions for Disk usage" }).click();
  await page.getByRole("menuitem", { name: "Run on all open sessions" }).click();
  const review = page.getByRole("dialog", { name: "Run “Disk usage”?" });
  await expect(review.getByTestId("run-review").getByRole("listitem")).toHaveText([/api-gateway/, /staging-web/]);
  expect(await calls(page, "snippet_exec")).toHaveLength(0);
  await review.getByRole("button", { name: "Run on 2 hosts" }).click();
  await expect(page.getByTestId("run-summary")).toHaveText("1 succeeded, 1 failed");
  expect(await calls(page, "session_open_exec")).toHaveLength(0);
  await page.getByRole("button", { name: "Done" }).click();

  // The same from the command palette.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("on all open sessions");
  await page.getByRole("option", { name: /Run a snippet on all open sessions/ }).click();
  const picker = page.getByRole("dialog", { name: "Run a snippet on all open sessions" });
  await picker.getByLabel("Snippet").selectOption({ label: "Disk usage" });
  await picker.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("dialog", { name: "Run “Disk usage”?" }).getByTestId("run-review").getByRole("listitem")).toHaveCount(2);
});

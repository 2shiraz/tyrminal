// Snippet runs on several hosts, saved targets and organization (SNP-05/06/07/10), against the UI
// test mock. The real runs (exec channels, per-host exit status, cancellation, ownership, no PTY)
// are tested against the SSH lab: crates/core/tests/inventory_lab.rs.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

async function connect(page: Page, ...labels: string[]) {
  for (const label of labels) {
    await primary(page).getByRole("button", { name: /^Hosts/ }).click();
    await connectHost(page, label);
  }
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(labels.length);
}

async function runOnHosts(page: Page, snippet: string) {
  await primary(page).getByRole("button", { name: /^Snippets/ }).click();
  await page.getByRole("button", { name: `More actions for ${snippet}` }).click();
  await page.getByRole("menuitem", { name: "Run on hosts…" }).click();
  return page.getByRole("dialog", { name: `Run “${snippet}” on hosts` });
}

test("run on several hosts: review first, then each host's own result; a host without a session gets its own connection", async ({ page }) => {
  // The production confirmation (P-26) is covered in production.spec.ts; the tag is off here.
  await openApp(page, { productionTag: "" });
  await connect(page, "api-gateway", "staging-web");
  const dialog = await runOnHosts(page, "Disk usage");
  const hosts = dialog.getByTestId("run-hosts");
  await expect(hosts.getByRole("listitem").filter({ hasText: "api-gateway" })).toContainText("Session open");
  await expect(hosts.getByRole("listitem").filter({ hasText: "edge-cache" })).toContainText("No open session");
  for (const label of ["api-gateway", "staging-web", "edge-cache"]) await dialog.getByRole("checkbox", { name: `Select ${label}` }).check();
  await dialog.getByRole("button", { name: "Review 3 hosts" }).click();

  const review = page.getByRole("dialog", { name: "Run “Disk usage”?" });
  await expect(review.locator("pre")).toHaveText("df -h");
  await expect(review).toContainText("1 host has no open session: Tyrminal connects to it for this run");
  expect(await calls(page, "snippet_exec")).toHaveLength(0);
  await review.getByRole("button", { name: "Run on 3 hosts" }).click();

  const results = page.getByTestId("run-results");
  await expect(page.getByTestId("run-summary")).toHaveText("2 succeeded, 1 failed");
  await expect(results.locator('[data-host="api-gateway"]')).toContainText("Succeeded");
  await expect(results.locator('[data-host="staging-web"]')).toContainText("Exit status 2");
  await expect(results.locator('[data-host="edge-cache"]')).toContainText("Succeeded");
  await results.locator('[data-host="staging-web"] summary').click();
  await expect(results.locator('[data-host="staging-web"]')).toContainText("permission denied");
  // Environment variables the server refused on that host are reported with its result (SNP-13).
  await expect(results.locator('[data-host="staging-web"]')).toContainText("Not set by the server: LEGACY_MODE");
  expect(await calls(page, "snippet_exec")).toHaveLength(3);
  expect(await calls(page, "session_open_exec")).toHaveLength(1);
  await page.getByRole("button", { name: "Done" }).click();
});

test("a selection is saved as a target and picked again later", async ({ page }) => {
  await openApp(page);
  let dialog = await runOnHosts(page, "Disk usage");
  await dialog.getByRole("checkbox", { name: "Select api-gateway" }).check();
  await dialog.getByRole("checkbox", { name: "Select db-primary" }).check();
  await dialog.getByLabel("Target name").fill("prod pair");
  await dialog.getByRole("button", { name: "Save selection" }).click();
  await expect(page.getByText("Saved target “prod pair”")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  dialog = await runOnHosts(page, "Tail app log");
  await dialog.getByLabel("Saved targets").selectOption({ label: "prod pair (2 hosts)" });
  await expect(dialog.getByRole("checkbox", { name: "Select api-gateway" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Select db-primary" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Review 2 hosts" })).toBeEnabled();
});

test("running hosts can be cancelled; open sessions can be selected in one step", async ({ page }) => {
  // The production confirmation (P-26) is covered in production.spec.ts; the tag is off here.
  await openApp(page, { productionTag: "" });
  await connect(page, "build-runner-03", "api-gateway");
  const dialog = await runOnHosts(page, "Disk usage");
  await dialog.getByRole("button", { name: "Select hosts with open sessions" }).click();
  await dialog.getByRole("button", { name: "Review 2 hosts" }).click();
  await page.getByRole("button", { name: "Run on 2 hosts" }).click();
  const results = page.getByTestId("run-results");
  await expect(results.locator('[data-host="api-gateway"]')).toContainText("Succeeded");
  await expect(results.locator('[data-host="build-runner-03"]')).toContainText("Running");
  await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel runs" }).click();
  await expect(results.locator('[data-host="build-runner-03"]')).toContainText("Cancelled");
  await expect(page.getByTestId("run-summary")).toHaveText("1 succeeded, 1 failed");
  expect(await calls(page, "snippet_exec_cancel")).toHaveLength(1);
});

test("snippets move and copy between folders; a folder is renamed with its subfolders", async ({ page }) => {
  await openApp(page);
  await primary(page).getByRole("button", { name: /^Snippets/ }).click();
  await page.getByRole("button", { name: "More actions for Disk usage" }).click();
  await page.getByRole("menuitem", { name: "Copy to folder…" }).click();
  await page.getByRole("dialog").getByLabel("Folder").fill("Ops");
  await page.getByRole("dialog").getByRole("button", { name: "Copy to folder" }).click();
  await expect(page.getByText("Copied to Ops")).toBeVisible();
  await expect(page.getByRole("list", { name: "Ops" }).locator('[data-snippet="Disk usage"]')).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Unfiled" }).locator('[data-snippet="Disk usage"]')).toHaveCount(1);

  await page.getByRole("button", { name: "More actions for Top memory users" }).click();
  await page.getByRole("menuitem", { name: "Move to folder…" }).click();
  await page.getByRole("dialog").getByLabel("Folder").fill("Deploy/Staging");
  await page.getByRole("dialog").getByRole("button", { name: "Move to folder" }).click();
  await expect(page.getByRole("list", { name: "Deploy/Staging" }).locator('[data-snippet="Top memory users"]')).toHaveCount(1);

  const folder = page.locator(".folder", { has: page.locator(".folder-head", { hasText: "Deploy/Staging" }) });
  await folder.getByRole("button", { name: "Rename folder" }).click();
  await page.getByRole("dialog").getByLabel("Folder").fill("Deploy/Stage");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 snippets moved")).toBeVisible();
  await expect(page.getByRole("list", { name: "Deploy/Stage" }).locator("li")).toHaveCount(2);
  const [rename] = await calls(page, "snippet_folder_rename");
  expect(rename?.args).toEqual({ from: "Deploy/Staging", to: "Deploy/Stage" });
});

// Home (docs/design/revamp.md §5): quick connect, the start strip and the boxes, against the UI test
// mock. Nothing on Home connects, runs or sends outside the existing flows.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const box = (page: Page, name: string) => page.getByRole("region", { name });

test("home: quick connect saves a new destination, then connects through the trust prompt", async ({ page }) => {
  await openApp(page, { trustPromptFor: "198.51.100.7" });
  const field = page.getByRole("combobox", { name: "Quick connect" });
  await field.fill("ops@198.51.100.7:2200");
  await expect(page.getByRole("option", { name: /Save and connect to ops@198\.51\.100\.7:2200/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "host_save")).length).toBe(1);
  expect((await calls(page, "host_save"))[0]?.args).toEqual(
    expect.objectContaining({ host: expect.objectContaining({ address: "198.51.100.7", port: 2200, username: "ops" }) }),
  );
  await expect(page.getByRole("alertdialog", { name: "Verify this server before connecting" })).toBeVisible();
  expect(await calls(page, "session_trust_answer")).toHaveLength(0);
});

test("home: hosts are listed most recent first; a click selects, a double-click or Connect connects", async ({ page }) => {
  await openApp(page);
  const hosts = box(page, "Hosts");
  const rows = hosts.locator("tbody tr");
  await expect(rows.first()).toContainText("api-gateway");
  await expect(rows.first()).toContainText("10 min ago");
  // Never-used hosts come last and say so.
  await expect(rows.filter({ hasText: "edge-cache" })).toContainText("Never");

  await rows.filter({ hasText: "db-primary" }).click();
  await expect(rows.filter({ hasText: "db-primary" })).toHaveClass(/is-selected/);
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);

  await rows.filter({ hasText: "build-runner-03" }).dblclick();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  await expect(page.getByRole("tab", { name: /build-runner-03/ })).toBeVisible();
});

test("home: the start strip opens the existing dialogs, and Shortcuts opens Settings", async ({ page }) => {
  await openApp(page);
  const strip = page.getByRole("group", { name: "Start something" });
  await strip.getByRole("button", { name: "Import" }).click();
  await expect(page.getByRole("dialog", { name: /Import/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await strip.getByRole("button", { name: "Generate key" }).click();
  await expect(page.getByRole("dialog", { name: /Generate/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("home: snippets need an open session, and Run in… only opens the review", async ({ page }) => {
  await openApp(page);
  const snippets = box(page, "Snippets");
  const run = snippets.getByRole("button", { name: "Run Disk usage in…" });
  await expect(run).toBeDisabled();

  await connectHost(page, "api-gateway");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Home" }).click();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByRole("dialog", { name: "Run “Disk usage” on hosts" })).toBeVisible();
  // Nothing runs or is typed until the review is confirmed.
  expect(await calls(page, "session_open_exec")).toHaveLength(0);
  expect(await calls(page, "session_write")).toHaveLength(0);
});

test("home: the security review box counts findings locally and never runs the password check", async ({ page }) => {
  await openApp(page, { reviewFixtures: true });
  const review = box(page, "Security review");
  await expect(review.getByText(/DSA key/)).toBeVisible();
  await expect(review.getByText(/Checked .* on this device/)).toBeVisible();
  expect(await calls(page, "security_review")).toHaveLength(1);
  // Coming back to Home keeps the result for this unlock instead of reviewing again.
  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("button", { name: /^Hosts/ }).click();
  await primary.getByRole("button", { name: "Home" }).click();
  await expect(review.getByText(/DSA key/)).toBeVisible();
  expect(await calls(page, "security_review")).toHaveLength(1);
  expect(await calls(page, "password_check_run")).toHaveLength(0);
  await review.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Security review" })).toBeVisible();
});

test("home: a first run welcomes and offers four ways to start", async ({ page }) => {
  await openApp(page, { scenario: "empty" });
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to Tyrminal" })).toBeVisible();
  const start = box(page, "Get started");
  await expect(start.getByRole("button")).toHaveText([/Add a host/, /Import hosts/, /Generate a key/, /Open a local terminal/]);
  await start.getByRole("button", { name: /Add a host/ }).click();
  await expect(page.getByRole("dialog", { name: /host/i })).toBeVisible();
});

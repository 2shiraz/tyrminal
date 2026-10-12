// Server at a glance (P-32) against the UI test mock (UI evidence only; parsing and the
// close/lock rules are tested in crates/core/src/server_glance.rs and
// crates/core/tests/sessions_lab.rs). The panel is offered for SSH sessions only, reads only
// while it is open, shows server text as plain text, and can be turned off for one host.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const glanceCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.filter((x) => x.cmd === "glance_get").length);

async function connect(page: Page, host = "api-gateway") {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: `Connect to ${host}` }).click();
}

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await waitForTerminalText(page, "deploy@api-gateway");
}

const serverButton = (page: Page) => page.locator('.statusbar [data-panel="server"]');
const panel = (page: Page) => page.getByRole("complementary", { name: "Server" });

test("server panel: shows uptime, load, memory and disks, with server text as plain text", async ({ page }) => {
  await connected(page);
  await serverButton(page).click();
  const p = panel(page);
  await expect(p.locator('[data-glance="uptime"]')).toHaveText("1 d 2 h");
  await expect(p.locator('[data-glance="load"]')).toHaveText("0.15  0.30  0.45");
  await expect(p.locator('[data-glance="memory"]')).toContainText("1.5 GB of 2.0 GB used");
  const disks = p.locator('[data-glance="disks"] li');
  await expect(disks).toHaveCount(2);
  // A mount point is shown as the text the server sent; it is never markup.
  await expect(disks.nth(1)).toContainText("/srv/<b>data</b>");
  await expect(p.locator("b")).toHaveCount(0);
});

test("server panel: reads only while open, about every 5 s", async ({ page }) => {
  await connected(page);
  expect(await glanceCalls(page)).toBe(0);
  await serverButton(page).click();
  await expect(panel(page).locator('[data-glance="uptime"]')).toBeVisible();
  await expect.poll(() => glanceCalls(page), { timeout: 8_000 }).toBe(2);
  // Not sooner than every 5 s.
  await page.waitForTimeout(2_000);
  expect(await glanceCalls(page)).toBe(2);
  await panel(page).getByRole("button", { name: "Close server panel" }).click();
  await expect(panel(page)).toHaveCount(0);
  const closedAt = await glanceCalls(page);
  await page.waitForTimeout(6_000);
  expect(await glanceCalls(page)).toBe(closedAt);
});

test("server panel: stops when the session ends", async ({ page }) => {
  await connected(page);
  await serverButton(page).click();
  await expect(panel(page).locator('[data-glance="uptime"]')).toBeVisible();
  // An error that is not retried, so no new session takes its place.
  await page.evaluate(() => (window as unknown as { __mockDrop: (code: string) => void }).__mockDrop("IO_ERROR"));
  await expect(panel(page)).toContainText("behind the focused SSH session");
  const endedAt = await glanceCalls(page);
  await page.waitForTimeout(6_000);
  expect(await glanceCalls(page)).toBe(endedAt);
});

test("server panel: values the core could not read show as unavailable, other systems as not available", async ({ page }) => {
  await connected(page);
  await page.evaluate(() => {
    (window as unknown as { __mockGlance: unknown }).__mockGlance = {
      kind: "available",
      stats: { uptimeSeconds: 600, load: null, memory: null, disks: null },
    };
  });
  await serverButton(page).click();
  const p = panel(page);
  await expect(p.locator('[data-glance="uptime"]')).toHaveText("10 min");
  for (const key of ["load", "memory", "disks"]) await expect(p.locator(`[data-glance="${key}"]`)).toHaveText("Unavailable");

  await page.evaluate(() => {
    (window as unknown as { __mockGlance: unknown }).__mockGlance = { kind: "notAvailable", reason: "notLinux" };
  });
  await expect(p.locator('[data-glance="unavailable"]')).toHaveText("Not available. This works on Linux servers only.", { timeout: 8_000 });
});

test("server panel: can be turned off for one host", async ({ page }) => {
  await connected(page);
  await serverButton(page).click();
  const p = panel(page);
  const toggle = p.getByRole("switch", { name: /Show for this host/ });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(p).toContainText("Off for this host.");
  const sets = await page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === "glance_host_set"),
  );
  expect(sets.at(-1)?.args).toMatchObject({ enabled: false });
  await toggle.check();
  await expect(p.locator('[data-glance="uptime"]')).toHaveText("1 d 2 h");
});

test("server panel: never offered for a Telnet session", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Add host" }).click();
  // Renamed "Host details" once autosave creates the host.
  const dialog = page.getByTestId("host-panel");
  await dialog.getByLabel("Name", { exact: true }).fill("old-switch");
  await dialog.getByRole("combobox", { name: "Protocol" }).selectOption("telnet");
  await dialog.getByLabel("Address").fill("192.0.2.40");
  await dialog.getByLabel("Name", { exact: true }).focus();
  await expect(dialog).toHaveAttribute("data-autosave", "clean");
  await expect(dialog).toHaveAttribute("data-created", "true");
  await page.getByRole("button", { name: "Connect to old-switch" }).click();
  await expect(page.getByText("Telnet is not encrypted").first()).toBeVisible();
  await expect(page.locator('.statusbar [role="status"]')).toContainText(/Connected/i);
  await expect(serverButton(page)).toHaveCount(0);
  expect(await glanceCalls(page)).toBe(0);
});

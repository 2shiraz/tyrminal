// The new-tab page against the UI test mock: "+" in the tab strip opens a tab showing a connect
// box, what a tab can open and recent connections. Picking one turns that same tab into the
// session (no second tab); an address quick-connects in place; Escape on an untouched page closes
// it. The sessions themselves are covered by the connection, quick-connect and native suites.
import { type Page, expect, test } from "@playwright/test";

import { uiModifier, openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const sessionTabs = (page: Page) => page.getByRole("tab").filter({ hasNotText: /^Hosts$/ });
const plus = (page: Page) => page.getByRole("button", { name: "New tab", exact: true });
const startPage = (page: Page) => page.getByRole("region", { name: "Open in this tab" });
const box = (page: Page) => page.getByRole("searchbox", { name: "Find a host or connect to an address" });
/** Types into the connect box and waits for the core's search to answer this text. */
async function find(page: Page, text: string) {
  const before = (await calls(page, "host_search")).length;
  await box(page).fill(text);
  await expect.poll(async () => (await calls(page, "host_search")).slice(before).some((c) => c.args.query === text.trim())).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("+ opens a new tab page: a focused connect box, what a tab can open, recent connections", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /New tab/ })).toHaveAttribute("aria-selected", "true");
  await expect(startPage(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(box(page)).toHaveAttribute("placeholder", "Find a host or ssh user@hostname…");
  const actions = startPage(page).getByRole("group", { name: "Open" });
  await expect(actions.getByRole("button")).toHaveText([/Local terminal/, "SFTP", "Serial", "Hosts"]);
  // Most recent first; never-connected hosts are not listed.
  await expect(startPage(page).getByRole("list", { name: "Recent connections" }).getByRole("button")).toHaveText([/api-gateway/, /build-runner-03/, /db-primary/, /Home lab/]);
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);
  expect(await calls(page, "session_open_local")).toHaveLength(0);
});

test("picking a recent connection connects in this tab", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await startPage(page).getByRole("list", { name: "Recent connections" }).getByRole("button", { name: /db-primary/ }).click();
  await expect(startPage(page)).toHaveCount(0);
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /db-primary/ })).toHaveAttribute("aria-selected", "true");
});

test("Enter connects the first matching host in this tab", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await find(page, "build");
  await expect(startPage(page).getByRole("list", { name: "Matching hosts" }).getByRole("button")).toHaveText([/build-runner-03/]);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /build-runner-03/ })).toBeVisible();
});

test("an address that matches no host quick-connects in this tab", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await find(page, "ssh ops@198.51.100.7 -p 2200");
  await expect(startPage(page).getByRole("button", { name: "Connect to ops@198.51.100.7:2200" })).toBeVisible();
  await page.keyboard.press("Enter");
  // The same tab becomes the quick connection and shows its setup, with what was typed.
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /198\.51\.100\.7/ })).toHaveAttribute("aria-selected", "true");
  const setup = page.getByRole("region", { name: "Connect to 198.51.100.7" });
  await expect(setup).toBeVisible();
  await expect(setup.getByLabel("SSH port", { exact: true })).toHaveValue("2200");
  expect(await calls(page, "session_open_quick")).toHaveLength(0);
});

test("the tiles open in this tab: Local terminal, and Hosts closes the page", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await startPage(page).getByRole("button", { name: /Local terminal/ }).click();
  await expect.poll(async () => (await calls(page, "session_open_local")).length).toBe(1);
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /Local terminal/ })).toBeVisible();

  await plus(page).click();
  await expect(sessionTabs(page)).toHaveCount(2);
  await startPage(page).getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "Hosts" })).toBeVisible();
});

test("Serial opens a new serial host on Hosts, like the Hosts toolbar's Serial", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await startPage(page).getByRole("button", { name: "Serial", exact: true }).click();
  await expect(sessionTabs(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Hosts" })).toBeVisible();
  await expect(page.locator(".host-panel")).toBeVisible();
  await expect(page.locator(".host-panel")).toContainText(/serial/i);
});

test("Escape clears the box first, then closes an untouched page", async ({ page }) => {
  await openApp(page);
  await plus(page).click();
  await box(page).fill("db");
  await page.keyboard.press("Escape");
  await expect(box(page)).toHaveValue("");
  await expect(sessionTabs(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(sessionTabs(page)).toHaveCount(0);
});

test("the new tab page shortcut opens it", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press(`${uiModifier}+Shift+KeyN`);
  await expect(startPage(page)).toBeVisible();
  await expect(sessionTabs(page)).toHaveCount(1);
});

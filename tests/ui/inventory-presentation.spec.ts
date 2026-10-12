// Inventory presentation and group-wide connection (HST-13, HST-06), against the UI test mock.
// The real rules (all-or-nothing OS changes, deletes that take the OS record along) are tested in
// the core against a real vault: crates/core/tests/inventory.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

async function openHosts(page: Page) {
  await primary(page).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

const hostCards = (page: Page) => page.getByTestId("host-list").getByRole("article");
const labels = (page: Page) => hostCards(page).evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label")));

test("hosts sort by name, address and group", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  const sort = page.getByRole("radiogroup", { name: "Sort" });
  await sort.getByText("Address").click();
  expect(await labels(page)).toEqual(["api-gateway", "Home lab", "edge-cache", "build-runner-03", "db-primary", "staging-web"]);
  await sort.getByText("Group").click();
  // Databases sorts after Lab only by path: "Lab" < "Production" < "Production/Databases"; ungrouped last.
  expect(await labels(page)).toEqual(["Home lab", "api-gateway", "db-primary", "build-runner-03", "edge-cache", "staging-web"]);
  await sort.getByText("Name").click();
  expect(await labels(page)).toEqual(["api-gateway", "build-runner-03", "db-primary", "edge-cache", "Home lab", "staging-web"]);
});

test("select all shown hosts and shift-click a range", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  const all = page.getByRole("checkbox", { name: "Select all shown hosts" });
  await all.check();
  await expect(page.getByTestId("bulk-bar")).toContainText("6 selected");
  await all.uncheck();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Select build-runner-03" }).click();
  await page.getByRole("checkbox", { name: "Select Home lab" }).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("bulk-bar")).toContainText("4 selected");
  await expect(all).not.toBeChecked();
  expect(await all.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);

  // Search narrows what "all shown" means.
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByRole("searchbox", { name: "Search hosts" }).fill("tag:prod");
  await expect(hostCards(page)).toHaveCount(2);
  await all.check();
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
});

test("set the OS of selected hosts: the tile shows its icon", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await page.getByRole("checkbox", { name: "Select edge-cache" }).check();
  await page.getByRole("checkbox", { name: "Select staging-web" }).check();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Set OS" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Operating system").selectOption({ label: "Debian" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 hosts changed")).toBeVisible();
  const [set] = await calls(page, "host_set_os");
  expect(set?.args).toMatchObject({ os: "debian" });
  await expect(hostCards(page).filter({ has: page.getByRole("img", { name: "Operating system: Debian" }) })).toHaveCount(2);

  // One host from its menu; "Not set" clears it.
  await page.getByRole("button", { name: "More actions for edge-cache" }).click();
  await page.getByRole("menuitem", { name: "Set OS" }).click();
  await expect(page.getByRole("dialog").getByLabel("Operating system")).toHaveValue("debian");
  await page.getByRole("dialog").getByLabel("Operating system").selectOption({ label: "Not set" });
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(hostCards(page).filter({ has: page.getByRole("img", { name: "Operating system: Debian" }) })).toHaveCount(1);
});

test("connect to every host of a group after reviewing the list", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "Connect to every host" }).click();
  const dialog = page.getByRole("dialog", { name: "Open 2 sessions?" });
  // The subgroup's host is included and listed before anything connects.
  await expect(dialog.getByTestId("connect-all-list").getByRole("listitem")).toHaveCount(2);
  await expect(dialog).toContainText("api-gateway");
  await expect(dialog).toContainText("db-primary");
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);

  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "Connect to every host" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open 2 sessions" }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
});

test("a group-wide connection that does not fit is refused, not cut short", async ({ page }) => {
  await openApp(page);
  // Twelve sessions open (six hosts, twice), so four more fit.
  for (let round = 0; round < 2; round++) {
    await openHosts(page);
    await page.getByRole("checkbox", { name: "Select all shown hosts" }).check();
    await page.getByTestId("bulk-bar").getByRole("button", { name: "Connect" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Open 6 sessions" }).click();
  }
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(12);
  await openHosts(page);
  await page.getByRole("checkbox", { name: "Select all shown hosts" }).check();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Connect" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Only 4 more sessions can be open at once");
  await expect(dialog.getByRole("button", { name: "Open 6 sessions" })).toBeDisabled();
});

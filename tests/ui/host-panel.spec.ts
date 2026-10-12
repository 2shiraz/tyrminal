// Host details panel on the Hosts view: opening and closing, focus, editing and saving, the
// unsaved-changes guard, the write-only password, and the full-width layout at narrow widths.
// Runs against the UI test mock; host validation and storage are tested in the core.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function openHosts(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

const panel = (page: Page) => page.getByTestId("host-panel");
const details = (page: Page) => page.getByRole("complementary", { name: "Host details" });
const list = (page: Page) => page.getByTestId("host-list");
const status = (page: Page) => panel(page).getByTestId("host-panel-status");

test("clicking a host opens its details beside the list; Escape closes and focus returns", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByLabel("Address")).toBeFocused();
  await expect(details(page).getByLabel("Address")).toHaveValue("203.0.113.24");
  await expect(details(page).getByLabel("Name", { exact: true })).toHaveValue("edge-cache");
  await expect(panel(page).getByTestId("host-panel-location")).toHaveText("Local vault");
  // The cards, top to bottom.
  await expect(panel(page).locator("h3")).toHaveText(["General", "Protocol", "Credentials"]);
  await expect(panel(page).getByText("Show more")).toBeVisible();
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toHaveAttribute("aria-current", "true");

  // The list stays usable: another host opens in the same panel.
  await list(page).getByRole("article", { name: "api-gateway" }).locator(".host-card-dest").click();
  await expect(details(page).getByLabel("Address")).toHaveValue("10.20.0.11");
  await expect(panel(page).getByTestId("host-panel-location")).toHaveText("Local vault · Production");

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toBeFocused();
});

test("New host opens an empty panel; the collapse button closes it and focus returns", async ({ page }) => {
  await openHosts(page);
  const add = page.getByRole("button", { name: "Add host" });
  await add.click();
  const fresh = page.getByRole("complementary", { name: "New host" });
  await expect(fresh.getByLabel("Address")).toBeFocused();
  await expect(fresh.getByLabel("Address")).toHaveValue("");
  await expect(fresh.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(fresh.getByLabel("Port")).toHaveValue("22");
  // No menu for a host that does not exist yet; saving explains what is missing.
  await expect(fresh.getByRole("button", { name: "Host details actions" })).toHaveCount(0);
  await expect(fresh.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(status(page)).toHaveText("To save, fill in: Address, Name, User name.");
  await fresh.getByRole("button", { name: "Close host details" }).click();
  await expect(fresh).toHaveCount(0);
  await expect(add).toBeFocused();
});

test("edit and save: the panel stays open with the saved host, and the list updates", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await expect(details(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await details(page).getByLabel("Name", { exact: true }).fill("staging-web-2");
  await details(page).getByLabel("Port").fill("2200");
  await expect(status(page)).toHaveText("Unsaved changes");
  await expect(details(page).getByRole("button", { name: "Save and connect" })).toBeEnabled();
  // Enter in a field saves.
  await details(page).getByLabel("Port").press("Enter");
  await expect(status(page)).toHaveText("Saved");
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByRole("heading", { name: "Host details" })).toBeFocused();
  await expect(details(page).getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  const saves = await calls(page, "host_save");
  expect(saves).toHaveLength(1);
  expect(saves[0]?.args).toMatchObject({ host: { label: "staging-web-2", port: 2200, address: "stg.example.net" } });
  await expect(list(page).getByRole("button", { name: "staging-web-2", exact: true })).toBeVisible();

  // Invalid input blocks saving with a reason; nothing is sent.
  await details(page).getByLabel("Port").fill("70000");
  await expect(details(page).getByRole("alert")).toHaveText("1–65535");
  await expect(details(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(details(page).getByRole("button", { name: "Save and connect" })).toBeDisabled();
  await expect(status(page)).toHaveText("To save, fill in: Port.");
  expect(await calls(page, "host_save")).toHaveLength(1);
});

test("unsaved changes are never dropped silently", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "db-primary", exact: true }).click();
  await details(page).getByLabel("Tags").fill("prod, primary");

  // Escape asks first; "Keep editing" (the default) keeps the edit.
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog", { name: "Discard changes to “db-primary”?" });
  await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(details(page).getByLabel("Tags")).toHaveValue("prod, primary");

  // Opening another host asks too; discarding switches.
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await confirm.getByRole("button", { name: "Discard changes" }).click();
  await expect(details(page).getByLabel("Address")).toHaveValue("203.0.113.24");

  // Cancel discards on purpose, without asking.
  await details(page).getByLabel("Tags").fill("cache");
  await details(page).getByRole("button", { name: "Cancel" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  expect(await calls(page, "host_save")).toHaveLength(0);
});

test("a stored password is masked, revealed only on request, sent once and never shown again", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByRole("radio", { name: /Store a password in the vault/ }).check();
  const password = details(page).getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveValue("");
  await password.fill("canary-ui-host-secret");
  const reveal = details(page).getByRole("button", { name: "Show" });
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await reveal.click();
  await expect(password).toHaveAttribute("type", "text");
  await details(page).getByRole("button", { name: "Hide" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await details(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(status(page)).toHaveText("Saved");
  const [save] = await calls(page, "host_save");
  expect(save?.args).toMatchObject({ host: { auth: { kind: "stored_password", password: "canary-ui-host-secret" } } });

  // Rebuilt from the saved host: the field is empty, masked, and says a password is kept.
  await expect(details(page).getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(details(page).getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  await expect(details(page).getByText("A password is stored. Leave empty to keep it.")).toBeVisible();
  expect(await page.content()).not.toContain("canary-ui-host-secret");
});

test("the menu copies the address, duplicates, and deletes after confirmation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openHosts(page);
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  const menu = details(page).getByRole("button", { name: "Host details actions" });

  await menu.click();
  await page.getByRole("menuitem", { name: "Copy address" }).click();
  await expect(page.getByText("Address copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("203.0.113.24");

  await menu.click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Created “edge-cache (copy)”")).toBeVisible();

  await menu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete “edge-cache”?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add host" })).toBeFocused();
  expect(await calls(page, "host_delete")).toHaveLength(1);
});

test("a new host saves and connects from the bottom button", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Add host" }).click();
  const fresh = page.getByRole("complementary", { name: "New host" });
  await fresh.getByLabel("Address").fill("198.51.100.7");
  await fresh.getByLabel("Name", { exact: true }).fill("lab-box");
  await fresh.getByLabel("User name").fill("tester");
  await fresh.getByRole("radio", { name: /Ask for the password each time/ }).check();
  await fresh.getByRole("button", { name: "Save and connect" }).click();
  await expect(page.getByRole("tab", { name: /lab-box/ })).toBeVisible();
  expect(await calls(page, "host_save")).toHaveLength(1);
});

test("at a narrow width the panel takes the whole view and the list behind it is inert", async ({ page }) => {
  await openHosts(page);
  await page.setViewportSize({ width: 820, height: 760 });
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  const layout = page.locator(".hosts-layout");
  await expect(layout).toHaveAttribute("data-narrow", "true");
  const [box, outer] = await Promise.all([panel(page).boundingBox(), layout.boundingBox()]);
  expect(box?.width).toBeCloseTo(outer?.width ?? 0, 0);
  await expect(page.locator(".hosts-main")).toHaveAttribute("inert", "");
  // Tab stays inside the panel (the list is inert).
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".hosts-main"))).toBe(false);
  }
  await details(page).getByRole("button", { name: "Close host details" }).click();
  await expect(page.locator(".hosts-main")).not.toHaveAttribute("inert", "");
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toBeFocused();

  // Wide again: side by side.
  await page.setViewportSize({ width: 1360, height: 860 });
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await expect(layout).toHaveAttribute("data-narrow", "false");
  const wide = await panel(page).boundingBox();
  expect(wide?.width).toBe(400);
});

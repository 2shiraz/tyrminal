// Host inventory UI (Phase 04): groups, tags, search, bulk changes, duplicate, inherited
// settings in the editor, and the import preview. Runs against the UI test mock; the real rules
// (inheritance, cycles, transactions, parsing) are tested in the core against a real vault.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function openHosts(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

const hostCards = (page: Page) => page.getByTestId("host-list").getByRole("article");

test("groups: each level shows its subgroups, then its own hosts; a breadcrumb leads back", async ({ page }) => {
  await openHosts(page);
  const groups = page.getByTestId("group-bar");
  const crumbs = page.getByTestId("breadcrumb");
  // At the top: the top-level groups, and every host while "Show all hosts" is on.
  await expect(groups.locator(".group-open")).toHaveText(["Lab", "Production"]);
  await expect(groups.getByText("2 hosts")).toBeVisible();
  await expect(hostCards(page)).toHaveCount(6);
  await groups.getByRole("button", { name: "Production", exact: true }).click();
  // Inside Production: its subgroup, then its own host.
  await expect(groups.locator(".group-open")).toHaveText(["Databases"]);
  await expect(hostCards(page)).toHaveCount(1);
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("Production");
  await groups.getByRole("button", { name: "Databases", exact: true }).click();
  await expect(hostCards(page)).toHaveCount(1);
  await expect(hostCards(page)).toHaveAttribute("aria-label", "db-primary");
  await crumbs.getByRole("button", { name: "Production" }).click();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("Production");
  await crumbs.getByRole("button", { name: "Hosts" }).click();
  await expect(crumbs).toHaveCount(0);
  await expect(hostCards(page)).toHaveCount(6);
  // Without "Show all hosts", the top level lists the hosts in no group.
  const showAll = page.getByRole("switch", { name: "Show all hosts" });
  await expect(showAll).toBeChecked();
  await showAll.uncheck();
  await expect(hostCards(page)).toHaveCount(3);
  await showAll.check();
  await expect(hostCards(page)).toHaveCount(6);
});

test("search goes through the core and understands tag: and group:", async ({ page }) => {
  await openHosts(page);
  const search = page.getByRole("searchbox", { name: "Search hosts" });
  await search.fill("tag:prod");
  await expect(hostCards(page)).toHaveCount(2);
  await search.fill("group:lab");
  await expect(hostCards(page)).toHaveCount(1);
  await expect(hostCards(page).first()).toHaveAccessibleName("Home lab");
  await search.fill("nothing-matches-this");
  await expect(page.getByText("No saved host matches.")).toBeVisible();
  expect((await calls(page, "host_search")).length).toBeGreaterThan(0);
});

test("bulk: select hosts, add a tag and move them, all in one call each", async ({ page }) => {
  await openHosts(page);
  const name = (label: string) => page.getByTestId("host-list").getByRole("button", { name: label, exact: true });
  await name("edge-cache").click({ modifiers: ["ControlOrMeta"] });
  await name("staging-web").click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByTestId("bulk-bar");
  await expect(bar).toContainText("2 selected");

  await bar.getByRole("button", { name: "More…" }).click();

  await page.getByRole("menuitem", { name: "Add tag…" }).click();
  await page.getByRole("dialog").getByLabel("Tag").fill("legacy");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 hosts changed")).toBeVisible();
  const [add] = await calls(page, "host_bulk");
  expect(add?.args).toMatchObject({ change: { kind: "add_tag", tag: "legacy" } });
  await expect(hostCards(page).filter({ hasText: "legacy" })).toHaveCount(2);

  // The strip shows from two hosts on: move both tagged hosts to Lab, which holds Home lab.
  await name("edge-cache").click();
  await name("staging-web").click({ modifiers: ["ControlOrMeta"] });
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Move to group" }).click();
  await page.getByRole("dialog").getByRole("combobox").selectOption({ label: "Lab" });
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  const [move] = (await calls(page, "host_bulk")).slice(-1);
  expect(move?.args).toMatchObject({ change: { kind: "move_to_group" } });
  await page.getByTestId("group-bar").getByRole("button", { name: "Lab", exact: true }).click();
  await expect(hostCards(page)).toHaveCount(3);
});

test("duplicate creates a full copy through the core", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "More actions for edge-cache" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Created “edge-cache (copy)”")).toBeVisible();
  await expect(hostCards(page)).toHaveCount(7);
  expect(await calls(page, "host_duplicate")).toHaveLength(1);
});

test("a host in a group may leave user, port and key to the group", async ({ page }) => {
  await openHosts(page);
  await page.getByTestId("group-bar").getByRole("button", { name: "Production", exact: true }).click();
  await page.getByTestId("group-bar").getByRole("button", { name: "Databases", exact: true }).click();
  await page.getByRole("button", { name: "New host" }).click();
  // Renamed "Host details" once autosave creates the host.
  const dialog = page.getByTestId("host-panel");
  await expect(dialog.getByRole("combobox", { name: "Group" })).toHaveValue(/./);
  await dialog.getByLabel("Name", { exact: true }).fill("db-replica");
  await dialog.getByLabel("Address").fill("db2.internal.example");
  // User name and port stay empty: the editor shows what comes from the group chain.
  await expect(dialog.getByText("From the group: postgres")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Use the group's key/ })).toBeChecked();
  await expect(dialog.getByText("Currently: Deploy key.")).toBeVisible();
  await expect(dialog.getByText(/Connects to db2.internal.example on port 22 as postgres/)).toBeVisible();
  await dialog.getByLabel("Tags").fill("prod, replica");
  // Saved as you go: created once the address was valid, then updated.
  await expect.poll(async () => (await calls(page, "host_save")).at(-1)?.args).toMatchObject({ host: { tags: ["prod", "replica"] } });
  await expect(page.getByTestId("host-panel")).toHaveAttribute("data-autosave", "clean");
  const saves = await calls(page, "host_save");
  expect(saves.at(-1)?.args).toMatchObject({ host: { username: "", port: null, auth: { kind: "inherit" }, tags: ["prod", "replica"] } });
});

test("groups: create a subgroup; a non-empty group cannot be deleted", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "New group" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "Inside" })).toHaveValue(/./);
  await dialog.getByLabel("Name", { exact: true }).fill("Web");
  // Enter saves at once; Done closes and opens the new group.
  await dialog.getByLabel("Name", { exact: true }).press("Enter");
  await expect.poll(async () => (await calls(page, "group_save")).length).toBe(1);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("breadcrumb").locator('[aria-current="page"]')).toHaveText("Web");

  await page.getByTestId("breadcrumb").getByRole("button", { name: "Hosts" }).click();
  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("not empty");
});

test("import shows a preview with what is left out before anything is added", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import hosts" });
  await expect(dialog.getByRole("button", { name: "Import 0 hosts" })).toBeDisabled();
  await dialog.getByLabel("Choose file").setInputFiles({
    name: "config",
    mimeType: "text/plain",
    buffer: Buffer.from("Host alpha\n  ProxyCommand nc %h %p\nHost beta\n"),
  });
  await expect(dialog.getByTestId("import-preview")).toContainText("2 hosts will be added");
  await expect(dialog.getByTestId("import-skipped")).toContainText("1 line is not imported");
  expect(await calls(page, "import_hosts")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Import 2 hosts" }).click();
  await expect(page.getByText("Imported 2 hosts")).toBeVisible();
  await expect(hostCards(page)).toHaveCount(8);
});

test("install a public key from the palette: check, see the line, install, then switch the host", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  // db-primary asks for a password; after installing a key it can be switched to the key.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("install a public key");
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Install a public key on this server" });
  await expect(dialog).toContainText("db-primary");
  expect(await calls(page, "key_deploy")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Check the server" }).click();
  await expect(dialog.getByTestId("deploy-preview")).toContainText("The 2 keys already there stay as they are");
  await expect(dialog.getByTestId("deploy-preview")).toContainText("ssh-ed25519 AAAA");
  expect(await calls(page, "key_deploy")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Install key" }).click();
  await expect(dialog).toContainText("Installed in ~/.ssh/authorized_keys");
  await dialog.getByRole("button", { name: "Use this key" }).click();
  await expect(dialog).toContainText("db-primary now signs in with this key");
  const saves = await calls(page, "host_save");
  expect(saves.at(-1)?.args).toMatchObject({ host: { label: "db-primary", auth: { kind: "key" } } });
});

test("the palette offers key installation only for a connected SSH session", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("install a public key");
  await expect(page.getByRole("option", { name: /Install a public key/ })).toHaveCount(0);
});

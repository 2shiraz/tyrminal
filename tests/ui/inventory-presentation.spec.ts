// Inventory presentation and group-wide connection (HST-13, HST-06), against the UI test mock.
// The real rules (all-or-nothing OS changes, deletes that take the OS record along) are tested in
// the core against a real vault: crates/core/tests/inventory.rs.

import { type Page, expect, test } from "@playwright/test";

import { chooseLayout, openApp, sortHosts } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

async function openHosts(page: Page) {
  await primary(page).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

const name = (page: Page, label: string) => page.getByTestId("host-list").getByRole("button", { name: label, exact: true });
const hostCards = (page: Page) => page.getByTestId("host-list").getByRole("article");
const labels = (page: Page) => hostCards(page).evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label")));

test("hosts sort by name, address and group", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await sortHosts(page, "Address");
  expect(await labels(page)).toEqual(["api-gateway", "Home lab", "edge-cache", "build-runner-03", "db-primary", "staging-web"]);
  await sortHosts(page, "Group");
  // Databases sorts after Lab only by path: "Lab" < "Production" < "Production/Databases"; ungrouped last.
  expect(await labels(page)).toEqual(["Home lab", "api-gateway", "db-primary", "build-runner-03", "edge-cache", "staging-web"]);
  await sortHosts(page, "Name");
  expect(await labels(page)).toEqual(["api-gateway", "build-runner-03", "db-primary", "edge-cache", "Home lab", "staging-web"]);
});

test("the chosen layout, sort and group filter stay after other views and a restart", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await chooseLayout(page, "List");
  await sortHosts(page, "Address");
  await page.getByTestId("group-bar").getByRole("button", { name: "Lab", exact: true }).click();
  const check = async () => {
    await expect(page.getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: "List" })).toBeChecked();
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Address" })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("breadcrumb").locator('[aria-current="page"]')).toHaveText("Lab");
    await expect(page.getByTestId("host-list").getByRole("article")).toHaveCount(0);
    await expect(page.getByTestId("host-list").getByRole("listitem")).toHaveCount(1);
  };
  await check();

  await primary(page).getByRole("button", { name: /^Settings/ }).click();
  await openHosts(page);
  await check();

  // Saved like other preferences, so a restart keeps it too.
  await expect.poll(async () => (await calls(page, "prefs_set")).length).toBeGreaterThan(0);
  await page.reload();
  await openHosts(page);
  await check();
});

test("Hosts opens as a list by default; Cards, once chosen, stays after other views and a restart", async ({ page }) => {
  await openApp(page, { hostsLayout: null });
  await openHosts(page);
  const layout = page.getByRole("radiogroup", { name: "Layout" });
  await expect(layout.getByRole("radio", { name: "List" })).toBeChecked();
  await expect(page.getByTestId("host-list").getByRole("article")).toHaveCount(0);

  await chooseLayout(page, "Cards");
  // The default top level: the groups, then the hosts in no group.
  await expect(page.getByTestId("host-list").getByRole("article")).toHaveCount(3);
  await primary(page).getByRole("button", { name: /^Settings/ }).click();
  await openHosts(page);
  await expect(layout.getByRole("radio", { name: "Cards" })).toBeChecked();
  await expect.poll(async () => (await calls(page, "prefs_set")).length).toBeGreaterThan(0);
  await page.reload();
  await openHosts(page);
  await expect(layout.getByRole("radio", { name: "Cards" })).toBeChecked();
  await expect(page.getByTestId("host-list").getByRole("article")).toHaveCount(3);
});

test("select all shown hosts and shift-click a range", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  // No checkboxes: the selection is the row tint and edge, and the strip counts it.
  await expect(page.getByTestId("host-list").getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Select all shown hosts" })).toHaveCount(0);
  await name(page, "api-gateway").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("bulk-bar")).toContainText("6 selected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

  await name(page, "build-runner-03").click();
  await name(page, "Home lab").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("bulk-bar")).toContainText("4 selected");

  // Search narrows what "all shown" means.
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search hosts" }).fill("tag:prod");
  await expect(hostCards(page)).toHaveCount(2);
  await name(page, "api-gateway").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
});

test("set the OS of selected hosts: the tile shows its icon", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await name(page, "edge-cache").click({ modifiers: ["ControlOrMeta"] });
  await name(page, "staging-web").click({ modifiers: ["ControlOrMeta"] });
  await page.getByTestId("bulk-bar").getByRole("button", { name: "More…" }).click();
  await page.getByRole("menuitem", { name: "Set OS icon…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Operating system").selectOption({ label: "Debian" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 hosts changed")).toBeVisible();
  const [set] = await calls(page, "host_set_os");
  expect(set?.args).toMatchObject({ os: "debian" });
  await expect(hostCards(page).filter({ has: page.getByRole("img", { name: "Operating system: Debian" }) })).toHaveCount(2);

  // One host from its menu (outside a selection, so it acts on that host); "Not set" clears it.
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByRole("button", { name: "More actions for edge-cache" }).click();
  await page.getByRole("menuitem", { name: "Set OS" }).click();
  await expect(page.getByRole("dialog").getByLabel("Operating system")).toHaveValue("debian");
  await page.getByRole("dialog").getByLabel("Operating system").selectOption({ label: "Not set" });
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(hostCards(page).filter({ has: page.getByRole("img", { name: "Operating system: Debian" }) })).toHaveCount(1);
});

test("connect to every host of a group after reviewing the list", async ({ page }) => {
  // Production confirmations (P-26) are covered in production.spec.ts; the tag is off here.
  await openApp(page, { productionTag: "" });
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
  // These are the first terminals of the page: creating the first WebGL renderer on the test
  // runner's emulated GPU (SwiftShader) blocks the page for 3-4 s before the next pane can open its
  // session, so allow what the other many-terminal tests allow.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length, { timeout: 15_000 }).toBe(2);
});

test("a group-wide connection that does not fit is refused, not cut short", async ({ page }) => {
  // Production confirmations (P-26) are covered in production.spec.ts; the tag is off here.
  await openApp(page, { productionTag: "" });
  // Twelve sessions open (six hosts, twice), so four more fit.
  for (let round = 0; round < 2; round++) {
    await openHosts(page);
    await name(page, "api-gateway").focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByTestId("bulk-bar").getByRole("button", { name: "Connect" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Open 6 sessions" }).click();
  }
  // As above: the first terminals take a few seconds to start on the test runner's emulated GPU.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length, { timeout: 15_000 }).toBe(12);
  await openHosts(page);
  await name(page, "api-gateway").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Connect" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Only 4 more sessions can be open at once");
  await expect(dialog.getByRole("button", { name: "Open 6 sessions" })).toBeDisabled();
});

async function openImport(page: Page) {
  await openApp(page);
  await openHosts(page);
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "Import…" }).click();
  return page.getByRole("dialog", { name: "Import hosts" });
}

test("a PuTTY export in UTF-16 (as regedit writes it) reaches the core decoded, with its format", async ({ page }) => {
  const dialog = await openImport(page);
  await dialog.getByLabel("Format").selectOption({ label: "PuTTY (.reg export)" });
  await expect(dialog).toContainText("SimonTatham");
  const reg = "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\büro]\r\n\"HostName\"=\"h\"\r\n";
  await dialog.getByLabel("Choose file").setInputFiles({
    name: "putty.reg",
    mimeType: "text/plain",
    buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(reg, "utf16le")]),
  });
  await expect.poll(async () => (await calls(page, "import_preview")).length).toBe(1);
  const [preview] = (await calls(page, "import_preview")) as { args: { format: string; text: string } }[];
  expect(preview?.args.format).toBe("putty_reg");
  expect(preview?.args.text).toBe(reg);
});

test("trusted known hosts without a host entry can be imported after a preview", async ({ page }) => {
  const dialog = await openImport(page);
  await page.evaluate(() => {
    const state = (window as unknown as { __mockState: { knownHosts: { id: string; host: string; port: number; algorithm: string; fingerprint: string; addedAt: number }[] } }).__mockState;
    state.knownHosts.push({ id: "f".repeat(32), host: "orphan.example", port: 2222, algorithm: "ssh-ed25519", fingerprint: "SHA256:synthetic", addedAt: 0 });
  });
  await dialog.getByLabel("Format").selectOption({ label: "Trusted known hosts" });
  await expect(dialog.getByLabel("Choose file")).toHaveCount(0);
  const preview = dialog.getByTestId("import-preview");
  await expect(preview).toContainText("1 host will be added");
  await expect(preview).toContainText("orphan.example:2222");
  await expect(preview).toContainText("SHA256:synthetic");
  expect(await calls(page, "import_hosts")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Import 1 host" }).click();
  await expect(page.getByText("Imported 1 host")).toBeVisible();
  await expect(hostCards(page)).toHaveCount(7);
});

test("keys from a known_hosts file are trusted only after review; conflicts are never imported", async ({ page }) => {
  const dialog = await openImport(page);
  await dialog.getByLabel("Format").selectOption({ label: "OpenSSH known_hosts (trust keys)" });
  const file = [
    "new.example.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsyntheticNewKey",
    "10.20.0.11 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsyntheticOtherKey",
    "|1|aGFzaA==|aGFzaA== ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsyntheticHashed",
  ].join("\n");
  await dialog.getByLabel("Choose file").setInputFiles({ name: "known_hosts", mimeType: "text/plain", buffer: Buffer.from(file) });
  const preview = dialog.getByTestId("trust-preview");
  await expect(preview).toContainText("1 key will be trusted");
  await expect(preview.locator('[data-status="new"]')).toContainText("new.example.net");
  await expect(preview.locator('[data-status="conflict"]')).toContainText("Different key already trusted");
  await expect(dialog.getByTestId("import-skipped")).toContainText("1 line is not imported");
  expect(await calls(page, "known_hosts_import")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Trust 1 key" }).click();
  await expect(page.getByText("Trusted 1 key")).toBeVisible();
  const [run] = (await calls(page, "known_hosts_import")) as { args: { entries: { host: string }[] } }[];
  expect(run?.args.entries.map((e) => e.host)).toEqual(["new.example.net"]);
});

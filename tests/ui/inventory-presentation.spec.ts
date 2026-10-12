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

test("the chosen layout, sort and group filter stay after other views and a restart", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await page.getByRole("radiogroup", { name: "Layout" }).getByText("List").click();
  await page.getByRole("radiogroup", { name: "Sort" }).getByText("Address").click();
  await page.getByRole("button", { name: "Lab", exact: true }).click();
  const check = async () => {
    await expect(page.getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: "List" })).toBeChecked();
    await expect(page.getByRole("radiogroup", { name: "Sort" }).getByRole("radio", { name: "Address" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Lab", exact: true })).toHaveAttribute("aria-pressed", "true");
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
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
});

test("a group-wide connection that does not fit is refused, not cut short", async ({ page }) => {
  // Production confirmations (P-26) are covered in production.spec.ts; the tag is off here.
  await openApp(page, { productionTag: "" });
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

async function openImport(page: Page) {
  await openApp(page);
  await openHosts(page);
  await page.getByRole("button", { name: "Import" }).click();
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

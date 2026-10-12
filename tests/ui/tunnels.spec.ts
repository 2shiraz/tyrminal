// The Tunnels page against the test-only mock backend. Real forwarding, exposure checks and
// cleanup against OpenSSH are tested in crates/ssh/tests/forward_lab.rs and
// crates/core/tests/tunnels_lab.rs; this covers the screens and flows only.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const tunnelsPage = (page: Page) => page.locator('[data-nav="tunnels"]').click();
const rules = (page: Page) => page.getByRole("list", { name: "Saved tunnels" });
const runs = (page: Page) => page.getByRole("list", { name: "Active" });
const editor = (page: Page) => page.getByRole("dialog", { name: /tunnel/i });

async function newRule(page: Page, fields: { name: string; host?: string; kind?: string; listen?: string; port?: string; dest?: string; destPort?: string }) {
  await page.getByRole("button", { name: "New tunnel" }).first().click();
  const d = editor(page);
  await d.getByLabel("Name").fill(fields.name);
  if (fields.host) await d.getByRole("combobox", { name: "Host" }).selectOption({ label: fields.host });
  if (fields.kind) await d.getByRole("radiogroup", { name: "Type" }).getByText(fields.kind, { exact: true }).click();
  if (fields.listen !== undefined) await d.getByLabel("Listen address").fill(fields.listen);
  if (fields.port !== undefined) await d.getByLabel("Listen port").fill(fields.port);
  if (fields.dest !== undefined) await d.getByLabel("Destination host").fill(fields.dest);
  if (fields.destPort !== undefined) await d.getByLabel("Destination port").fill(fields.destPort);
  await d.getByRole("button", { name: "Save" }).click();
}

test("tunnels: save a local rule, start it on a connected session, stop it", async ({ page }) => {
  await openApp(page);
  await tunnelsPage(page);
  await expect(page.getByRole("heading", { level: 1, name: "Tunnels" })).toBeVisible();
  await expect(page.getByText("No tunnels yet")).toBeVisible();

  await newRule(page, { name: "Postgres", host: "api-gateway", dest: "db.internal", destPort: "5432" });
  const rule = rules(page).locator('[data-rule="Postgres"]');
  await expect(rule).toContainText("127.0.0.1:auto → db.internal:5432");
  await expect(rule).toContainText("api-gateway");
  // No session to that host yet: the rule offers to connect instead of starting.
  await expect(rule.getByRole("button", { name: "Start" })).toHaveCount(0);
  await rule.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);

  await tunnelsPage(page);
  await expect(rule).toContainText("1 connected session");
  await rule.getByRole("button", { name: "Start Postgres on api-gateway" }).click();
  await expect(page.getByText(/Postgres is listening on 127\.0\.0\.1:\d+/)).toBeVisible();
  const run = runs(page).locator('[data-run="Postgres"]');
  await expect(run).toHaveAttribute("data-state", "running");
  await expect(run).toContainText("0 open · 0 total");
  // Already running on that session: Start is disabled.
  await expect(rule.getByRole("button", { name: "Start Postgres on api-gateway" })).toBeDisabled();

  await run.getByRole("button", { name: "Stop Postgres" }).click();
  await expect(run).toHaveAttribute("data-state", "stopped");
  await page.getByRole("button", { name: "Clear ended" }).click();
  await expect(runs(page)).toHaveCount(0);
});

test("tunnels: a listener other computers can reach needs a separate confirmation", async ({ page }) => {
  await openApp(page);
  await tunnelsPage(page);
  await newRule(page, { name: "LAN proxy", host: "Home lab", kind: "SOCKS proxy", listen: "0.0.0.0", port: "1080" });
  const confirm = page.getByRole("alertdialog", { name: "Allow connections from other computers?" });
  await expect(confirm).toContainText("0.0.0.0:1080");
  // Cancel keeps the editor open and saves nothing.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(editor(page)).toBeVisible();
  await editor(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("No tunnels yet")).toBeVisible();

  await newRule(page, { name: "LAN proxy", host: "Home lab", kind: "SOCKS proxy", listen: "0.0.0.0", port: "1080" });
  await page.getByRole("button", { name: "Allow and save" }).click();
  const rule = rules(page).locator('[data-rule="LAN proxy"]');
  await expect(rule).toContainText("SOCKS5 on 0.0.0.0:1080");
  await expect(rule).toContainText("Reachable from network");

  // Loopback rules save without any confirmation and carry no warning.
  await newRule(page, { name: "Local only", host: "Home lab", kind: "SOCKS proxy", listen: "localhost" });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(rules(page).locator('[data-rule="Local only"]')).not.toContainText("Reachable from network");
});

test("tunnels: a closed session ends its forwards; start errors are shown", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await tunnelsPage(page);
  await newRule(page, { name: "Web", host: "api-gateway", dest: "localhost", destPort: "80" });
  await newRule(page, { name: "Busy", host: "api-gateway", port: "8080", dest: "localhost", destPort: "80" });

  await rules(page).locator('[data-rule="Busy"]').getByRole("button", { name: /^Start/ }).click();
  await expect(page.getByText(/listen port could not be opened/)).toBeVisible();

  await rules(page).locator('[data-rule="Web"]').getByRole("button", { name: /^Start/ }).click();
  const run = runs(page).locator('[data-run="Web"]');
  await expect(run).toHaveAttribute("data-state", "running");

  // Close the terminal tab; the forward is reported as ended with its session.
  await page.getByRole("button", { name: /Close api-gateway/ }).first().click();
  await tunnelsPage(page);
  await expect(run).toHaveAttribute("data-state", "session_ended");
  await expect(run).toContainText("Session ended");
  await expect(run.getByRole("button", { name: /Stop/ })).toHaveCount(0);

  // Duplicate from the menu; the copy never auto-starts.
  await rules(page).getByRole("button", { name: "Actions for Web" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(rules(page).locator('[data-rule="Web (copy)"]')).toBeVisible();
});

test("hosts: the editor's Advanced section sets a jump host and refuses loops", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-nav="hosts"]').click();
  const edit = async (label: string) => {
    await page.getByRole("button", { name: `More actions for ${label}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
  };
  await edit("db-primary");
  const dialog = page.getByRole("complementary", { name: "Host details" });
  await dialog.getByText("Show more").click();
  await dialog.getByRole("combobox", { name: "Jump host" }).selectOption({ label: "api-gateway" });
  await expect(dialog).toContainText("Connects through api-gateway first");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByTestId("host-panel-status")).toHaveText("Saved");
  expect(await page.evaluate(() => [...(window as unknown as { __mockJumps: Map<string, string> }).__mockJumps.entries()])).toHaveLength(1);

  // Pointing api-gateway back through db-primary would loop: refused, and the host is unchanged.
  await edit("api-gateway");
  const again = page.getByRole("complementary", { name: "Host details" });
  await expect(again.getByLabel("Address")).toHaveValue("10.20.0.11");
  await again.getByText("Show more").click();
  await again.getByRole("combobox", { name: "Jump host" }).selectOption({ label: "db-primary" });
  await again.getByRole("button", { name: "Save", exact: true }).click();
  await expect(again.getByRole("alert")).toContainText("would form a loop");
  await again.getByRole("button", { name: "Cancel" }).click();

  // Reopening shows the saved jump host.
  await edit("db-primary");
  await expect(page.getByRole("complementary", { name: "Host details" }).getByRole("combobox", { name: "Jump host" })).toHaveValue(/.+/);
});

test("hosts: a proxy with a sign-in is saved write-only, and HTTP credentials come with a warning", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-nav="hosts"]').click();
  const edit = async () => {
    await page.getByRole("button", { name: "More actions for staging-web" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    return page.getByRole("complementary", { name: "Host details" });
  };
  let dialog = await edit();
  await dialog.getByText("Show more").click();
  await dialog.getByRole("combobox", { name: "Proxy" }).selectOption("http");
  await dialog.getByLabel("Proxy host").fill("proxy.lab.example");
  await dialog.getByLabel("Proxy port").fill("3128");
  await dialog.getByLabel("Proxy user name").fill("ops");
  await expect(dialog.getByText(/receives the user name and password unencrypted/)).toBeVisible();
  await dialog.getByLabel("Proxy password").fill("canary-ui-proxy-secret");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByTestId("host-panel-status")).toHaveText("Saved");
  await dialog.getByRole("button", { name: "Close host details" }).click();
  await expect(dialog).toHaveCount(0);

  // Reopened: settings shown, the password field empty with a "kept" hint, never prefilled.
  dialog = await edit();
  await expect(dialog.getByRole("combobox", { name: "Proxy" })).toHaveValue("http");
  await expect(dialog.getByLabel("Proxy host")).toHaveValue("proxy.lab.example");
  await expect(dialog.getByLabel("Proxy password")).toHaveValue("");
  await expect(dialog.getByText("Leave empty to keep the stored password.")).toBeVisible();
  expect(await page.content()).not.toContain("canary-ui-proxy-secret");
  // SOCKS5 shows no cleartext warning.
  await dialog.getByRole("combobox", { name: "Proxy" }).selectOption("socks5");
  await expect(dialog.getByText(/unencrypted/)).toHaveCount(0);
});

test("trust prompts name the jump-chain hop they come from", async ({ page }) => {
  await openApp(page, { trustPromptFor: "staging-web", trustPromptHop: { index: 1, total: 2, label: "bastion" } });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("staging-web");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("note")).toHaveText("Jump host 1 of 1: bastion");
});

test("a direct connection's trust prompt shows no hop", async ({ page }) => {
  await openApp(page, { trustPromptFor: "staging-web" });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("staging-web");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByTestId("hop-notice")).toHaveCount(0);
});

test("hosts: post-quantum key exchange can be required or turned off per host", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-nav="hosts"]').click();
  const edit = async (label: string) => {
    await page.getByRole("button", { name: `More actions for ${label}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    return page.getByRole("dialog", { name: /Edit host/ });
  };
  const saved = () =>
    page.evaluate(() => Object.fromEntries((window as unknown as { __mockKeyExchanges: Map<string, string> }).__mockKeyExchanges));

  let dialog = await edit("db-primary");
  await dialog.getByText("Advanced").click();
  const kex = dialog.getByRole("combobox", { name: "Post-quantum key exchange" });
  await expect(kex).toHaveValue("prefer_post_quantum");
  await expect(dialog).toContainText("Servers without it use X25519");
  await kex.selectOption("classic");
  await expect(dialog).toContainText("For servers that fail with post-quantum key exchange");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(Object.values(await saved())).toEqual(["classic"]);

  // A non-default setting keeps the Advanced section open when the editor is reopened.
  dialog = await edit("db-primary");
  await expect(dialog.getByRole("combobox", { name: "Post-quantum key exchange" })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Post-quantum key exchange" }).selectOption("require_post_quantum");
  await expect(dialog).toContainText("Otherwise the connection stops before you sign in");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(Object.values(await saved())).toEqual(["require_post_quantum"]);
});

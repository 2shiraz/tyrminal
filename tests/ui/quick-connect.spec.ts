// Quick connect from the Hosts search against the UI test mock: an address that matches no saved host opens the
// quick-connect sheet (protocol, user, sign-in). "Continue" connects without saving anything;
// "Continue & Save" saves the host and connects through it. The core path is covered by the
// sessions_lab quick_connect tests against the real OpenSSH lab.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const field = (page: Page) => page.getByRole("searchbox", { name: "Search hosts" });
/** Types into the Hosts search and waits for the core's search to answer (no host matches). */
async function search(page: Page, text: string) {
  await field(page).fill(text);
  await expect(page.getByText("No hosts match")).toBeVisible();
}
const sheet = (page: Page, address: string) => page.getByRole("dialog", { name: `Connect to ${address}` });
const stops = (page: Page) =>
  page.locator('dialog [data-testid="connect-track"] .track-stop').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-stage")}:${e.getAttribute("data-state")}`));

test("an address offers quick connect only when no saved host matches", async ({ page }) => {
  await openApp(page);
  const offer = page.getByRole("button", { name: /^Connect to .*…$/ });
  for (const address of ["198.51.100.7", "198.51.100.7:2200", "db.example.org", "ops@db.example.org:2200", "2001:db8::5", "[2001:db8::5]:2200", "backup01"]) {
    await search(page, address);
    await expect(offer, address).toHaveText(`Connect to ${address}…`);
  }
  // A saved host's name finds the host, not a new connection.
  await field(page).fill("api-gateway");
  await expect(page.locator('[data-testid="host-list"]')).toContainText("api-gateway");
  await expect(offer).toHaveCount(0);
  for (const text of ["ssh://db.example.org", "not an address", "db.example.org/path", "300.1.1.1"]) {
    await search(page, text);
    await expect(offer, text).toHaveCount(0);
  }
});

test("Continue connects without saving anything: protocol, user and a typed password", async ({ page }) => {
  await openApp(page);
  await search(page, "198.51.100.7");
  await page.keyboard.press("Enter");
  const dialog = sheet(page, "198.51.100.7");
  await expect(dialog).toBeVisible();
  await expect.poll(() => stops(page)).toEqual(["protocol:waiting", "user:pending", "signIn:pending", "connect:pending"]);

  // Protocol: SSH on 22 by default; the preview follows the port.
  await expect(dialog.getByRole("radio", { name: /SSH/ })).toBeChecked();
  await expect(dialog.getByTestId("quick-preview-ssh")).toHaveText("Will run: ssh 198.51.100.7");
  const sshPort = dialog.getByLabel("SSH port", { exact: true });
  await sshPort.fill("2200");
  await expect(dialog.getByTestId("quick-preview-ssh")).toHaveText("Will run: ssh 198.51.100.7 -p 2200");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();

  // User: required before going on.
  await expect.poll(() => stops(page)).toEqual(["protocol:done", "user:waiting", "signIn:pending", "connect:pending"]);
  const next = dialog.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeDisabled();
  await dialog.getByLabel("User name").fill("ops");
  await next.click();

  // Sign-in: a typed password, used once.
  await expect.poll(() => stops(page)).toEqual(["protocol:done", "user:done", "signIn:waiting", "connect:pending"]);
  await dialog.getByLabel("Password", { exact: true }).fill("s3cret-once");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await calls(page, "session_open_quick")).length).toBe(1);
  const opened = await calls(page, "session_open_quick");
  expect(opened[0]?.args.input).toEqual({ protocol: "ssh", address: "198.51.100.7", port: 2200, username: "ops", auth: { kind: "password", password: "s3cret-once" } });
  expect(await calls(page, "host_save")).toHaveLength(0);
  // The session opens in a pane like any other, through the connection sheet.
  await expect(page.locator(".terminal-pane:not([hidden])")).toBeVisible();
});

test("a key from the keychain is never chosen for you; Continue & Save creates the host, then connects", async ({ page }) => {
  await openApp(page);
  await search(page, "ops@db.example.org");
  await page.keyboard.press("Enter");
  const dialog = sheet(page, "db.example.org");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByLabel("User name")).toHaveValue("ops");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();

  await dialog.getByRole("radio", { name: /A key from the keychain/ }).check();
  const key = dialog.getByRole("combobox", { name: "Choose a key" });
  await expect(key).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await key.selectOption({ label: "Deploy key (ssh-ed25519)" });

  await dialog.getByRole("button", { name: "More ways to continue" }).click();
  await page.getByRole("menuitem", { name: "Continue & Save" }).click();
  await expect(dialog).toHaveCount(0);
  const saves = await calls(page, "host_save");
  expect(saves).toHaveLength(1);
  expect(saves[0]?.args.host).toEqual(expect.objectContaining({ address: "db.example.org", port: 22, username: "ops", auth: { kind: "key", keyId: expect.any(String) }, protocol: { type: "ssh" } }));
  // Saved hosts connect the normal way.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  expect(await calls(page, "session_open_quick")).toHaveLength(0);
});

test("a saved identity fills the user and the sign-in", async ({ page }) => {
  await openApp(page, { identities: [{ id: "a".repeat(31) + "1", label: "Ops team", username: "ops", password: "pw", keyId: null }] });
  await search(page, "10.0.4.12");
  await page.keyboard.press("Enter");
  const dialog = sheet(page, "10.0.4.12");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Search identities" }).fill("ops");
  await dialog.getByRole("option", { name: /Ops team/ }).click();
  await expect(dialog.getByLabel("User name")).toHaveValue("ops");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Identity Ops team" })).toBeChecked();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await calls(page, "session_open_quick")).length).toBe(1);
  const opened = await calls(page, "session_open_quick");
  expect(opened[0]?.args.input).toEqual(expect.objectContaining({ username: "ops", auth: { kind: "identity", identityId: "a".repeat(31) + "1" } }));
});

test("Telnet connects without a user or sign-in step, and warns that nothing is encrypted", async ({ page }) => {
  await openApp(page);
  await search(page, "192.0.2.40");
  await page.keyboard.press("Enter");
  const dialog = sheet(page, "192.0.2.40");
  await dialog.getByRole("radio", { name: /Telnet/ }).check();
  await expect(dialog).toContainText("Not encrypted");
  await expect(dialog.getByTestId("quick-preview-telnet")).toHaveText("Will run: telnet 192.0.2.40");
  await expect.poll(() => stops(page)).toEqual(["protocol:waiting", "connect:pending"]);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await calls(page, "session_open_quick")).length).toBe(1);
  const opened = await calls(page, "session_open_quick");
  expect(opened[0]?.args.input).toEqual(expect.objectContaining({ protocol: "telnet", address: "192.0.2.40", port: 23 }));
  await expect(page.getByText("Telnet is not encrypted").first()).toBeVisible();
});

test("Escape and Close cancel without connecting or saving", async ({ page }) => {
  await openApp(page);
  await search(page, "198.51.100.9");
  await page.keyboard.press("Enter");
  await expect(sheet(page, "198.51.100.9")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page, "198.51.100.9")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect to 198.51.100.9…" }).click();
  await sheet(page, "198.51.100.9").getByRole("button", { name: "Close" }).click();
  await expect(sheet(page, "198.51.100.9")).toHaveCount(0);
  expect(await calls(page, "session_open_quick")).toHaveLength(0);
  expect(await calls(page, "host_save")).toHaveLength(0);
});

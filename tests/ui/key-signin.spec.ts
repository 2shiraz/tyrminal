// Signing in with a Keychain key: no silent key choice for a new host, a refused key is named
// with a way to install it, and installing a key is reachable from the Keychain and the host's
// panel. Against the UI test mock; the sign-in and the install itself are tested against the lab
// in crates/core/tests/inventory_lab.rs and tests/native. The mock never makes a row VERIFIED.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function openHosts(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

// The panel is renamed "Host details" once autosave creates the host.
const fresh = (page: Page) => page.getByTestId("host-panel");
const keySaves = async (page: Page) => (await calls(page, "host_save")).filter((c) => (c.args as { host: { auth: { kind: string } } }).host.auth.kind === "key");

test("a new host never signs in with a key nobody chose", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Add host" }).click();
  const panel = fresh(page);
  // Keys exist, but the default is to ask for the password.
  await expect(panel.getByRole("radio", { name: /Ask for the password each time/ })).toBeChecked();
  await expect(panel.getByRole("radio", { name: /Use a key from the keychain/ })).not.toBeChecked();

  await panel.getByLabel("Address").fill("10.0.0.9");
  await panel.getByLabel("Name", { exact: true }).fill("new-box");
  await panel.getByLabel("User name").fill("ops");
  // Choosing "use a key" asks which one; nothing is picked for the user.
  await panel.getByRole("radio", { name: /Use a key from the keychain/ }).check();
  const picker = panel.getByRole("combobox", { name: "Choose a key" });
  await expect(picker).toHaveValue("");
  await expect(panel.getByText("Choose a key. Until you do, the host keeps its current sign-in.")).toBeVisible();
  // Autosave created the host with the password sign-in; a key sign-in without a key is never sent.
  await panel.getByLabel("Name", { exact: true }).focus();
  await expect(panel).toHaveAttribute("data-autosave", "clean");
  expect(await keySaves(page)).toHaveLength(0);
  expect((await calls(page, "host_save")).at(-1)?.args).toMatchObject({ host: { auth: { kind: "ask_password" } } });

  await picker.selectOption({ label: "Legacy RSA (rsa-sha2-512)" });
  await expect.poll(async () => (await keySaves(page)).length).toBe(1);
  const saved = (await keySaves(page)).at(-1)?.args as { host: { auth: unknown } };
  expect(saved.host.auth).toEqual({ kind: "key", keyId: expect.any(String) });
  const keyId = (saved.host.auth as { keyId: string }).keyId;
  const keys = await page.evaluate(() => (window as unknown as { __mockState: { keys: { id: string; label: string }[] } }).__mockState.keys);
  expect(keys.find((k) => k.id === keyId)?.label).toBe("Legacy RSA");
});

test("a new host saved as is asks for the password", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Add host" }).click();
  const panel = fresh(page);
  await panel.getByLabel("Address").fill("10.0.0.10");
  await panel.getByLabel("Name", { exact: true }).fill("pw-box");
  await panel.getByLabel("User name").fill("ops");
  await panel.getByLabel("Name", { exact: true }).focus();
  await expect(panel).toHaveAttribute("data-autosave", "clean");
  const saved = (await calls(page, "host_save")).at(-1)?.args as { host: { auth: unknown } };
  expect(saved.host.auth).toEqual({ kind: "ask_password" });
});

/** Answers the install connection's password prompt and waits for the deploy preview step. */
async function signInToInstall(page: Page) {
  const prompt = page.getByRole("dialog", { name: /password/i });
  await prompt.getByLabel(/password/i).fill("lab-password");
  await prompt.getByRole("button", { name: /Connect|Sign in|Continue/ }).click();
  await expect(page.getByRole("dialog", { name: "Install a public key on this server" })).toBeVisible();
}

test("a refused key is named, and installing it from the notice lets it sign in", async ({ page }) => {
  await openApp(page, { keyRejectedFor: "build-runner-03", renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await connectHost(page, "build-runner-03");
  await expect(page.getByText('The server did not accept the key "Deploy key". Its public key may not be installed on this server.')).toBeVisible();

  await page.getByRole("button", { name: "Install this key on the server…" }).click();
  const install = page.getByRole("dialog", { name: "Install “Deploy key” on a server" });
  await expect(install).toContainText("sign in to build-runner-03 once with its password");
  // Nothing connects until the user asks.
  expect(await calls(page, "session_open_key_install")).toHaveLength(0);
  await install.getByRole("button", { name: "Sign in with password" }).click();
  expect((await calls(page, "session_open_key_install")).at(-1)?.args.hostId).toBeTruthy();
  await signInToInstall(page);

  const deploy = page.getByRole("dialog", { name: "Install a public key on this server" });
  // The refused key is the one offered.
  const deployKeyId = await page.evaluate(() => (window as unknown as { __mockState: { keys: { id: string; label: string }[] } }).__mockState.keys.find((k) => k.label === "Deploy key")?.id);
  await expect(deploy.getByRole("combobox")).toHaveValue(deployKeyId as string);
  await deploy.getByRole("button", { name: "Check the server" }).click();
  await deploy.getByRole("button", { name: "Install key" }).click();
  await expect(deploy.getByTestId("deploy-preview")).toContainText("Installed in ~/.ssh/authorized_keys.");
  expect(await calls(page, "session_open_key_install")).toHaveLength(1);
  await deploy.getByRole("button", { name: /Close|Done/ }).click();
  // The install connection is closed with the dialog.
  await expect.poll(async () => (await calls(page, "session_close")).length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
});

test("a key can be installed from the Keychain on a chosen server", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Keychain" }).click();
  await page.getByRole("button", { name: "Install Legacy RSA on a server" }).click();
  const install = page.getByRole("dialog", { name: "Install “Legacy RSA” on a server" });
  const sign = install.getByRole("button", { name: "Sign in with password" });
  await expect(sign).toBeDisabled();
  await install.getByRole("combobox", { name: "Server" }).selectOption({ label: "db-primary (postgres@db1.internal.example)" });
  await sign.click();
  await signInToInstall(page);
  const deploy = page.getByRole("dialog", { name: "Install a public key on this server" });
  await expect(deploy.getByRole("combobox")).toHaveValue(
    (await page.evaluate(() => (window as unknown as { __mockState: { keys: { id: string; label: string }[] } }).__mockState.keys.find((k) => k.label === "Legacy RSA")?.id)) as string,
  );
});

test("the host panel offers to install the chosen key on that host", async ({ page }) => {
  await openHosts(page);
  await page.getByTestId("host-list").getByRole("button", { name: "Home lab", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Host details" });
  await panel.getByRole("button", { name: "Install key on server" }).click();
  const install = page.getByRole("dialog", { name: "Install “Deploy key” on a server" });
  // The host is given: no server picker.
  await expect(install.getByRole("combobox", { name: "Server" })).toHaveCount(0);
  await install.getByRole("button", { name: "Sign in with password" }).click();
  const hostId = (await calls(page, "session_open_key_install")).at(-1)?.args.hostId;
  const homeLab = await page.evaluate(() => (window as unknown as { __mockState: { hosts: { id: string; label: string }[] } }).__mockState.hosts.find((h) => h.label === "Home lab")?.id);
  expect(hostId).toBe(homeLab);
});

// Reusable identities (KEY-15..18) against the UI test mock. The rules (references, inheritance,
// refusals, the inserted password never reaching the renderer) are tested in Rust:
// crates/core/tests/identities.rs, crates/core/src/vault.rs (identity_tests) and
// crates/core/src/inventory.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const SECRET = "synthetic-identity-pass";

const calls = (page: Page, cmd?: string) =>
  page.evaluate(
    (c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => !c || x.cmd === c),
    cmd,
  );

async function openKeychain(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Keychain" }).click();
  await expect(page.getByRole("heading", { name: "Identities", exact: true })).toBeVisible();
}

async function createIdentity(page: Page, label: string, username: string, password: string) {
  await openKeychain(page);
  await page.getByRole("button", { name: "New identity" }).click();
  const dialog = page.getByRole("dialog", { name: "New identity" });
  await dialog.getByLabel("Name", { exact: true }).fill(label);
  await dialog.getByLabel("User name", { exact: true }).fill(username);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Key", { exact: true }).selectOption({ label: "Deploy key (ssh-ed25519)" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
}

async function editHost(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: `More actions for ${label}` }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  return page.getByRole("dialog", { name: /Edit host/ });
}

test("create an identity: the password is sent once and never shown again", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Ops admin", "ops", SECRET);
  const list = page.getByRole("list", { name: "Identities" });
  await expect(list).toContainText("Ops admin");
  await expect(list).toContainText("ops · key Deploy key · password stored");
  await expect(list).toContainText("Not used yet");
  const [save] = (await calls(page, "identity_save")) as { args: { identity: Record<string, unknown> } }[];
  expect(save?.args.identity).toMatchObject({ id: null, label: "Ops admin", username: "ops", password: { kind: "set", password: SECRET } });

  // Editing keeps the stored password unless a new one is typed; the field starts empty.
  await page.getByRole("button", { name: "Edit Ops admin" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit identity" });
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(dialog.getByText("A password is stored. Leave this empty to keep it.")).toBeVisible();
  await dialog.getByLabel("User name", { exact: true }).fill("operator");
  await dialog.getByRole("button", { name: "Save" }).click();
  const edits = (await calls(page, "identity_save")) as { args: { identity: Record<string, unknown> } }[];
  expect(edits.at(-1)?.args.identity).toMatchObject({ username: "operator", password: { kind: "keep" } });
  // Nothing the page received carries the password.
  expect(JSON.stringify(await page.evaluate(() => (window as unknown as { __mockState: unknown }).__mockState.identities))).not.toContain(SECRET);
});

test("a host chooses an identity and follows its user name; an identity in use cannot be deleted", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Ops admin", "ops", SECRET);
  const dialog = await editHost(page, "staging-web");
  await dialog.getByLabel("User name", { exact: true }).fill("");
  await dialog.getByRole("radio", { name: /Identity/ }).check();
  await dialog.getByRole("combobox", { name: "Choose an identity" }).selectOption({ label: "Ops admin (ops)" });
  await expect(dialog.getByText("From the identity: ops")).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  const saves = (await calls(page, "host_save")) as { args: { host: Record<string, unknown> } }[];
  expect(saves.at(-1)?.args.host).toMatchObject({ username: "", auth: { kind: "identity" } });
  await expect(page.getByTestId("host-list").getByRole("article").filter({ hasText: "staging-web" })).toContainText("Identity: Ops admin");

  await openKeychain(page);
  await expect(page.getByRole("list", { name: "Identities" })).toContainText("Used by 1 host");
  await page.getByRole("button", { name: "Delete Ops admin" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("1 host and 0 groups use this identity");
  await expect(confirm.getByRole("button", { name: "Delete" })).toBeDisabled();
});

test("a group gives its hosts an identity; key and identity share one choice", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Ops admin", "ops", SECRET);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Actions for group Lab" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const group = page.getByRole("dialog");
  await group.getByLabel("Default sign-in").selectOption({ label: "Ops admin (ops)" });
  await group.getByRole("button", { name: "Save" }).click();
  const [save] = (await calls(page, "group_save")) as { args: { group: Record<string, unknown> } }[];
  expect(save?.args.group).toMatchObject({ keyId: null, identityId: expect.any(String) });

  const dialog = await editHost(page, "Home lab");
  await dialog.getByRole("radio", { name: /Use the group's identity/ }).check();
  await expect(dialog.getByText("Currently: identity Ops admin.")).toBeVisible();
});

test("sudo assistance: nothing is typed until the user confirms, and the page never holds the password", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await createIdentity(page, "Ops admin", "ops", SECRET);
  const dialog = await editHost(page, "staging-web");
  await dialog.getByRole("radio", { name: /Identity/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Connect to staging-web" }).first().click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);

  // The server prints something that looks like a sudo prompt: nothing happens on its own.
  await page.waitForTimeout(300);
  expect(await calls(page, "session_insert_identity_password")).toHaveLength(0);

  // The shortcut opens a confirmation naming the identity and the host; Cancel types nothing.
  await page.keyboard.press("Control+Shift+P");
  const confirm = page.getByRole("dialog", { name: "Type identity password" });
  await expect(confirm).toContainText("Types the password of identity “Ops admin” into staging-web.");
  await expect(confirm).toContainText("Enter is not pressed for you");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "session_insert_identity_password")).toHaveLength(0);

  await page.keyboard.press("Control+Shift+P");
  await page.getByRole("dialog", { name: "Type identity password" }).getByRole("button", { name: "Type password" }).click();
  await expect(page.getByText("Typed the password of “Ops admin”. Press Enter to submit it.")).toBeVisible();
  const inserts = (await calls(page, "session_insert_identity_password")) as { args: Record<string, unknown> }[];
  expect(inserts).toHaveLength(1);
  expect(Object.keys(inserts[0]?.args ?? {}).sort()).toEqual(["identityId", "sessionId"]);
  // The bytes reached the session through the "core"; no request or response on the page held them.
  expect(await page.evaluate(() => (window as unknown as { __mockReceived: string }).__mockReceived)).toContain(SECRET);
  const fromPage = (await calls(page)).filter((c) => c.cmd !== "identity_save");
  expect(JSON.stringify(fromPage)).not.toContain(SECRET);
});

test("sudo assistance in a host without an identity says so and offers nothing to type", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("button", { name: "Connect to db-primary" }).first().click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.keyboard.press("Control+Shift+P");
  const confirm = page.getByRole("dialog", { name: "Type identity password" });
  await expect(confirm).toContainText("This host does not use an identity");
  await expect(confirm.getByRole("button", { name: "Type password" })).toHaveCount(0);
});

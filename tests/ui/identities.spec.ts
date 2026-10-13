// Identities (KEY-15..17) against the UI test mock: created on the Keychain page with a write-only
// password, assigned to a group or a host, shown on the hosts that use them, and removed with a
// count of their users. Precedence, persistence and sign-in are tested in Rust against a real
// vault and the lab (crates/core/tests/inventory.rs, inventory_lab.rs).

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(`^${name}`) }).first().click();

async function createIdentity(page: Page, label: string, username: string, password: string) {
  await nav(page, "Keychain");
  await page.getByRole("button", { name: "New identity" }).click();
  const dialog = page.getByRole("dialog", { name: "New identity" });
  await dialog.getByLabel("Name", { exact: true }).fill(label);
  await dialog.getByLabel("User name", { exact: true }).fill(username);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Key").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Save identity" }).click();
  await expect(dialog).toHaveCount(0);
}

test("an identity is saved with a write-only password and listed without it", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Ops", "ops", "s3cret-identity-pw");
  const list = page.getByRole("list", { name: "Identities" });
  await expect(list).toContainText("Ops");
  await expect(list).toContainText("ops · password · key");
  await expect(list).toContainText("Not used");
  const [save] = await calls(page, "identity_save");
  expect(save?.args).toMatchObject({ identity: { label: "Ops", username: "ops", password: { kind: "set", value: "s3cret-identity-pw" } } });
  // The password is not kept anywhere in the page once saved.
  expect(await page.content()).not.toContain("s3cret-identity-pw");

  // Editing without typing a password keeps it.
  await list.getByRole("button", { name: "Edit Ops" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Ops" });
  await expect(dialog.getByText("A password is saved. Leave empty to keep it.")).toBeVisible();
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await dialog.getByLabel("User name", { exact: true }).fill("operator");
  await dialog.getByRole("button", { name: "Save identity" }).click();
  await expect(list).toContainText("operator · password");
  const saves = await calls(page, "identity_save");
  expect((saves.at(-1)?.args as { identity: { password: unknown } }).identity.password).toEqual({ kind: "keep" });
});

test("a group's identity shows on its hosts; a host's own wins; deleting reports its users", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Ops", "ops", "pw-one");
  await createIdentity(page, "Release", "release", "pw-two");
  await nav(page, "Hosts");

  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "Identity…" }).click();
  const assign = page.getByRole("dialog", { name: "Identity for Production" });
  await assign.getByLabel("Identities").selectOption({ label: "Ops" });
  await assign.getByRole("button", { name: "Save" }).click();
  await expect(assign).toHaveCount(0);
  // api-gateway (Production) and db-primary (Production/Databases) inherit it.
  await expect(page.getByText("Identity: Ops")).toHaveCount(2);

  await page.getByRole("button", { name: "More actions for db-primary" }).first().click();
  await page.getByRole("menuitem", { name: "Identity…" }).click();
  const host = page.getByRole("dialog", { name: "Identity for db-primary" });
  await expect(host.getByTestId("identity-effective")).toHaveText("Signs in as Ops, from group Production");
  await host.getByLabel("Identities").selectOption({ label: "Release" });
  await host.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Identity: Release")).toHaveCount(1);
  await expect(page.getByText("Identity: Ops")).toHaveCount(1);

  await nav(page, "Keychain");
  await page.getByRole("button", { name: "Delete Ops" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Ops?" });
  // In use: a choice is needed (spec §10.2); see identity-deletion.spec.ts.
  await expect(confirm).toContainText("1 host and 1 group use this identity");
  await confirm.getByRole("radio", { name: /Remove it from them/ }).check();
  await confirm.getByRole("button", { name: "Delete identity" }).click();
  await expect(page.getByRole("list", { name: "Identities" })).not.toContainText("Ops");
  await nav(page, "Hosts");
  await expect(page.getByText("Identity: Ops")).toHaveCount(0);
  await expect(page.getByText("Identity: Release")).toHaveCount(1);
});

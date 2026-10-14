// Deleting an identity that is in use (spec §10.2) against the UI test mock: the dialog
// names every user and what each host signs in with afterwards, and deletes only after an
// explicit choice. The rules are tested in Rust: crates/core/tests/identity_deletion.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(`^${name}`) }).first().click();

async function createIdentity(page: Page, label: string) {
  await nav(page, "Keychain");
  await page.getByRole("button", { name: "New identity" }).click();
  const dialog = page.getByRole("dialog", { name: "New identity" });
  await dialog.getByLabel("Name", { exact: true }).fill(label);
  await dialog.getByLabel("User name", { exact: true }).fill(label.toLowerCase());
  await dialog.getByLabel("Password", { exact: true }).fill(`${label}-synthetic`);
  await dialog.getByRole("button", { name: "Save identity" }).click();
  await expect(dialog).toHaveCount(0);
}

async function assign(page: Page, menu: string, dialogName: string, identity: string) {
  await nav(page, "Hosts");
  await page.getByRole("button", { name: menu }).first().click();
  await page.getByRole("menuitem", { name: "Identity…" }).click();
  const dialog = page.getByRole("dialog", { name: dialogName });
  await dialog.getByLabel("Identities").selectOption({ label: identity });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
}

test("a used identity is deleted only after choosing what its users get, which the dialog names", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Ops");
  await createIdentity(page, "Release");
  await assign(page, "Actions for group Lab", "Identity for Lab", "Ops");
  await assign(page, "More actions for edge-cache", "Identity for edge-cache", "Ops");

  await nav(page, "Keychain");
  await page.getByRole("button", { name: "Delete Ops" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Ops?" });
  await expect(dialog).toContainText("2 hosts and 1 group use this identity. Choose what they use instead.");
  const users = dialog.getByRole("list", { name: "Used by" });
  await expect(users).toContainText("edge-cache");
  await expect(users).toContainText("Home lab (from a group)");
  await expect(users).toContainText("Lab (group)");
  // Nothing is chosen yet, so nothing can be deleted; Cancel has focus.
  await expect(dialog.getByRole("button", { name: "Delete identity" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  // Removing names each host's fallback, including a stored password, before anything happens.
  await dialog.getByRole("radio", { name: /Remove it from them/ }).check();
  await expect(users).toContainText("edge-cache — then: its own stored password");
  await expect(users).toContainText("Home lab (from a group) — then: key Deploy key");
  expect(await calls(page, "identity_delete")).toHaveLength(0);

  // Reassigning instead: every user moves to Release.
  await dialog.getByRole("radio", { name: /Use another identity instead/ }).check();
  await expect(dialog.getByLabel("Identity to use instead")).toHaveValue(/./);
  await dialog.getByRole("button", { name: "Delete identity" }).click();
  await expect(dialog).toHaveCount(0);
  const [call] = (await calls(page, "identity_delete")) as { args: Record<string, unknown> }[];
  expect(call?.args).toMatchObject({ references: { kind: "reassign" } });
  await nav(page, "Hosts");
  await expect(page.getByText("Identity: Release")).toHaveCount(2);
});

test("an unused identity is deleted after a plain confirmation", async ({ page }) => {
  await openApp(page);
  await createIdentity(page, "Spare");
  await page.getByRole("button", { name: "Delete Spare" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Spare?" });
  await expect(dialog).toContainText("Nothing uses this identity.");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Delete identity" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Identities" })).toHaveCount(0);
  const [call] = (await calls(page, "identity_delete")) as { args: Record<string, unknown> }[];
  expect(call?.args).toMatchObject({ references: null });
});

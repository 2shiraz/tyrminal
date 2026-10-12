// Keychain additions (KEY-02, KEY-14, KEY-07) against the UI test mock. Key parsing, PuTTY limits,
// generation and certificate checks are tested in Rust: crates/ssh/src/auth.rs and
// crates/core/tests/inventory.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function openKeychain(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Keychain" }).click();
  await expect(page.getByRole("heading", { name: "Keychain", level: 1 })).toBeVisible();
}

test("generate an ECDSA key: the chosen type reaches the core", async ({ page }) => {
  await openKeychain(page);
  await page.getByRole("button", { name: "Generate key" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("ops p384");
  await dialog.getByLabel("Key type").selectOption({ label: "ECDSA P-384" });
  await dialog.getByRole("button", { name: "Generate key" }).click();
  await expect(page.getByText("ecdsa-sha2-nistp384 ·")).toBeVisible();
  const [call] = await calls(page, "key_generate");
  expect(call?.args).toMatchObject({ label: "ops p384", kind: "ecdsa_p384" });
});

test("import a key file through the native dialog: only its name reaches the page", async ({ page }) => {
  await openKeychain(page);
  await page.getByRole("button", { name: "Import key" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Choose key file…" }).click();
  await expect(dialog.getByTestId("picked-key")).toContainText("work.ppk");
  await expect(dialog.getByTestId("picked-key")).toContainText("Passphrase protected");
  await expect(dialog.getByLabel("Name")).toHaveValue("work");
  // The page never gets a text field holding the key, and never sends key text itself.
  await expect(dialog.getByLabel("Private key")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Import key" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Enter its passphrase");
  await dialog.getByLabel("Key passphrase").fill("synthetic passphrase");
  await dialog.getByRole("button", { name: "Import key" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("work", { exact: true })).toBeVisible();
  const imports = (await calls(page, "key_import_picked")) as { args: Record<string, unknown> }[];
  expect(imports.at(-1)?.args).toEqual({ label: "work", passphrase: "synthetic passphrase", rememberPassphrase: false });
  expect(await calls(page, "key_import")).toHaveLength(0);
});

test("closing the import dialog forgets a picked key file", async ({ page }) => {
  await openKeychain(page);
  await page.getByRole("button", { name: "Import key" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Choose key file…" }).click();
  await expect(dialog.getByTestId("picked-key")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "key_import_pick_clear")).toHaveLength(1);
});

test("attach a user certificate to a key, see its principals, then remove it", async ({ page }) => {
  await openKeychain(page);
  const row = page.getByRole("listitem").filter({ hasText: "Deploy key" });
  await row.getByRole("button", { name: "Add certificate" }).click();
  const dialog = page.getByRole("dialog", { name: "Certificate for “Deploy key”" });
  await dialog.getByLabel("Certificate", { exact: true }).fill("ssh-ed25519 AAAAnotacert");
  await dialog.getByRole("button", { name: "Add certificate" }).click();
  await expect(dialog.getByRole("alert")).toContainText("not a valid OpenSSH certificate");
  await dialog.getByLabel("Choose certificate file").setInputFiles({
    name: "id_ed25519-cert.pub",
    mimeType: "text/plain",
    buffer: Buffer.from("ssh-ed25519-cert-v01@openssh.com AAAAsynthetic user@laptop\n"),
  });
  await dialog.getByRole("button", { name: "Add certificate" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByTestId("key-certificate")).toContainText("Certificate: tyr");

  await row.getByRole("button", { name: "Certificate", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove certificate" }).click();
  await expect(row.getByTestId("key-certificate")).toHaveCount(0);
  expect(await calls(page, "key_certificate_remove")).toHaveLength(1);
});

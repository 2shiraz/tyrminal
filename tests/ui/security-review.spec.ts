// Security review (P-27) against the UI test mock. The rules themselves are tested in Rust over a
// synthetic vault (crates/core/src/security_review.rs, crates/core/tests/security_review.rs); here
// the findings are listed by severity, nothing changes until a fix dialog is completed, and each
// fix opens the existing flow.

import { type Locator, type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.map((x) => x.cmd));

async function openReview(page: Page): Promise<Locator> {
  await openSettings(page, "Security review");
  const section = page.getByTestId("security-review");
  await expect(section.getByRole("list", { name: "Security review" })).toBeVisible();
  return section;
}

const finding = (section: Locator, title: string | RegExp) => section.getByRole("listitem").filter({ hasText: title });

test("findings are listed most serious first and reviewing changes nothing", async ({ page }) => {
  await openApp(page, { reviewFixtures: true });
  const before = (await calls(page)).length;
  const section = await openReview(page);

  await expect(section.getByRole("status")).toContainText("9 things to look at");
  await expect(section).toContainText("Reviewed 4 keys, 6 SSH hosts, 0 certificates and 3 trusted host keys.");
  const kinds = await section.locator("li[data-kind]").evaluateAll((items) => items.map((i) => i.getAttribute("data-kind")));
  expect(kinds).toEqual([
    "dsa_key",
    "short_rsa_key",
    "password_sign_in",
    "password_sign_in",
    "password_sign_in",
    "key_without_passphrase",
    "key_without_passphrase",
    "unused_known_host",
    "ssh_rsa_only_known_host",
  ]);
  const severities = await section.locator("li[data-severity]").evaluateAll((items) => items.map((i) => i.getAttribute("data-severity")));
  expect(severities).toEqual(["high", "medium", "medium", "medium", "medium", "low", "low", "low", "low"]);
  await expect(finding(section, 'DSA key "Old DSA"')).toContainText("High");
  await expect(finding(section, '2048-bit RSA key "Laptop RSA"')).toContainText("Medium");
  await expect(finding(section, '"edge-cache" signs in with a password')).toContainText("The password is stored in the vault.");
  await expect(finding(section, '"db-primary" signs in with a password')).toContainText("asked for on each connection");
  await expect(finding(section, 'Key "Legacy RSA" has no passphrase of its own')).toContainText("Its passphrase is stored with it");
  await expect(finding(section, "retired.example is trusted only by an RSA host key")).toContainText("never SHA-1");
  // Each explanation says how to fix the finding, so none is cut off (no clipped or ellipsized text).
  const clipped = await section
    .locator("li[data-kind] .row-sub")
    .evaluateAll((items) => items.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(clipped).toEqual([]);

  // Only the review was asked for: no write, no network-shaped command.
  const after = (await calls(page)).slice(before);
  expect(after).toContain("security_review");
  for (const cmd of after) expect(cmd).not.toMatch(/_save|_remove|_delete|_set|password_check_run/);
});

test("removing a stale trusted key goes through the existing confirmation", async ({ page }) => {
  await openApp(page, { reviewFixtures: true });
  const section = await openReview(page);
  const stale = finding(section, "Trusted key for retired.example is not used by any host");
  await stale.getByRole("button", { name: "Remove…" }).click();

  // Cancelling keeps it.
  let dialog = page.getByRole("alertdialog", {
    name: "Remove trust for retired.example port 22?",
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await calls(page)).not.toContain("known_host_remove");
  await expect(stale).toBeVisible();

  // Confirmed, it is removed (noted as from the review), the review runs again and both findings
  // for it are gone.
  await stale.getByRole("button", { name: "Remove…" }).click();
  dialog = page.getByRole("alertdialog", {
    name: "Remove trust for retired.example port 22?",
  });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByText("retired.example")).toHaveCount(0);
  await expect(section.getByRole("status")).toContainText("7 things to look at");
});

test("a password host opens the host editor; choosing a key clears the finding", async ({ page }) => {
  await openApp(page);
  const section = await openReview(page);
  const host = finding(section, '"edge-cache" signs in with a password');
  await host.getByRole("button", { name: "Edit host" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit host" });
  await expect(dialog.getByLabel("Address")).toHaveValue("203.0.113.24");
  await dialog.getByText("Use a key from the keychain").click();
  await dialog.getByLabel("Choose a key", { exact: true }).selectOption({ label: "Deploy key (ssh-ed25519)" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(finding(section, '"edge-cache" signs in with a password')).toHaveCount(0);
  await expect(finding(section, '"db-primary" signs in with a password')).toBeVisible();
});

test("a weak key offers to generate a replacement and to open the keychain", async ({ page }) => {
  await openApp(page, { reviewFixtures: true });
  const section = await openReview(page);
  const dsa = finding(section, 'DSA key "Old DSA"');
  await dsa.getByRole("button", { name: "Generate a key" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate a new key" });
  await dialog.getByLabel("Name").fill("Replacement");
  await dialog.getByRole("button", { name: "Generate key" }).click();
  await expect(dialog).toBeHidden();
  // The new key is reviewed too (an Ed25519 key kept only by the vault's encryption).
  await expect(finding(section, 'Key "Replacement" has no passphrase of its own')).toBeVisible();
  await expect(section).toContainText("Reviewed 5 keys");
  // Nothing was replaced automatically: the old key is still there.
  await expect(dsa).toBeVisible();

  await dsa.getByRole("button", { name: "Open keychain" }).click();
  await expect(page.getByRole("heading", { name: "Keychain", level: 1 })).toBeVisible();
});

test("the command palette opens the review", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Search or run a command" }).click();
  await page.getByRole("combobox", { name: /Type a command/ }).fill("security review");
  await page.getByRole("option", { name: /Security review/ }).click();
  await expect(page.locator("#settings-review").getByRole("heading", { name: "Security review" })).toBeInViewport();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Security review" })).toHaveAttribute("aria-current", "page");
});

// Privilege-prompt assistance (KEY-18) against the UI test mock. The rules (identity checked at
// insert time, control characters refused, nothing after a lock, a real no-echo prompt) are
// tested in Rust: crates/core/src/vault.rs (privilege_tests) and crates/core/tests/privilege_lab.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const SECRET = "synthetic-identity-pass";

const calls = (page: Page, cmd?: string) =>
  page.evaluate(
    (c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => !c || x.cmd === c),
    cmd,
  );

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(`^${name}`) }).first().click();

async function identityForHost(page: Page, host: string) {
  await nav(page, "Keychain");
  await page.getByRole("button", { name: "New identity" }).click();
  const dialog = page.getByRole("dialog", { name: "New identity" });
  await dialog.getByLabel("Name", { exact: true }).fill("Ops admin");
  await dialog.getByLabel("User name", { exact: true }).fill("ops");
  await dialog.getByLabel("Password", { exact: true }).fill(SECRET);
  await dialog.getByRole("button", { name: "Save identity" }).click();
  await expect(dialog).toHaveCount(0);
  await nav(page, "Hosts");
  await page.getByRole("button", { name: `More actions for ${host}` }).first().click();
  await page.getByRole("menuitem", { name: "Identity…" }).click();
  const assign = page.getByRole("dialog", { name: `Identity for ${host}` });
  await assign.getByLabel("Identities").selectOption({ label: "Ops admin" });
  await assign.getByRole("button", { name: "Save" }).click();
  await expect(assign).toHaveCount(0);
}

test("nothing is typed until the user confirms, and the page never holds the password", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await identityForHost(page, "staging-web");
  await page.getByRole("button", { name: "Connect to staging-web" }).first().click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);

  // Whatever the server prints, nothing is typed on its own.
  await page.waitForTimeout(300);
  expect(await calls(page, "session_insert_identity_password")).toHaveLength(0);

  // The shortcut opens a confirmation naming the identity and the host; Cancel has focus.
  await page.keyboard.press("Control+Shift+P");
  const confirm = page.getByRole("dialog", { name: "Type identity password" });
  await expect(confirm).toContainText("Types the password of identity “Ops admin” into staging-web.");
  await expect(confirm).toContainText("Enter is not pressed for you");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveCount(0);
  expect(await calls(page, "session_insert_identity_password")).toHaveLength(0);

  await page.keyboard.press("Control+Shift+P");
  await page.getByRole("dialog", { name: "Type identity password" }).getByRole("button", { name: "Type password" }).click();
  await expect(page.getByText("Typed the password of “Ops admin”. Press Enter to submit it.")).toBeVisible();
  const inserts = (await calls(page, "session_insert_identity_password")) as { args: Record<string, unknown> }[];
  expect(inserts).toHaveLength(1);
  expect(Object.keys(inserts[0]?.args ?? {}).sort()).toEqual(["identityId", "sessionId"]);
  // The bytes reached the session through the "core"; no request on the page held them except
  // the one that saved the identity.
  expect(await page.evaluate(() => (window as unknown as { __mockReceived: string }).__mockReceived)).toContain(SECRET);
  const fromPage = (await calls(page)).filter((c) => c.cmd !== "identity_save");
  expect(JSON.stringify(fromPage)).not.toContain(SECRET);
});

test("the palette offers it in an SSH session; a host without an identity has nothing to type", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("button", { name: "Connect to db-primary" }).first().click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("identity password");
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "Type identity password" });
  await expect(confirm).toContainText("This host does not use an identity");
  await expect(confirm.getByRole("button", { name: "Type password" })).toHaveCount(0);
});

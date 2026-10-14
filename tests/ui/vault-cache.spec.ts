// Fewer round trips: hosts, keys, groups and
// identities load once per unlock and views read that cache instead of listing again on every
// view switch. Mock backend; UI evidence only.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const count = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.filter((x) => x.cmd === c).length, cmd);
const nav = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name });

test("cache: switching views does not list hosts, keys, groups or identities again", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => count(page, "identity_list")).toBe(1);
  const before = { hosts: await count(page, "host_list"), keys: await count(page, "key_list"), groups: await count(page, "group_list") };
  expect(before).toEqual({ hosts: 1, keys: 1, groups: 1 });

  for (const view of [/^Hosts/, /^Known hosts/, /^Keychain/, /^Settings/, /^Hosts/, /^Known hosts/]) {
    await nav(page, view).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  // The known hosts page still offers "Create host" from the cached hosts.
  await expect(page.getByRole("heading", { name: "Known hosts", level: 1 })).toBeVisible();
  expect(await count(page, "host_list")).toBe(1);
  expect(await count(page, "key_list")).toBe(1);
  expect(await count(page, "group_list")).toBe(1);
  expect(await count(page, "identity_list")).toBe(1);
});

test("cache: an identity change made in the app refreshes the shared list once", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => count(page, "identity_list")).toBe(1);
  await nav(page, /^Keychain/).click();
  await page.getByRole("button", { name: "New identity" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("ops-team");
  await dialog.getByLabel("User name").fill("ops");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("ops-team")).toBeVisible();
  expect(await count(page, "identity_list")).toBe(2);
  // The Hosts view shows it without listing again.
  await nav(page, /^Hosts/).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
  expect(await count(page, "identity_list")).toBe(2);
});

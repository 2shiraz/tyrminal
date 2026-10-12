// Favourite hosts against the UI test mock (the vault side is in crates/core/tests/vault_service.rs):
// a host is starred and unstarred from its "…" menu and from Host details; nothing else changes.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const favouriteCalls = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: { id: string; favourite: boolean } }[] }).__mockCalls
      .filter((c) => c.cmd === "host_favourite_set")
      .map((c) => c.args.favourite),
  );

test("favourites: a host is starred from its menu and unstarred from Host details", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-nav="hosts"]').click();
  await page.getByRole("button", { name: "More actions for db-primary" }).click();
  await page.getByRole("menuitem", { name: "Add to favourites" }).click();
  await expect.poll(() => favouriteCalls(page)).toEqual([true]);

  // The menu now offers the opposite.
  await page.getByRole("button", { name: "More actions for db-primary" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from favourites" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const panel = page.getByRole("complementary", { name: "Host details" });
  await panel.getByRole("button", { name: "Host details actions" }).click();
  await page.getByRole("menuitem", { name: "Remove from favourites" }).click();
  await expect.poll(() => favouriteCalls(page)).toEqual([true, false]);
  await panel.getByRole("button", { name: "Host details actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Add to favourites" })).toBeVisible();
});

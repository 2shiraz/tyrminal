// The vault's idle lock time is a setting (specification: five minutes by default, configurable).
// The core enforces it and refuses values outside the list (crates/core preferences tests); this
// checks the control. Production frontend, mock backend.
import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const pref = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as { __mockState: { prefs: Record<string, unknown> } }).__mockState.prefs[k], key);

test("the vault's lock time is chosen in Settings from a fixed list; five minutes by default", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "Vault and unlock");
  const lockAfter = page.getByRole("combobox", { name: "Lock after" });
  await expect(lockAfter).toHaveValue("5");
  expect(await lockAfter.locator("option").allTextContents()).toEqual(["1 minute", "5 minutes", "15 minutes", "30 minutes", "1 hour", "4 hours", "8 hours"]);
  await lockAfter.selectOption({ label: "1 hour" });
  await expect.poll(() => pref(page, "autoLockMinutes")).toBe(60);
  // The section no longer promises a fixed five minutes.
  await expect(page.locator(".settings-section-strip")).not.toContainText("5 minutes");
});

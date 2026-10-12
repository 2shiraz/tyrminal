import { expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const inset = (locator: import("@playwright/test").Locator) => locator.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));

// TextField and SecretField share the icon wrapper for their trailing button; only a field with a
// leading icon gets the extra left inset (owner report: every input showed a wide gap before the text).
test("plain and secret fields keep the normal inset", async ({ page }) => {
  await openApp(page, { scenario: "locked" });
  const passphrase = page.locator("input[type=password]").first();
  await expect(passphrase).toBeVisible();
  expect(await inset(passphrase)).toBe(12);
});

test("a search field leaves room for its icon", async ({ page }) => {
  await openApp(page);
  // Hosts has its own search bar (the icon sits beside the field); the snippet library uses the shared one.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Snippets/ }).click();
  const search = page.locator(".input-with-icon > svg + input").first();
  await expect(search).toBeVisible();
  expect(await inset(search)).toBe(34);
});

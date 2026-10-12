import { expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

/** Dispatches a right-click and reports whether the browser's own menu would still open. */
const nativeMenuAllowed = (page: import("@playwright/test").Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    return el.dispatchEvent(event);
  }, selector);

test("the WebView's own context menu never opens on app chrome; text fields keep theirs", async ({ page }) => {
  await openApp(page);
  // Empty chrome: blocked.
  expect(await nativeMenuAllowed(page, ".statusbar")).toBe(false);
  expect(await nativeMenuAllowed(page, "nav")).toBe(false);
  // A text field keeps the system Cut/Copy/Paste menu.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  expect(await nativeMenuAllowed(page, "input.input")).toBe(true);
});

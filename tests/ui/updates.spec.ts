// Signed in-app updates (UX-05, ADR 0013), the parts the renderer owns: a build without the
// updater offers only the releases page and never checks; with it, Check now shows the release
// found, notes as plain text, and installs only on the user's press; automatic checks are opt-in
// and what they find is pointed to from the status strip. Signature and downgrade checks are
// native (tauri-plugin-updater with requireSignedVersion) and not exercised by this mock.
import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

type Call = { cmd: string };
const calls = async (page: Page, cmd: string) =>
  (await page.evaluate(() => (window as unknown as { __mockCalls: Call[] }).__mockCalls)).filter((c) => c.cmd === cmd).length;
const pref = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as { __mockState: { prefs: Record<string, unknown> } }).__mockState.prefs[k], key);
const updates = (page: Page) => page.getByRole("region", { name: "Updates" });

test("a build without the updater offers the releases page and never checks", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "Privacy");
  await expect(updates(page)).toContainText("This build cannot update itself");
  await expect(updates(page).getByRole("button", { name: "Open the releases page" })).toBeVisible();
  await expect(updates(page).getByRole("button", { name: "Check now" })).toHaveCount(0);
  await expect(updates(page).getByRole("switch")).toHaveCount(0);
  expect(await calls(page, "update_check")).toBe(0);
});

test("Check now says when this is the latest version; automatic checks are off until turned on", async ({ page }) => {
  await openApp(page, { updater: { offer: null } });
  await openSettings(page, "Privacy");
  // Opening Settings checks nothing by itself.
  await expect(updates(page).getByRole("button", { name: "Check now" })).toBeVisible();
  expect(await calls(page, "update_check")).toBe(0);
  const auto = updates(page).getByRole("switch", { name: "Check for updates automatically" });
  await expect(auto).not.toBeChecked();
  await updates(page).getByRole("button", { name: "Check now" }).click();
  await expect(updates(page)).toContainText("You have the latest version.");
  expect(await calls(page, "update_check")).toBe(1);
  await auto.click();
  await expect.poll(() => pref(page, "checkUpdates")).toBe(true);
});

test("a release found is shown with plain-text notes and installs only when asked", async ({ page }) => {
  const notes = "Fixes\n<img src=x onerror=window.__pwned=1> **bold**";
  await openApp(page, { updater: { offer: { version: "0.3.0", date: "2026-10-20 00:00:00 +00:00:00", notes } } });
  await openSettings(page, "Privacy");
  await updates(page).getByRole("button", { name: "Check now" }).click();
  await expect(updates(page)).toContainText("Tyrminal 0.3.0 is available.");
  const offer = page.getByTestId("update-offer");
  await offer.getByText("What's new").click();
  // The notes are text, never markup.
  await expect(offer.locator(".update-notes")).toHaveText(notes.replace("\\n", "\n"));
  await expect(offer.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(offer).toContainText("Installing locks the vault and ends open sessions.");
  expect(await calls(page, "update_install")).toBe(0);
  await offer.getByRole("button", { name: "Install 0.3.0 and restart" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockUpdateInstalled?: string }).__mockUpdateInstalled)).toBe("0.3.0");
  expect(await calls(page, "update_install")).toBe(1);
});

test("an automatic check's release is pointed to from the status strip and opens Settings", async ({ page }) => {
  await openApp(page, { updater: { offer: { version: "0.3.0", date: null, notes: null } } });
  const strip = page.locator(".statusbar");
  await expect(strip.getByRole("button", { name: /^Update/ })).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __mockEmit: (event: string, payload: unknown) => void }).__mockEmit("update-available", { version: "0.3.0", date: null, notes: null }),
  );
  await strip.getByRole("button", { name: "Update 0.3.0" }).click();
  await expect(page.getByRole("heading", { name: "Privacy" })).toBeVisible();
  await expect(page.getByTestId("update-offer").getByRole("button", { name: "Install 0.3.0 and restart" })).toBeVisible();
  // Nothing was installed by the announcement.
  expect(await calls(page, "update_install")).toBe(0);
});

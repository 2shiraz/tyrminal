// Settings owned by agent A (local shell). Native enforcement: the core accepts only installed
// shells (crates/core/src/preferences.rs) and falls back to the login shell when one disappears.
import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const prefsSets = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: { prefs: { localShell: string | null } } }[] }).__mockCalls
      .filter((c) => c.cmd === "prefs_set")
      .map((c) => c.args.prefs.localShell),
  );

test("settings: the local terminal shell is chosen from the installed shells", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "Terminal");
  const shell = page.getByRole("combobox", { name: "Local terminal shell" });
  await expect(shell).toHaveValue("");
  await expect(shell.locator("option")).toHaveText(["Login shell (default)", "/bin/bash", "/bin/zsh", "/usr/bin/fish"]);
  await shell.selectOption("/bin/zsh");
  await expect.poll(() => prefsSets(page)).toContain("/bin/zsh");
  await shell.selectOption("");
  await expect.poll(async () => (await prefsSets(page)).at(-1)).toBeNull();
});

test("settings: editors for remote files are added with the app picker and can be removed", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "Terminal");
  await expect(page.getByText("No editors chosen.")).toBeVisible();
  const ext = page.getByRole("textbox", { name: "File extension" });
  const add = page.getByRole("button", { name: "Choose app…" });
  await ext.fill("a.b");
  await expect(add).toBeDisabled();
  await ext.fill(".YML");
  await add.click();
  const list = page.getByRole("list", { name: "Editors for remote files" });
  await expect(list).toContainText(".yml");
  await expect(list).toContainText("Text Editor.app");
  await expect(ext).toHaveValue("");
  await list.getByRole("button", { name: "Remove the editor for .yml files" }).click();
  await expect(page.getByText("No editors chosen.")).toBeVisible();
});

test("settings: diagnostics are off by default, keep only command and code, and are saved only on request", async ({ page }) => {
  await openApp(page);
  const settings = () => openSettings(page, "Privacy");
  await settings();
  const toggle = page.getByRole("switch", { name: "Keep a list of recent failures for diagnostics" });
  await expect(toggle).not.toBeChecked();
  // Regression: the hint pointed to "separate settings" for session recording and command
  // history, which do not exist.
  await expect(page.getByText(/Session recording and command history/)).toHaveCount(0);
  await toggle.check();
  await expect(page.getByText("0 failures kept")).toBeVisible();

  // A failed unlock is kept as which action failed and its code, never what was typed.
  await page.keyboard.press("Control+Shift+L");
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByLabel("Passphrase").fill("not the passphrase");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("did not unlock");
  await page.getByLabel("Passphrase").fill("correct horse");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await settings();
  await expect(page.getByText("1 failure kept")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "Save diagnostic report…" }).click();
  await expect(page.getByText("Saved tyrminal-diagnostics-2026-10-12.txt.")).toBeVisible();
  const reports = await page.evaluate(() => (window as unknown as { __mockReports: unknown[] }).__mockReports);
  expect(reports).toEqual([[{ command: "vault_unlock", code: "WRONG_CREDENTIAL", at: expect.any(Number) }]]);
  expect(JSON.stringify(reports)).not.toContain("not the passphrase");

  // Turning it off forgets what was kept; updates are only ever started by the user.
  await toggle.uncheck();
  await toggle.check();
  await expect(page.getByText("0 failures kept")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/never checks for or installs updates by itself/)).toBeVisible();
  await page.getByRole("button", { name: "Open the releases page" }).click();
  const opened = await page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: { url?: string } }[] }).__mockCalls.filter((c) => c.cmd === "link_open").map((c) => c.args.url),
  );
  expect(opened).toEqual(["https://github.com/2shiraz/tyrminal/releases"]);
});

test("known hosts: a trusted server without a saved host can become one, prefilled", async ({ page }) => {
  await openApp(page, { orphanKnownHost: true });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Known hosts" }).click();
  // Servers that already have a host offer no button.
  await expect(page.getByRole("button", { name: /^Create a host for/ })).toHaveCount(1);
  await page.getByRole("button", { name: "Create a host for 198.51.100.7 port 2200" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Address")).toHaveValue("198.51.100.7");
  await dialog.getByLabel("User name").fill("admin");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const saves = await page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((c) => c.cmd === "host_save"),
  );
  expect(saves.at(-1)?.args).toMatchObject({ host: { address: "198.51.100.7", port: 2200, username: "admin" } });
  // Now that a host points at it, the button is gone.
  await expect(page.getByRole("button", { name: /^Create a host for/ })).toHaveCount(0);
});

test("settings: one section at a time; the nav marks it and Up and Down move between sections", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("section.settings-section")).toHaveCount(1);
  await expect(page.locator("#settings-appearance")).toBeVisible();

  await nav.getByRole("button", { name: "Highlighting" }).click();
  await expect(nav.getByRole("button", { name: "Highlighting" })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
  await expect(page.locator("#settings-highlight").getByRole("heading", { level: 2, name: "Highlighting" })).toBeVisible();
  await expect(page.locator("#settings-appearance")).toHaveCount(0);

  // One tab stop in the nav; arrows move focus, Enter opens.
  await expect(nav.locator('button[tabindex="0"]')).toHaveText("Highlighting");
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("button", { name: "Vault and unlock" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(nav.getByRole("button", { name: "About" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#settings-about")).toBeVisible();
});

test("settings: search lists matching settings; Enter opens the section and focuses the setting; Esc clears", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const search = page.getByRole("searchbox", { name: "Search settings" });
  await search.fill("font size");
  const results = page.locator(".settings-results");
  await expect(results.getByRole("button")).toHaveText(["Terminal / Text / Font size"]);
  // The nav keeps only sections with a match.
  await expect(page.getByRole("navigation", { name: "Settings" }).locator(".settings-nav-item")).toHaveText(["Terminal"]);
  await search.press("Enter");
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("slider", { name: "Font size" })).toBeFocused();
  await expect(search).toHaveValue("");

  await search.fill("zzz nothing");
  await expect(page.getByText("No setting matches “zzz nothing”.")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.locator("#settings-terminal")).toBeVisible();

  // A result can be clicked too; a switch row focuses its switch.
  await search.fill("copy on select");
  await results.getByRole("button").first().click();
  await expect(page.getByRole("switch", { name: /Copy on select/ })).toBeFocused();
});

test("settings: Backup says when the vault was last exported, and an export updates it", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "Backup");
  const last = page.getByTestId("last-export");
  await expect(last).toHaveText("Never exported");
  await page.getByRole("button", { name: "Save a backup…" }).click();
  await expect(last).toHaveText("Last exported just now");
});

test("known hosts: a counted box, and every trust date in one relative format with the exact date on hover", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Known hosts/ }).click();
  const box = page.getByRole("region", { name: "Trusted servers" });
  await expect(box).toBeVisible();
  const rows = box.locator("ul.list > li");
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);
  await expect(box.locator(".box-count")).toHaveText(String(count));
  const dates = box.locator("time");
  await expect(dates).toHaveCount(count);
  for (const date of await dates.all()) {
    await expect(date).toHaveText(/^Trusted (just now|yesterday|(an?|\d+) (min|h|days?|months?|years?) ago)$/);
    await expect(date).toHaveAttribute("title", /\d/);
  }
});

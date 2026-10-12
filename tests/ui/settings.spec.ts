// Settings owned by agent A (local shell). Native enforcement: the core accepts only installed
// shells (crates/core/src/preferences.rs) and falls back to the login shell when one disappears.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const prefsSets = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: { prefs: { localShell: string | null } } }[] }).__mockCalls
      .filter((c) => c.cmd === "prefs_set")
      .map((c) => c.args.prefs.localShell),
  );

test("settings: the local terminal shell is chosen from the installed shells", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
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
  const settings = () => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  await settings();
  const toggle = page.getByRole("switch", { name: "Keep a list of recent failures for diagnostics" });
  await expect(toggle).not.toBeChecked();
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

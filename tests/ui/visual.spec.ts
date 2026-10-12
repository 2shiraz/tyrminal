// Visual regression tour of every main screen in both themes, with synthetic data. Baselines live
// in __screenshots__ and are reviewed like code; a change in appearance shows up as a diff.
import { expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

// Park the pointer so hover states and tooltips never leak into a baseline.
const shot = async (page: import("@playwright/test").Page, name: string) => {
  await page.mouse.move(1, 859);
  // The timeout bounds capture on a busy runner (software WebGL); matching is unchanged.
  await expect(page).toHaveScreenshot(name, { timeout: 15_000 });
};

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test(`onboarding and recovery key (${theme})`, async ({ page }) => {
      await openApp(page, { scenario: "onboarding", theme });
      await expect(page.getByRole("heading", { name: "Create your local vault" })).toBeVisible();
      await shot(page, `${theme}-01-onboarding.png`);
      await page.getByLabel("Vault passphrase", { exact: true }).fill("correct horse battery");
      await page.getByLabel("Repeat passphrase").fill("correct horse battery");
      await page.getByRole("button", { name: "Create vault" }).click();
      await expect(page.getByRole("heading", { name: "Save your recovery key" })).toBeVisible();
      await shot(page, `${theme}-02-recovery-key.png`);
    });

    test(`unlock (${theme})`, async ({ page }) => {
      await openApp(page, { scenario: "locked", theme });
      await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
      await shot(page, `${theme}-03-unlock.png`);
    });

    test(`home, empty (${theme})`, async ({ page }) => {
      await openApp(page, { scenario: "empty", theme });
      await expect(page.getByRole("heading", { name: "Welcome to Tyrminal" })).toBeVisible();
      await shot(page, `${theme}-04-home-empty.png`);
    });

    test(`home with data (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await expect(page.getByRole("heading", { name: "Recent connections" })).toBeVisible();
      await shot(page, `${theme}-05-home.png`);
    });

    test(`hosts grid, list and editor (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
      await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
      await shot(page, `${theme}-06-hosts-grid.png`);
      await page.locator(".segmented label", { hasText: "List" }).click();
      await shot(page, `${theme}-07-hosts-list.png`);
      await page.getByRole("button", { name: "Add host" }).click();
      await expect(page.getByRole("complementary", { name: "New host" })).toBeVisible();
      await shot(page, `${theme}-08-host-editor.png`);
    });

    test(`terminal with snippets panel (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByRole("button", { name: "Connect to api-gateway" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
      await page.getByRole("button", { name: "Snippets", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Snippets" })).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, `${theme}-09-terminal-snippets.png`);
    });

    test(`split panes and command palette (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByRole("button", { name: "Connect to db-primary" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
      await page.getByRole("tab", { name: /db-primary/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Split pane right" }).click();
      await expect(page.locator(".pane")).toHaveCount(2);
      await page.waitForTimeout(300);
      await shot(page, `${theme}-10-split.png`);
      await page.getByRole("button", { name: "Search or run a command" }).click();
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await page.getByRole("combobox", { name: /Type a command/ }).fill("dep");
      await shot(page, `${theme}-11-palette.png`);
    });

    test(`settings and snippets page (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
      await shot(page, `${theme}-12-settings.png`);
      await page.getByRole("heading", { name: "Terminal", level: 2 }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, `${theme}-13-settings-terminal.png`);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Snippets/ }).click();
      await shot(page, `${theme}-14-snippets.png`);
    });

    test(`keychain and known hosts (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Keychain" }).click();
      await expect(page.getByRole("heading", { name: "Keychain" })).toBeVisible();
      await shot(page, `${theme}-15-keychain.png`);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Known hosts" }).click();
      await expect(page.getByRole("heading", { name: "Known hosts" })).toBeVisible();
      await shot(page, `${theme}-16-known-hosts.png`);
    });

    test(`trust prompt (${theme})`, async ({ page }) => {
      await openApp(page, { theme, trustPromptFor: "staging-web" });
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
      await page.getByRole("button", { name: "Connect to staging-web" }).click();
      await expect(page.getByRole("alertdialog", { name: "Verify this server before connecting" })).toBeVisible();
      await shot(page, `${theme}-17-trust-prompt.png`);
    });

    test(`sftp tab (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.keyboard.press("Control+Shift+K");
      await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
      await page.keyboard.press("Enter");
      const view = page.getByRole("region", { name: "SFTP file manager" });
      await expect(view.getByRole("heading", { name: "Connect to host" })).toBeVisible();
      await shot(page, `${theme}-18-sftp-picker.png`);
      await view.getByRole("region", { name: "Left pane" }).getByRole("button", { name: "Choose folder…" }).click();
      await view.getByRole("region", { name: "Right pane" }).getByRole("button", { name: /^api-gateway/ }).click();
      await expect(view.getByRole("grid", { name: /on api-gateway/ })).toBeVisible();
      await view.getByRole("grid", { name: /on api-gateway/ }).getByRole("button", { name: "Select README.md" }).click();
      await shot(page, `${theme}-19-sftp-panes.png`);
    });

    test(`files panel (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.keyboard.press("Control+Shift+K");
      await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
      await page.keyboard.press("Enter");
      await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
      await page.keyboard.press("Control+Shift+O");
      const panel = page.getByRole("complementary", { name: "Files" });
      await panel.getByRole("grid", { name: /^Contents of / }).getByRole("button", { name: "Select deploy.sh" }).click();
      // One upload running: the drawer with its bar (no rate yet, so the picture is stable).
      await panel.getByRole("button", { name: "Upload", exact: true }).click();
      await page.getByRole("menuitem", { name: "Upload files…" }).click();
      await expect(panel.getByRole("region", { name: "Transfers" }).getByTestId("transfer-state")).toHaveText("1.0 KB of 2.0 KB");
      await panel.getByRole("grid", { name: /^Contents of / }).getByRole("button", { name: "Select deploy.sh" }).focus();
      await shot(page, `${theme}-20-files-panel.png`);
    });
  });
}

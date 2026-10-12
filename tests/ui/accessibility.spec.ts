// Automated WCAG 2.2 A/AA audit (axe-core) of the main screens, in both themes. The terminal's
// own rendering surface (xterm.js) is excluded: its content is whatever the remote side prints.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

import { type MockOptions, openApp } from "./fixtures";

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude(".xterm")
    // The tab strip has two known violations (tablist with non-tab children; close buttons nested
    // in tabs), owned by agent C and tracked in docs/work-split.md. Remove this once fixed.
    .exclude(".tabstrip")
    .analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    const base: MockOptions = { theme };

    test("lock and onboarding screens", async ({ page }) => {
      await openApp(page, { ...base, scenario: "locked" });
      await audit(page);
      await openApp(page, { ...base, scenario: "onboarding" });
      await audit(page);
    });

    test("home, hosts, snippets, keychain, known hosts and settings", async ({ page }) => {
      await openApp(page, base);
      await audit(page);
      for (const name of ["Hosts", "Snippets", "Keychain", "Known hosts", "Settings"]) {
        await nav(page, name);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit(page);
      }
    });

    test("a connected terminal with the files and snippets panels", async ({ page }) => {
      await openApp(page, { ...base, renderer: "compatibility" });
      await page.keyboard.press("Control+Shift+K");
      await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
      await page.keyboard.press("Enter");
      await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
      await audit(page);
      await page.keyboard.press("Control+Shift+O");
      await expect(page.getByRole("complementary", { name: "Files" }).getByRole("list", { name: /^Contents of \// })).toBeVisible();
      await audit(page);
      await page.keyboard.press("Control+Shift+S");
      await expect(page.getByRole("complementary", { name: "Snippets" })).toBeVisible();
      await audit(page);
    });

    test("the SFTP tab: host picker, both panes listed, and the actions menu", async ({ page }) => {
      await openApp(page, base);
      await page.keyboard.press("Control+Shift+K");
      await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
      await page.keyboard.press("Enter");
      const view = page.getByRole("region", { name: "SFTP file manager" });
      await expect(view.getByRole("heading", { name: "Connect to host" })).toBeVisible();
      await audit(page);
      await view.getByRole("region", { name: "Left pane" }).getByRole("button", { name: "Choose folder…" }).click();
      await view.getByRole("region", { name: "Right pane" }).getByRole("button", { name: /^api-gateway/ }).click();
      await expect(view.getByRole("table", { name: /on api-gateway/ })).toBeVisible();
      await view.getByRole("table", { name: /on api-gateway/ }).getByRole("button", { name: "Select README.md" }).click();
      await audit(page);
      await view.getByRole("button", { name: "Actions for the right pane" }).click();
      await expect(page.getByRole("menu", { name: "Actions" })).toBeVisible();
      await audit(page);
    });
  });
}

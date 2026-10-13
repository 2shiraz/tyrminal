// Afterglow design captures: key screens of the experimental build (mock backend) in both themes,
// for review in docs/experimental/. Not a test suite; see afterglow-capture.config.ts.
// AFTERGLOW_OUT picks the folder (default docs/design/afterglow), AFTERGLOW_ONLY a comma-separated
// subset of shot names.
import { type Page, expect, test } from "@playwright/test";

import { chooseLayout, connectHost, openApp } from "./fixtures";

const OUT = process.env.AFTERGLOW_OUT ?? new URL("../../docs/design/afterglow", import.meta.url).pathname;
const ONLY = process.env.AFTERGLOW_ONLY?.split(",");

const nav = (page: Page, name: RegExp | string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name }).first().click();

for (const theme of ["dark", "light"] as const) {
  test(`afterglow ${theme}`, async ({ page }) => {
    test.setTimeout(240_000);
    /** `fn` prepares the screen; with `own`, it also takes the screenshot itself (mid-motion shots). */
    const shot = async (name: string, fn?: () => Promise<void>, own = false) => {
      if (ONLY && !ONLY.includes(name)) return;
      try {
        if (fn) await fn();
        if (own) return;
        await page.mouse.move(1, 719);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${OUT}/${theme}-${name}.png` });
      } catch (e) {
        console.log(`skip ${name}: ${String(e).slice(0, 200)}`);
      }
    };
    await openApp(page, { scenario: "onboarding", theme });
    await shot("01-onboarding");
    await openApp(page, { scenario: "locked", theme });
    await shot("02-unlock");
    await openApp(page, { scenario: "empty", theme });
    await shot("03-hosts-empty", () => nav(page, /^Hosts/));
    await openApp(page, { theme, hostsLayout: "list", renderer: "compatibility" });
    await shot("04-home");
    await shot("05-hosts-list", () => nav(page, /^Hosts/));
    await shot("06-hosts-grid", () => chooseLayout(page, "Cards"));
    await shot("07-host-editor", async () => {
      await chooseLayout(page, "List");
      await page.getByRole("button", { name: "New host" }).click();
      await expect(page.getByRole("complementary", { name: "New host" })).toBeVisible();
    });
    await page.keyboard.press("Escape");
    await shot("08-menu", async () => {
      await page.locator('[data-testid="host-list"]').getByRole("button", { name: "db-primary", exact: true }).click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
    });
    await page.keyboard.press("Escape");
    await shot("09-snippets", () => nav(page, /^Snippets/));
    await shot("10-keychain", () => nav(page, "Keychain"));
    await shot("11-known-hosts", () => nav(page, "Known hosts"));
    await shot("12-settings", () => nav(page, /^Settings/));
    await shot("13-terminal", async () => {
      await nav(page, /^Hosts/);
      await connectHost(page, "api-gateway");
      await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
      await page.waitForTimeout(1500);
    });
    await shot("14-terminal-snippets", async () => {
      await page.getByRole("button", { name: "Snippets", exact: true }).click();
      await page.waitForTimeout(300);
    });
    await shot("15-palette", async () => {
      await page.getByRole("button", { name: "Search or run a command" }).click();
      await page.getByRole("combobox", { name: /Type a command/ }).fill("dep");
    });
    await page.keyboard.press("Escape");
    await shot("16-split", async () => {
      await page.getByRole("tab", { name: /api-gateway/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Split pane right" }).click();
      await expect(page.locator(".pane")).toHaveCount(2);
      await page.waitForTimeout(300);
    });
    await shot("18-tab-glide", async () => {
      // Mid-glide: motion allowed, a pointer switch, caught after a few frames.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => {
        document.documentElement.dataset.reduceMotion = "false";
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Shift+T");
      await page.waitForTimeout(400);
      await page.getByRole("tab", { name: /api-gateway/ }).click();
      await page.waitForTimeout(40);
      await page.screenshot({ path: `${OUT}/${theme}-18-tab-glide.png` });
    }, true);
    await openApp(page, { theme, trustPromptFor: "staging-web", renderer: "compatibility" });
    await shot("17-trust-prompt", async () => {
      await nav(page, /^Hosts/);
      await connectHost(page, "staging-web");
      await expect(page.getByRole("alertdialog")).toBeVisible();
    });
  });
}

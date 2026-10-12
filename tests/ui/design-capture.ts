// Captures every main screen of the real UI build (mock backend) in both themes, for the design
// audit in docs/design/overhaul.md. Not part of the test suite, which matches *.spec.ts only.
// From the repository root:
//   pnpm --filter @tyrminal/desktop build
//   cd tests/ui && npx playwright test -c design-capture.config.ts
// AUDIT_OUT and AUDIT_PREFIX choose the folder and a file-name prefix (used for other branches).
import { type Page, expect, test } from "@playwright/test";
import { connectHost, openApp } from "./fixtures";
const OUT = process.env.AUDIT_OUT ?? new URL("../../docs/design/before", import.meta.url).pathname;
const PREFIX = process.env.AUDIT_PREFIX ?? "";
const shot = async (page: Page, name: string) => {
  await page.mouse.move(1, 859);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${PREFIX}${name}.png` });
};
const nav = (page: Page, name: RegExp | string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name }).first().click();
async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}
for (const theme of ["dark", "light"] as const) {
  test(`audit ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    const t = async (name: string, fn: () => Promise<void>) => {
      try { await fn(); await shot(page, `${theme}-${name}`); } catch (e) { console.log(`skip ${name}: ${String(e).slice(0, 160)}`); }
    };
    await openApp(page, { scenario: "onboarding", theme });
    await shot(page, `${theme}-onboarding`);
    await openApp(page, { scenario: "locked", theme });
    await shot(page, `${theme}-unlock`);
    await openApp(page, { scenario: "empty", theme });
    await shot(page, `${theme}-home-empty`);
    await t("hosts-empty", () => nav(page, /^Hosts/));
    await t("tunnels-empty", () => page.locator('[data-nav="tunnels"]').click());
    await openApp(page, { theme });
    await shot(page, `${theme}-home`);
    await t("hosts-grid", () => nav(page, /^Hosts/));
    await t("hosts-list", () => page.locator(".segmented label", { hasText: "List" }).click());
    await t("host-editor", async () => { await page.getByRole("button", { name: "Add host" }).click(); await expect(page.getByRole("dialog")).toBeVisible(); });
    await page.keyboard.press("Escape");
    await t("snippets", () => nav(page, /^Snippets/));
    await t("tunnels", () => page.locator('[data-nav="tunnels"]').click());
    await t("keychain", () => nav(page, "Keychain"));
    await t("known-hosts", () => nav(page, "Known hosts"));
    await t("settings", () => nav(page, "Settings"));
    await t("settings-terminal", async () => { await page.getByRole("heading", { name: "Terminal", level: 2 }).scrollIntoViewIfNeeded(); });
    await t("terminal", async () => { await connect(page, "api-gateway"); await page.waitForTimeout(300); });
    await t("terminal-files", async () => { await page.keyboard.press("Control+Shift+O"); await expect(page.getByRole("complementary", { name: "Files" })).toBeVisible(); await page.waitForTimeout(300); });
    await t("terminal-snippets", async () => { await page.getByRole("button", { name: "Snippets", exact: true }).click(); await page.waitForTimeout(300); });
    await t("palette", async () => { await page.getByRole("button", { name: "Search or run a command" }).click(); await page.getByRole("combobox", { name: /Type a command/ }).fill("dep"); });
    await page.keyboard.press("Escape");
    await openApp(page, { theme, trustPromptFor: "staging-web" });
    await t("trust-prompt", async () => { await nav(page, /^Hosts/); await connectHost(page, "staging-web"); await expect(page.getByRole("alertdialog")).toBeVisible(); });
    await openApp(page, { theme, hostKeyChangedFor: "staging-web" });
    await t("host-key-changed", async () => { await nav(page, /^Hosts/); await connectHost(page, "staging-web"); await page.waitForTimeout(500); });
  });
}

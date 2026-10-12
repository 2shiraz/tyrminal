// Captures the Files side panel and the SFTP tab (mock backend) in both themes, for the before and
// after images in docs/design/files.md. Not part of the test suite, which matches *.spec.ts only.
// From the repository root:
//   pnpm --filter @tyrminal/desktop build
//   cd tests/ui && npx playwright test -c design-capture.config.ts design-capture-files.ts
// AUDIT_OUT chooses the folder (default docs/design/files/after).
import { type Page, expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

const OUT = process.env.AUDIT_OUT ?? new URL("../../docs/design/files/after", import.meta.url).pathname;
const shot = async (page: Page, name: string) => {
  await page.mouse.move(1, 859);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

async function openSftp(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "SFTP file manager" })).toBeVisible();
}

for (const theme of ["dark", "light"] as const) {
  test(`files ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    const t = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        await shot(page, `${theme}-${name}`);
      } catch (e) {
        console.log(`skip ${name}: ${String(e).slice(0, 200)}`);
      }
    };
    await openApp(page, { theme });
    await connect(page, "api-gateway");
    await t("panel", async () => {
      await page.keyboard.press("Control+Shift+O");
      await expect(page.getByRole("complementary", { name: "Files" })).toBeVisible();
      await page.waitForTimeout(300);
    });
    const panel = page.getByRole("complementary", { name: "Files" });
    await t("panel-selected", async () => {
      await panel.getByRole("button", { name: /deploy\.sh/ }).first().click();
    });
    await t("panel-menu", async () => {
      await panel.getByRole("button", { name: /deploy\.sh/ }).first().click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
    });
    await page.keyboard.press("Escape");
    await t("panel-rename", async () => {
      await panel.getByRole("button", { name: "Select README.md" }).click();
      await page.keyboard.press("F2");
      await panel.getByRole("textbox", { name: "New name for README.md" }).fill("deploy.sh");
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("alert")).toBeVisible();
    });
    await page.keyboard.press("Escape");
    await t("panel-transfers", async () => {
      await panel.getByRole("button", { name: "Upload", exact: true }).click();
      await page.getByRole("menuitem", { name: "Upload files…" }).click();
      await panel.getByRole("button", { name: "Select backup.tar.gz" }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Download…" }).click();
      await page.evaluate(() => {
        const w = window as unknown as { __mockTransfers: Map<string, { finish(): void }> };
        [...w.__mockTransfers.values()][0]?.finish();
      });
      await panel.getByRole("button", { name: "Edit path" }).click();
    });
    await page.keyboard.press("Escape");

    await openApp(page, { theme });
    await t("sftp-picker", () => openSftp(page));
    const view = page.getByRole("region", { name: "SFTP file manager" });
    await t("sftp-panes", async () => {
      await view.getByRole("region", { name: "Left pane", exact: true }).getByRole("button", { name: "Choose folder…" }).click();
      await view.getByRole("region", { name: "Right pane", exact: true }).getByRole("group", { name: "Select host" }).getByRole("button", { name: /^api-gateway/ }).click();
      await expect(view.getByRole("region", { name: "Right pane", exact: true }).getByRole("grid")).toBeVisible();
      await view.getByRole("region", { name: "Right pane", exact: true }).getByRole("button", { name: /README\.md/ }).first().click();
    });
    await t("sftp-path", async () => {
      await view.getByRole("region", { name: "Right pane", exact: true }).getByRole("button", { name: "Edit path" }).click();
    });
    await page.keyboard.press("Escape");
    await t("sftp-swapped", async () => {
      await view.getByRole("button", { name: "Swap panes" }).click();
      await view.getByRole("region", { name: "Right pane", exact: true }).getByRole("button", { name: /notes\.md/ }).first().click();
    });
    await t("sftp-menu", async () => {
      await view.getByRole("region", { name: "Left pane", exact: true }).getByRole("button", { name: /deploy\.sh/ }).first().click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
    });
    await page.keyboard.press("Escape");
  });
}

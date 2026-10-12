// OS auto-detection setting against the UI test mock. The read itself (a fixed command on an
// exec channel, skipped for hosts with a chosen OS or while off) is tested against the lab server
// in crates/core/tests/sessions_lab.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

test("detection is on by default, explained, and can be turned off and on again", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "Privacy");
  const toggle = page.getByRole("switch", { name: /Detect each server's operating system/ });
  await expect(toggle).toBeChecked();
  await expect(page.getByText(/never in your shell/)).toBeVisible();
  await expect(page.getByText(/Turning this off forgets what was detected/)).toBeVisible();

  await toggle.uncheck();
  await expect.poll(async () => (await calls(page, "os_detection_set")).at(-1)?.args).toEqual({ enabled: false });
  await expect(toggle).not.toBeChecked();

  // Kept across a revisit (read back from the core).
  await openSettings(page, "Appearance");
  await openSettings(page, "Privacy");
  await expect(page.getByRole("switch", { name: /Detect each server's operating system/ })).not.toBeChecked();
  await page.getByRole("switch", { name: /Detect each server's operating system/ }).check();
  await expect.poll(async () => (await calls(page, "os_detection_set")).at(-1)?.args).toEqual({ enabled: true });
});

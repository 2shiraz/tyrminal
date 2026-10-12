// Compromised-password check (SEC-11) settings against the UI test mock. Hashing, prefix-only
// requests, padding and failure handling are tested in Rust against a stub server on loopback
// (crates/core/src/password_check.rs, crates/core/tests/password_check.rs).

import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function openSecurity(page: Page) {
  await openSettings(page, "Password check");
  const section = page.getByTestId("password-check");
  return section;
}

test("off by default, says what is sent, and this build cannot run it", async ({ page }) => {
  await openApp(page);
  const section = await openSecurity(page);
  await expect(section).toContainText("sends only the first 5 characters");
  await expect(section).toContainText("Passwords, full hashes and names never leave this computer");
  await expect(section.getByRole("switch", { name: /Allow compromised-password checks/ })).not.toBeChecked();
  await expect(section).toContainText("Not available in this build");
  await expect(section.getByRole("button", { name: "Check stored passwords" })).toBeDisabled();

  // Turning it on is stored, but there is still nothing to run here.
  await section.getByRole("switch", { name: /Allow compromised-password checks/ }).check();
  await expect.poll(async () => ((await calls(page, "prefs_set")).at(-1)?.args as { prefs: { passwordCheck: { enabled: boolean } } } | undefined)?.prefs.passwordCheck.enabled).toBe(true);
  await expect(section.getByRole("button", { name: "Check stored passwords" })).toBeDisabled();
  expect(await calls(page, "password_check_run")).toHaveLength(0);
});

test("the address must be https without credentials; a run lists what was found", async ({ page }) => {
  await openApp(page, { passwordCheckAvailable: true });
  const section = await openSecurity(page);
  const address = section.getByLabel("Service address");
  await address.fill("http://mirror.example/range/");
  await expect(section).toContainText("Use an https:// address without a user name, query or fragment.");
  await expect(section.getByRole("button", { name: "Use this address" })).toBeDisabled();
  await address.fill("https://user:pw@mirror.example/range/");
  await expect(section.getByRole("button", { name: "Use this address" })).toBeDisabled();
  await address.fill("https://mirror.example/range/");
  await section.getByRole("button", { name: "Use this address" }).click();

  // Still off: the run button waits for the switch.
  await expect(section.getByRole("button", { name: "Check stored passwords" })).toBeDisabled();
  await section.getByRole("switch", { name: /Allow compromised-password checks/ }).check();
  await section.getByRole("button", { name: "Check stored passwords" }).click();
  const result = section.getByRole("status");
  await expect(result).toContainText("1 of 2 stored passwords found in breaches (2 requests sent).");
  await expect(result).toContainText("edge-cache");
  await expect(result).toContainText("Seen 10,434,004 times in breaches. Change it.");
  await expect(result).toContainText("Identity password · Not found");
  const saved = (await calls(page, "prefs_set")).at(-1)?.args as { prefs: { passwordCheck: unknown } };
  expect(saved.prefs.passwordCheck).toEqual({ enabled: true, endpoint: "https://mirror.example/range/" });
});

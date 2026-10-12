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

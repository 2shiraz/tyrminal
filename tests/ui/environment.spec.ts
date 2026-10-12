// Environment variables (SNP-11..14) against the UI test mock: set on a group and a host, the
// host lists what it inherits and what it overrides; a refusal by the server is reported when a
// session opens and in snippet run results; Suggestions offer the host's variable names after $.
// Delivery and AcceptEnv refusals are tested against the real server in inventory_lab.rs.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
const commandLine = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __mockState: { sessions: Map<string, { line: string }> } }).__mockState.sessions.values()].at(-1)?.line ?? null);

async function setVars(page: Page, opener: () => Promise<void>, title: string, vars: [string, string][]) {
  await opener();
  await page.getByRole("menuitem", { name: "Environment…" }).click();
  const dialog = page.getByRole("dialog", { name: title });
  for (const [i, [name, value]] of vars.entries()) {
    await dialog.getByRole("button", { name: "Add variable" }).click();
    await dialog.getByLabel(`Name ${i + 1}`).fill(name);
    await dialog.getByLabel(`Value ${i + 1}`).fill(value);
  }
  return dialog;
}

test("group variables are inherited, host values override them, refusals are reported", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await nav(page, "Hosts");
  const group = await setVars(page, () => page.getByRole("button", { name: "Actions for group Production" }).click(), "Environment for Production", [
    ["TYR_REGION", "eu-1"],
    ["LEGACY_MODE", "on"],
  ]);
  await group.getByRole("button", { name: "Save variables" }).click();
  await expect(group).toHaveCount(0);
  await expect(page.getByText("Environment saved")).toBeVisible();

  const host = await setVars(page, () => page.getByRole("button", { name: "More actions for api-gateway" }).first().click(), "Environment for api-gateway", [["TYR_REGION", "eu-2"]]);
  const inherited = host.getByTestId("env-inherited");
  await expect(inherited).toContainText("TYR_REGION");
  await expect(inherited).toContainText("from Production");
  await expect(inherited.locator("li", { hasText: "TYR_REGION" })).toContainText("overridden here");
  await expect(inherited.locator("li", { hasText: "LEGACY_MODE" })).not.toContainText("overridden here");
  // Invalid names are refused by the core and nothing is saved.
  await host.getByRole("button", { name: "Add variable" }).click();
  await host.getByLabel("Name 2").fill("1BAD");
  await host.getByRole("button", { name: "Save variables" }).click();
  await expect(host.getByRole("alert")).toContainText("do not start with a digit");
  await host.getByRole("button", { name: "Remove 1BAD" }).click();
  await host.getByRole("button", { name: "Save variables" }).click();
  await expect(host).toHaveCount(0);

  // Connecting reports the variable the server refused, by name.
  await page.getByRole("button", { name: "Connect to api-gateway" }).click();
  await waitForTerminalText(page, "deploy@api-gateway");
  await expect(page.getByText("The server refused the environment variable LEGACY_MODE")).toBeVisible();

  // Suggestions offer the host's variable names after $, inserted quoted and not run.
  await page.keyboard.press("Control+Shift+E");
  const suggest = page.getByRole("dialog", { name: "Suggestions" });
  await suggest.getByLabel("Type to find a command, snippet or path").fill("$TYR");
  const vars = suggest.getByRole("group", { name: "Variables of this host" }).getByRole("option");
  await expect(vars).toHaveCount(1);
  await expect(vars).toContainText("$TYR_REGION");
  await vars.click();
  await expect.poll(() => commandLine(page)).toBe('"$TYR_REGION"');
});

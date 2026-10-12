// Quick port forwards from detected listening ports (P-24) against the UI test mock (UI evidence
// only; detection, the refusal of ports not suggested, and the forward reaching a lab service are
// tested in crates/core: port_suggest unit tests and tunnels_lab). A suggestion forwards nothing
// until accepted, "Open in browser" opens only the address built for the local listener, and
// suggestions can be turned off globally and for one host.

import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Connect to api-gateway" }).click();
  await waitForTerminalText(page, "deploy@api-gateway");
}

const suggest = (page: Page, port: number) => page.evaluate((p) => (window as unknown as { __mockSuggestPort: (p: number) => void }).__mockSuggestPort(p), port);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.map((c) => c.cmd));
const offer = (page: Page) => page.getByTestId("quick-forward-offer");

test("quick forward: a suggestion forwards nothing until accepted, then opens only the local address", async ({ page }) => {
  await connected(page);
  await suggest(page, 3000);
  await expect(offer(page)).toContainText("listening on port 3000");
  expect(await calls(page)).not.toContain("quick_forward_start");

  // Not now dismisses it without forwarding anything.
  await offer(page).getByRole("button", { name: "Not now" }).click();
  await expect(offer(page)).toHaveCount(0);
  expect(await calls(page)).not.toContain("quick_forward_start");

  await suggest(page, 5173);
  await offer(page).getByRole("button", { name: "Forward", exact: true }).click();
  const active = page.getByTestId("quick-forward-active");
  await expect(active).toContainText("Server port 5173 is forwarded to 127.0.0.1:5173");
  await active.getByRole("button", { name: "Open in browser" }).click();
  await expect(page.getByText("Opened http://127.0.0.1:5173/")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __mockOpenedQuick: string[] }).__mockOpenedQuick)).toEqual(["http://127.0.0.1:5173/"]);

  const scan = await new AxeBuilder({ page }).include(".quick-forward").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(scan.violations).toEqual([]);

  await active.getByRole("button", { name: "Stop" }).click();
  await expect(active).toHaveCount(0);
});

test("quick forward: suggestions can be turned off for a host and everywhere", async ({ page }) => {
  await connected(page);
  await suggest(page, 8080);
  await offer(page).getByRole("button", { name: "Don't suggest for this host" }).click();
  await expect(offer(page)).toHaveCount(0);
  await expect(page.getByText("Port suggestions are off for this host")).toBeVisible();
  expect(await page.evaluate(() => [...(window as unknown as { __mockPortSuggestionsOff: Set<string> }).__mockPortSuggestionsOff])).toHaveLength(1);

  // Turned off everywhere in Settings: a new suggestion is not shown.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("switch", { name: /Suggest forwarding ports/ }).uncheck();
  await page.getByRole("tab").first().click();
  await suggest(page, 9000);
  await page.waitForTimeout(300);
  await expect(offer(page)).toHaveCount(0);
});

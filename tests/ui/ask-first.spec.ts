// "Ask first" settings: opening several sessions and sending a snippet of several lines are
// reviewed first, each review offers "don't ask again", and Settings turns the question back on.
// Opening production hosts has its own question, turned off only by the choice that names them;
// a snippet on a production host is asked whatever the settings say. Production frontend, mock backend.
import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp, openSettings, selectedHosts } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.filter((x) => x.cmd === c).length, cmd);
const pref = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as { __mockState: { prefs: Record<string, unknown> } }).__mockState.prefs[k], key);
const hosts = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
const host = (page: Page, name: string) => page.getByTestId("host-list").getByRole("button", { name, exact: true });
/** Selects a run of hosts by a click and a Shift-click, then presses Enter on it. */
async function openRange(page: Page, first: string, last: string) {
  await hosts(page);
  await host(page, first).click();
  await host(page, last).click({ modifiers: ["Shift"] });
  await expect.poll(() => selectedHosts(page).count()).toBeGreaterThan(1);
  // Enter on the host itself, wherever focus went meanwhile (host details opens after a click).
  await host(page, last).press("Enter");
}

test("opening several sessions asks first; \"don't ask again\" opens directly from then on; production hosts keep their own question until it is turned off by name", async ({ page }) => {
  await openApp(page, { hostsLayout: "list" });
  // edge-cache, Home lab and staging-web: none is a production host.
  await openRange(page, "edge-cache", "staging-web");
  const review = page.getByRole("dialog", { name: "Open 3 sessions?" });
  await expect(review).toBeVisible();
  expect(await calls(page, "session_open_ssh")).toBe(0);
  await review.getByRole("button", { name: "More ways to open" }).click();
  await review.getByRole("menuitem", { name: "Open and don't ask again", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(() => calls(page, "session_open_ssh")).toBe(3);
  await expect.poll(() => pref(page, "confirmMultiOpen")).toBe(false);
  // The general choice did not touch the production one.
  expect(await pref(page, "confirmProductionOpen")).not.toBe(false);

  // The same selection now opens without the review.
  await openRange(page, "edge-cache", "staging-web");
  await expect.poll(() => calls(page, "session_open_ssh")).toBe(6);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A selection with a production host is still reviewed, and opening it still names the
  // production host and asks, with Cancel in focus.
  await openRange(page, "api-gateway", "build-runner-03");
  const guarded = page.getByRole("dialog", { name: "Open 2 sessions?" });
  await expect(guarded).toBeVisible();
  expect(await calls(page, "session_open_ssh")).toBe(6);
  await guarded.getByRole("button", { name: "Open 2 sessions" }).click();
  const production = page.getByRole("alertdialog");
  await expect(production).toContainText("api-gateway");
  await production.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "session_open_ssh")).toBe(6);

  // The choice that names production hosts covers them, from then on.
  await guarded.getByRole("button", { name: "More ways to open" }).click();
  await guarded.getByRole("menuitem", { name: "Open and don't ask again, production hosts too" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => calls(page, "session_open_ssh")).toBe(8);
  await expect.poll(() => pref(page, "confirmProductionOpen")).toBe(false);
  await openRange(page, "api-gateway", "build-runner-03");
  await expect.poll(() => calls(page, "session_open_ssh")).toBe(10);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Settings shows the choice and turns the question back on.
  await openSettings(page, "Terminal");
  const ask = page.getByRole("switch", { name: "Ask before opening several sessions" });
  await expect(ask).not.toBeChecked();
  await ask.click();
  await expect.poll(() => pref(page, "confirmMultiOpen")).toBe(true);
  const askProduction = page.getByRole("switch", { name: "Ask when one of them is a production host" });
  await expect(askProduction).not.toBeChecked();
  await askProduction.click();
  await expect.poll(() => pref(page, "confirmProductionOpen")).toBe(true);
  await openRange(page, "edge-cache", "staging-web");
  await expect(page.getByRole("dialog", { name: "Open 3 sessions?" })).toBeVisible();
});

test("a snippet of several lines asks first; \"don't ask again\" sends directly from then on, except on a production host", async ({ page }) => {
  await openApp(page, { hostsLayout: "list" });
  await hosts(page);
  await connectHost(page, "edge-cache");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.locator(".statusbar").getByRole("button", { name: "Snippets", exact: true }).click();
  const run = page.getByRole("button", { name: "Run Deploy to staging in the terminal" });
  await run.click();
  const review = page.getByRole("alertdialog", { name: /Deploy to staging/ });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "More ways to send" }).click();
  await review.getByRole("menuitem", { name: "Run and don't ask again" }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(() => pref(page, "confirmSnippetRun")).toBe(false);
  await expect.poll(() => calls(page, "snippet_send")).toBe(1);

  // The next run goes straight to the terminal.
  await run.click();
  await expect.poll(() => calls(page, "snippet_send")).toBe(2);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // On a production host the lines are still shown first, with no way to skip that later.
  await hosts(page);
  await connectHost(page, "api-gateway");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.getByRole("button", { name: "Run Deploy to staging in the terminal" }).click();
  const guarded = page.getByRole("alertdialog", { name: /Deploy to staging/ });
  await expect(guarded).toBeVisible();
  await expect(guarded.getByRole("button", { name: "More ways to send" })).toHaveCount(0);
  await guarded.getByRole("button", { name: "Cancel" }).click();

  await openSettings(page, "Terminal");
  await expect(page.getByRole("switch", { name: "Ask before sending a snippet of several lines" })).not.toBeChecked();
});

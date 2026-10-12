// Production host guardrails (P-26) against the UI test mock: the flag on hosts and groups, the
// production tag, session markers with a text label, and confirmations (Cancel focused) before
// broadcasting, multi-host runs and group connections. How the core stores and inherits the flag
// is tested against a real vault in crates/core/tests/inventory.rs. The mock never makes a row
// VERIFIED.

import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const hostCard = (page: Page, label: string) => page.getByTestId("host-list").getByRole("article", { name: label, exact: true });
// The badge, not the word: the seed also has a group named "Production".
const badge = (page: Page, label: string) => hostCard(page, label).locator(".badge-production");

async function openHosts(page: Page) {
  await primary(page).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

async function connect(page: Page, label: string) {
  await openHosts(page);
  await page.getByRole("button", { name: `Connect to ${label}` }).click();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

async function paletteAction(page: Page, text: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(text);
  await page.keyboard.press("Enter");
}

test("hosts are production through their flag, a group above them or the production tag", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  // The seed tags api-gateway and db-primary with "prod", the default production tag.
  for (const label of ["api-gateway", "db-primary"]) await expect(badge(page, label)).toBeVisible();
  for (const label of ["edge-cache", "Home lab", "staging-web"]) await expect(badge(page, label)).toHaveCount(0);

  // The host's own switch, in the Host details panel.
  const details = page.getByRole("complementary", { name: "Host details" });
  await page.getByTestId("host-list").getByRole("button", { name: "edge-cache", exact: true }).click();
  await details.getByRole("switch", { name: /Production host/ }).check();
  await details.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await calls(page, "host_save")).at(-1)?.args.host).toMatchObject({ production: true });
  await expect(badge(page, "edge-cache")).toBeVisible();

  // A group's switch applies to every host in it.
  await page.getByRole("button", { name: "Actions for group Lab" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const groupEditor = page.getByRole("dialog", { name: "Edit group" });
  await groupEditor.getByRole("switch", { name: /Production group/ }).check();
  await groupEditor.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await calls(page, "group_save")).at(-1)?.args.group).toMatchObject({ production: true });
  await page.getByRole("button", { name: "All hosts" }).click();
  await expect(badge(page, "Home lab")).toBeVisible();
  // Its details say why, without turning the host's own switch on.
  await page.getByTestId("host-list").getByRole("button", { name: "Home lab", exact: true }).click();
  await expect(details.getByRole("switch", { name: /Production host/ })).not.toBeChecked();
  await expect(details.getByText("This host is a production host through its group.")).toBeVisible();
});

test("the production tag is a setting; empty leaves only the switches", async ({ page }) => {
  await openApp(page);
  await primary(page).getByRole("button", { name: /^Settings/ }).click();
  const field = page.getByRole("textbox", { name: "Production tag" });
  await expect(field).toHaveValue("prod");
  await field.fill("ci");
  await field.press("Enter");
  await expect.poll(async () => (await calls(page, "prefs_set")).at(-1)?.args.prefs).toMatchObject({ productionTag: "ci" });
  await openHosts(page);
  await expect(badge(page, "build-runner-03")).toBeVisible();
  await expect(badge(page, "api-gateway")).toHaveCount(0);

  await primary(page).getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("textbox", { name: "Production tag" }).fill("");
  await page.getByRole("textbox", { name: "Production tag" }).blur();
  await expect.poll(async () => (await calls(page, "prefs_set")).at(-1)?.args.prefs).toMatchObject({ productionTag: "" });
  await openHosts(page);
  await expect(page.getByTestId("host-list").locator(".badge-production")).toHaveCount(0);
});

test("production sessions carry a red edge and the word Production on the tab and the pane", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  const prodTab = page.getByRole("tab", { name: /api-gateway/ });
  await expect(prodTab).toHaveAttribute("data-production", "true");
  await expect(prodTab.getByText("Production", { exact: true })).toBeVisible();
  const prodPane = page.locator(".pane[data-production]");
  await expect(prodPane).toHaveCount(1);
  await expect(prodPane.getByText("Production", { exact: true })).toBeVisible();

  await connect(page, "staging-web");
  const plainTab = page.getByRole("tab", { name: /staging-web/ });
  await expect(plainTab).not.toHaveAttribute("data-production", "true");
  await expect(plainTab.getByText("Production", { exact: true })).toHaveCount(0);
});

test("broadcasting to a production pane asks first, with Cancel focused", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);

  // The broadcast review lists the panes and marks the production ones; then production asks.
  await paletteAction(page, "every pane");
  const review = page.getByRole("alertdialog", { name: "Type into these 2 panes?" });
  await expect(review.getByRole("listitem").filter({ hasText: "Production" })).toHaveCount(2);
  await review.getByRole("button", { name: "Type into 2 panes" }).click();
  const ask = page.getByRole("alertdialog", { name: "Broadcast to production?" });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("listitem")).toHaveText(["Production api-gateway"]);
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Enter on the focused button cancels: nothing is broadcast.
  await page.keyboard.press("Enter");
  await expect(ask).toBeHidden();
  await expect(page.getByTestId("broadcast")).toHaveCount(0);
  await expect(page.locator(".pane[data-broadcast]")).toHaveCount(0);

  await paletteAction(page, "every pane");
  await page.getByRole("alertdialog", { name: "Type into these 2 panes?" }).getByRole("button", { name: "Type into 2 panes" }).click();
  await page.getByRole("alertdialog", { name: "Broadcast to production?" }).getByRole("button", { name: "Broadcast" }).click();
  await expect(page.getByTestId("broadcast")).toHaveText("Typing into 2 panes");
  await page.keyboard.type("uptime");
  await page.keyboard.press("Enter");
  const paneText = (n: number) => page.locator(".pane .xterm-rows").nth(n).innerText();
  await expect.poll(() => paneText(0)).toContain("uptime: synthetic output");
  await expect.poll(() => paneText(1)).toContain("uptime: synthetic output");

  // Turned off and on again, it asks again.
  await page.getByTestId("broadcast").click();
  await expect(page.getByTestId("broadcast")).toHaveCount(0);
  await paletteAction(page, "every pane");
  await page.getByRole("alertdialog", { name: "Type into these 2 panes?" }).getByRole("button", { name: "Type into 2 panes" }).click();
  await expect(page.getByRole("alertdialog", { name: "Broadcast to production?" })).toBeVisible();
});

test("a multi-host run that includes production hosts asks first and runs nothing on Cancel", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await connect(page, "staging-web");
  await primary(page).getByRole("button", { name: /^Snippets/ }).click();
  await page.getByRole("button", { name: "More actions for Disk usage" }).click();
  await page.getByRole("menuitem", { name: "Run on hosts…" }).click();
  const dialog = page.getByRole("dialog", { name: "Run “Disk usage” on hosts" });
  for (const label of ["api-gateway", "staging-web"]) await dialog.getByRole("checkbox", { name: `Select ${label}` }).check();
  await dialog.getByRole("button", { name: "Review 2 hosts" }).click();
  const review = page.getByRole("dialog", { name: "Run “Disk usage”?" });
  await expect(review.getByTestId("run-review").getByRole("listitem").filter({ hasText: "api-gateway" })).toContainText("Production");
  await review.getByRole("button", { name: "Run on 2 hosts" }).click();

  const ask = page.getByRole("alertdialog", { name: "Run on production hosts?" });
  await expect(ask.getByRole("listitem")).toHaveText(["Production api-gateway"]);
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "snippet_exec")).toHaveLength(0);

  await review.getByRole("button", { name: "Run on 2 hosts" }).click();
  await page.getByRole("alertdialog", { name: "Run on production hosts?" }).getByRole("button", { name: "Run anyway" }).click();
  await expect.poll(async () => (await calls(page, "snippet_exec")).length).toBe(2);
});

test("connecting a group with production hosts asks first and opens nothing on Cancel", async ({ page }) => {
  await openApp(page);
  await openHosts(page);
  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "Connect to every host" }).click();
  await page.getByRole("dialog", { name: "Open 2 sessions?" }).getByRole("button", { name: "Open 2 sessions" }).click();
  const ask = page.getByRole("alertdialog", { name: "Connect to production hosts?" });
  await expect(ask.getByRole("listitem")).toHaveText(["Production api-gateway", "Production db-primary"]);
  const axe = await new AxeBuilder({ page }).include("dialog[role=alertdialog]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);

  await page.getByRole("dialog", { name: "Open 2 sessions?" }).getByRole("button", { name: "Open 2 sessions" }).click();
  await page.getByRole("alertdialog", { name: "Connect to production hosts?" }).getByRole("button", { name: "Connect" }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);

  // A group without production hosts connects without the extra question.
  await openHosts(page);
  await page.getByRole("button", { name: "Actions for group Lab" }).click();
  await page.getByRole("menuitem", { name: "Connect to every host" }).click();
  await page.getByRole("dialog", { name: "Open 1 session?" }).getByRole("button", { name: "Open 1 session" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(3);
});

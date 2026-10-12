// Selecting and opening several hosts at once on Hosts (owner request): click, Ctrl/Cmd toggle,
// Shift range, Ctrl/Cmd+A, Escape, arrow keys with Shift, double-click and Enter on a selection,
// tabs or one split tab, and the production confirmation (P-26). Against the UI test mock; every
// session still goes through its own trust and sign-in prompts. The mock never makes a row VERIFIED.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const list = (page: Page) => page.getByTestId("host-list");
const card = (page: Page, label: string) => list(page).getByRole("article", { name: label, exact: true });
const nameButton = (page: Page, label: string) => list(page).getByRole("button", { name: label, exact: true });
const selectedLabels = (page: Page) => list(page).locator('[data-selected="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.querySelector(".host-open")?.textContent));
const bulkBar = (page: Page) => page.getByTestId("bulk-bar");

async function openHosts(page: Page, options = {}) {
  await openApp(page, options);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

test("a click selects one host and shows it; Ctrl/Cmd-click toggles; Shift-click selects a range", async ({ page }) => {
  await openHosts(page);
  await nameButton(page, "build-runner-03").click();
  await expect(page.getByRole("complementary", { name: "Host details" })).toBeVisible();
  expect(await selectedLabels(page)).toEqual(["build-runner-03"]);
  // One host picked by a click is not a bulk selection yet.
  await expect(bulkBar(page)).toHaveCount(0);

  await nameButton(page, "edge-cache").click({ modifiers: ["ControlOrMeta"] });
  expect(await selectedLabels(page)).toEqual(["build-runner-03", "edge-cache"]);
  await expect(bulkBar(page)).toContainText("2 selected");
  await expect(card(page, "edge-cache")).toHaveAttribute("data-selected", "true");
  // Toggling again removes it.
  await nameButton(page, "edge-cache").click({ modifiers: ["ControlOrMeta"] });
  expect(await selectedLabels(page)).toEqual(["build-runner-03"]);

  // Shift-click: the range from the anchor (the last host clicked without Shift), replacing the
  // selection.
  await nameButton(page, "build-runner-03").click();
  await nameButton(page, "Home lab").click({ modifiers: ["Shift"] });
  expect(await selectedLabels(page)).toEqual(["build-runner-03", "db-primary", "edge-cache", "Home lab"]);
  // A plain click starts over.
  await nameButton(page, "api-gateway").click();
  expect(await selectedLabels(page)).toEqual(["api-gateway"]);
  // Shift+Ctrl/Cmd adds a range to what is selected.
  await nameButton(page, "edge-cache").click({ modifiers: ["ControlOrMeta"] });
  await nameButton(page, "staging-web").click({ modifiers: ["Shift", "ControlOrMeta"] });
  expect(await selectedLabels(page)).toEqual(["api-gateway", "edge-cache", "Home lab", "staging-web"]);
  // Assistive technology hears "Selected" after each selected name.
  await expect(nameButton(page, "staging-web")).toHaveAccessibleDescription("Selected");
  await expect(nameButton(page, "build-runner-03")).not.toHaveAccessibleDescription("Selected");
});

test("Ctrl/Cmd+A selects every shown host, Escape clears, and arrows move or extend", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("radiogroup", { name: "Layout" }).getByText("List").click();
  await nameButton(page, "api-gateway").click();
  await page.keyboard.press("Escape");
  // Escape closes the details first (focus is in the panel, and returns to the host); back on
  // the list it clears.
  await expect(page.getByRole("complementary", { name: "Host details" })).toHaveCount(0);
  await expect(nameButton(page, "api-gateway")).toBeFocused();
  await nameButton(page, "build-runner-03").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(bulkBar(page)).toContainText("6 selected");
  await page.keyboard.press("Escape");
  await expect(list(page).locator('[data-selected="true"]')).toHaveCount(0);

  await nameButton(page, "build-runner-03").focus();
  await page.keyboard.press("ArrowDown");
  await expect(nameButton(page, "db-primary")).toBeFocused();
  expect(await selectedLabels(page)).toEqual(["db-primary"]);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(nameButton(page, "Home lab")).toBeFocused();
  expect(await selectedLabels(page)).toEqual(["db-primary", "edge-cache", "Home lab"]);
  await expect(bulkBar(page)).toContainText("3 selected");
});

test("double-click on a selection reviews and opens one tab per host; trust stays per session", async ({ page }) => {
  await openHosts(page);
  await nameButton(page, "build-runner-03").click();
  await nameButton(page, "staging-web").click({ modifiers: ["ControlOrMeta"] });
  await card(page, "staging-web").locator(".host-card-dest").dblclick();
  const review = page.getByRole("dialog", { name: "Open 2 sessions?" });
  await expect(review.getByTestId("connect-all-list").getByRole("listitem")).toHaveCount(2);
  await expect(review.getByRole("radio", { name: "In separate tabs" })).toBeChecked();
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);
  await review.getByRole("button", { name: "Open 2 sessions" }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
  await expect(page.getByRole("tab", { name: /build-runner-03/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /staging-web/ })).toBeVisible();
});

test("Enter on a selection opens it in one tab, split", async ({ page }) => {
  await openHosts(page);
  await nameButton(page, "build-runner-03").click();
  await nameButton(page, "edge-cache").click({ modifiers: ["ControlOrMeta"] });
  await nameButton(page, "staging-web").click({ modifiers: ["ControlOrMeta"] });
  await nameButton(page, "staging-web").focus();
  await page.keyboard.press("Enter");
  const review = page.getByRole("dialog", { name: "Open 3 sessions?" });
  await review.getByText("In one tab, split").click();
  await expect(review).toContainText("side by side in one tab");
  await review.getByRole("button", { name: "Open 3 sessions" }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(3);
  await expect(page.getByRole("tab", { name: /\(3\)/ })).toHaveCount(1);
  await expect(page.locator(".workspace:not([hidden]) .pane, .pane:not([hidden])")).toHaveCount(3);
});

test("the selection bar and the host menu connect the selection; production hosts are confirmed first", async ({ page }) => {
  await openHosts(page);
  await nameButton(page, "api-gateway").click();
  await nameButton(page, "build-runner-03").click({ modifiers: ["ControlOrMeta"] });
  await expect(bulkBar(page).getByRole("button", { name: "Connect 2 hosts" })).toBeVisible();
  await card(page, "build-runner-03").click({ button: "right", position: { x: 10, y: 10 } });
  await page.getByRole("menuitem", { name: "Connect 2 hosts" }).click();
  const review = page.getByRole("dialog", { name: "Open 2 sessions?" });
  await review.getByRole("button", { name: "Open 2 sessions" }).click();
  // api-gateway carries the production tag: the production question comes first, Cancel focused.
  const ask = page.getByRole("alertdialog", { name: "Connect to production hosts?" });
  await expect(ask.getByRole("listitem")).toHaveText(["Production api-gateway"]);
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);
  await review.getByRole("button", { name: "Open 2 sessions" }).click();
  await page.getByRole("alertdialog", { name: "Connect to production hosts?" }).getByRole("button", { name: "Connect" }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
});

test("opening more hosts than there are free panes is refused, also as one split tab", async ({ page }) => {
  // Production confirmations are covered above; the tag is off here.
  await openHosts(page, { productionTag: "" });
  // Twelve sessions open (six hosts, twice), so four more fit.
  for (let round = 0; round < 2; round++) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await list(page).locator(".host-open").first().focus();
    await page.keyboard.press("ControlOrMeta+a");
    await bulkBar(page).getByRole("button", { name: "Connect 6 hosts" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Open 6 sessions" }).click();
  }
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(12);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await list(page).locator(".host-open").first().focus();
  await page.keyboard.press("ControlOrMeta+a");
  await bulkBar(page).getByRole("button", { name: "Connect 6 hosts" }).click();
  const review = page.getByRole("dialog", { name: "Open 6 sessions?" });
  await review.getByText("In one tab, split").click();
  await expect(review.getByRole("alert")).toContainText("Only 4 more sessions can be open at once");
  await expect(review.getByRole("button", { name: "Open 6 sessions" })).toBeDisabled();
});

test("rows and cards have no Connect button: double-click or Enter connects, the menus keep Connect, Connect in split and Open in SFTP", async ({ page }) => {
  await openHosts(page);
  await expect(list(page).getByRole("button", { name: /^Connect/ })).toHaveCount(0);
  await page.getByRole("radiogroup", { name: "Layout" }).getByText("List").click();
  await expect(list(page).getByRole("button", { name: /^Connect/ })).toHaveCount(0);

  // The first few times, the name says how to connect.
  await expect(nameButton(page, "edge-cache")).toHaveAttribute("data-tooltip", "Double-click to connect");

  // Enter on a host that is not part of a selection connects to that host.
  await nameButton(page, "edge-cache").focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  await expect(page.getByRole("tab", { name: /edge-cache/ })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await list(page).getByRole("button", { name: "More actions for staging-web" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Connect", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open in SFTP" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Connect in split" }).click();
  // Beside the session in front: one tab, two panes.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
  await expect(page.getByRole("tab", { name: /\(2\)/ })).toHaveCount(1);
});

test("Space toggles, Cmd/Ctrl+Enter opens in a split, Shift+Enter in SFTP, and typing filters", async ({ page }) => {
  await openHosts(page, { productionTag: "" });
  await page.getByRole("radiogroup", { name: "Layout" }).getByText("List").click();
  await nameButton(page, "build-runner-03").focus();
  await page.keyboard.press("Space");
  // Cmd/Ctrl+arrow moves without changing the selection; Space adds the next host.
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await page.keyboard.press("Space");
  expect(await selectedLabels(page)).toEqual(["build-runner-03", "db-primary"]);
  await page.keyboard.press("Space");
  expect(await selectedLabels(page)).toEqual(["build-runner-03"]);
  await page.keyboard.press("Space");

  // Cmd/Ctrl+Enter on a selection: the review, with one split tab chosen.
  await page.keyboard.press("ControlOrMeta+Enter");
  const review = page.getByRole("dialog", { name: "Open 2 sessions?" });
  await expect(review.getByRole("radio", { name: "In one tab, split" })).toBeChecked();
  await review.getByRole("button", { name: "Cancel" }).click();

  // Shift+Enter: the selection's SSH hosts as locations of the SFTP tab.
  await nameButton(page, "db-primary").focus();
  await page.keyboard.press("Shift+Enter");
  const sftp = page.getByRole("region", { name: "SFTP file manager" });
  await expect(sftp).toBeVisible();
  const right = sftp.getByRole("region", { name: "Right pane", exact: true });
  await expect(right.getByRole("tab", { name: /^build-runner-03/ })).toHaveCount(1);
  await expect(right.getByRole("tab", { name: /^db-primary/ })).toHaveCount(1);

  // Typing on a host goes to the search field.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await nameButton(page, "api-gateway").focus();
  await page.keyboard.type("stag");
  await expect(page.getByRole("searchbox", { name: "Search hosts" })).toHaveValue("stag");
  await expect(page.getByRole("searchbox", { name: "Search hosts" })).toBeFocused();
  await expect(list(page).locator(".host-open")).toHaveText(["staging-web"]);
});

test("no checkboxes; from two selected hosts a one-line strip offers Connect, Open in SFTP, Move, tags, Delete and Clear", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("radiogroup", { name: "Layout" }).getByText("List").click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await nameButton(page, "api-gateway").click();
  await expect(bulkBar(page)).toHaveCount(0);
  await nameButton(page, "edge-cache").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  const bar = bulkBar(page);
  for (const name of ["Connect 2 hosts", "Open 2 in SFTP", "Move to group", "Add tag", "Remove tag", "Delete"]) {
    await expect(bar.getByRole("button", { name })).toBeVisible();
  }
  // One line.
  const height = await bar.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeLessThan(48);
  // Selected rows: the tint and the accent edge on the left.
  await expect(list(page).locator('li[data-selected="true"]').first()).toHaveCSS("box-shadow", /inset/);
  await expect(bar).toContainText("Clear");

  await bar.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("2");
  expect(await calls(page, "host_bulk")).toHaveLength(0);
});

test("Home rows: no Connect button; a click selects, double-click or Enter connects", async ({ page }) => {
  await openApp(page);
  const hostsTable = page.locator("table.home-hosts");
  await expect(hostsTable.getByRole("button", { name: /^Connect/ })).toHaveCount(0);
  const name = hostsTable.getByRole("button", { name: "api-gateway", exact: true });
  await name.click();
  await expect(hostsTable.locator("tr.is-selected")).toContainText("api-gateway");
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);
  await name.dblclick();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Home" }).click();
  await hostsTable.getByRole("button", { name: "build-runner-03", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
});

test("palette: Enter connects a host, Cmd/Ctrl+Enter beside the session in front", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("edge-cache");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("staging-web");
  await expect(page.locator(".palette-foot")).toContainText("split");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
  await expect(page.getByRole("tab", { name: /\(2\)/ })).toHaveCount(1);
});

test("arrow keys move the selection and Host details follow it; Home and End jump to the ends", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("radiogroup", { name: "Layout" }).getByText("List").click();
  await nameButton(page, "build-runner-03").focus();
  const details = page.getByRole("complementary", { name: "Host details" });
  await page.keyboard.press("ArrowDown");
  await expect(nameButton(page, "db-primary")).toBeFocused();
  await expect(details.getByLabel("Name", { exact: true })).toHaveValue("db-primary");
  await page.keyboard.press("End");
  await expect(nameButton(page, "staging-web")).toBeFocused();
  await expect(details.getByLabel("Name", { exact: true })).toHaveValue("staging-web");
  await page.keyboard.press("Home");
  await expect(nameButton(page, "api-gateway")).toBeFocused();
  expect(await selectedLabels(page)).toEqual(["api-gateway"]);
  await expect(details.getByLabel("Name", { exact: true })).toHaveValue("api-gateway");
});

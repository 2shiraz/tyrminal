// Several SFTP locations at once (location tabs per pane) and "Open in SFTP" from a host, the
// palette, Host details and a session's Files panel, against the test-only mock backend. Two
// files-only connections open at once against OpenSSH, with a copy between them, are tested in
// crates/core/tests/sessions_lab.rs.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

type Call = { cmd: string; args: Record<string, unknown> };
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __mockCalls: Call[] }).__mockCalls);
const count = async (page: Page, cmd: string) => (await calls(page)).filter((c) => c.cmd === cmd).length;
const fileSessions = (page: Page) => page.evaluate(() => (window as unknown as { __mockFileSessions: { sessionId: string; host: string }[] }).__mockFileSessions);

const view = (page: Page) => page.getByRole("region", { name: "SFTP file manager" });
const left = (page: Page) => view(page).getByRole("region", { name: "Left pane", exact: true });
const right = (page: Page) => view(page).getByRole("region", { name: "Right pane", exact: true });
const table = (pane: ReturnType<typeof left>) => pane.getByRole("grid", { name: /^Contents of / });
const tabs = (pane: ReturnType<typeof left>) => pane.getByRole("tablist").getByRole("tab");
const tab = (pane: ReturnType<typeof left>, name: string) => pane.getByRole("tab", { name: new RegExp(`^${name}`) });
/** The × on a location tab (pointer only; the keyboard uses Delete on the tab). */
const closeX = (pane: ReturnType<typeof left>, name: string) => pane.locator(`.sftp-tab-close[title="Close ${name}"]`);

async function openSftp(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
  await page.keyboard.press("Enter");
  await expect(view(page)).toBeVisible();
}

async function addLocation(pane: ReturnType<typeof left>, host: string) {
  await pane.getByRole("button", { name: "Add location" }).click();
  await pane.getByRole("group", { name: "Select host" }).getByRole("button", { name: new RegExp(`^${host}`) }).click();
  await expect(table(pane)).toHaveAccessibleName(new RegExp(`on ${host}$`));
}

test("sftp locations: several servers in one pane, switched without reconnecting or listing again", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  const pane = right(page);
  await pane.getByRole("group", { name: "Select host" }).getByRole("button", { name: /^api-gateway/ }).click();
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  await table(pane).getByRole("button", { name: "Open app" }).dblclick();
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");

  // A second and a third server in the same pane, each its own files-only connection.
  await addLocation(pane, "db-primary");
  await addLocation(pane, "build-runner-03");
  await expect(tabs(pane)).toHaveText([/api-gateway/, /db-primary/, /build-runner-03/]);
  await expect(tab(pane, "build-runner-03")).toHaveAttribute("aria-selected", "true");
  await expect(tab(pane, "api-gateway").getByRole("img", { name: "Connected" })).toBeVisible();
  expect((await fileSessions(page)).map((s) => s.host)).toEqual(["api-gateway", "db-primary", "build-runner-03"]);

  // Back to the first: same folder, nothing reconnected or listed again.
  const opened = await count(page, "session_open_files");
  const listed = await count(page, "files_list");
  await tab(pane, "api-gateway").click();
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await pane.getByRole("button", { name: "Back" }).click();
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  // Arrow keys move between location tabs.
  await tab(pane, "api-gateway").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(pane, "db-primary")).toHaveAttribute("aria-selected", "true");
  await expect(tab(pane, "db-primary")).toBeFocused();
  expect(await count(page, "session_open_files")).toBe(opened);
  expect(await count(page, "files_list")).toBe(listed + 1);

  // Closing a location closes its connection only.
  const db = (await fileSessions(page)).find((s) => s.host === "db-primary")?.sessionId;
  await closeX(pane, "db-primary").click();
  await expect(tabs(pane)).toHaveText([/api-gateway/, /build-runner-03/]);
  await expect.poll(async () => (await calls(page)).filter((c) => c.cmd === "session_close").map((c) => c.args.sessionId)).toEqual([db]);

  // A dropped connection says so on its tab, and its location offers Reconnect.
  await page.evaluate(() => (window as unknown as { __mockDrop: () => void }).__mockDrop());
  await expect(tab(pane, "build-runner-03").getByRole("img", { name: "Disconnected" })).toBeVisible();
  await tab(pane, "build-runner-03").click();
  await expect(pane.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await tab(pane, "api-gateway").click();
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
});

test("sftp locations: at most eight per pane, and the last one closes into the host picker", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  const pane = left(page);
  for (let i = 0; i < 7; i += 1) await pane.getByRole("button", { name: "Add location" }).click();
  await expect(tabs(pane)).toHaveCount(8);
  await expect(pane.getByRole("button", { name: /^8 locations are open/ })).toBeDisabled();
  // × closes one; Delete on a focused tab closes it too.
  await pane.locator(".sftp-tab-close").first().click();
  for (let i = 0; i < 7; i += 1) {
    await expect(tabs(pane)).toHaveCount(7 - i);
    await tabs(pane).first().focus();
    await page.keyboard.press("Delete");
  }
  await expect(tabs(pane)).toHaveText([/New location/]);
  await expect(pane.getByRole("heading", { name: "Connect to host" })).toBeVisible();
});

test("sftp locations: copy between servers in different panes, and closing the tab closes every connection", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await right(page).getByRole("group", { name: "Select host" }).getByRole("button", { name: /^api-gateway/ }).click();
  await addLocation(left(page), "build-runner-03");
  await addLocation(right(page), "db-primary");
  // Right pane shows db-primary now: a copy from build-runner-03 goes there, server to server.
  await table(left(page)).getByRole("button", { name: "Select deploy.sh" }).click();
  await page.keyboard.press("F5");
  await page.getByRole("alertdialog", { name: "Replace “deploy.sh”?" }).getByRole("button", { name: "Keep both" }).click();
  const copy = (await calls(page)).filter((c) => c.cmd === "files_copy").at(-1);
  const sessions = await fileSessions(page);
  expect(copy?.args.srcSession).toBe(sessions.find((s) => s.host === "build-runner-03")?.sessionId);
  expect(copy?.args.dstSession).toBe(sessions.find((s) => s.host === "db-primary")?.sessionId);

  await page.getByRole("tab", { name: /^SFTP/ }).click({ button: "middle" });
  await expect(view(page)).toHaveCount(0);
  await expect
    .poll(async () => (await calls(page)).filter((c) => c.cmd === "session_close").map((c) => c.args.sessionId).sort())
    .toEqual(sessions.map((s) => s.sessionId).sort());
});

test("open in SFTP: from a host's menu, the palette and Host details, into one SFTP tab", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "More actions for api-gateway" }).first().click();
  await page.getByRole("menuitem", { name: "Open in SFTP" }).click();
  await expect(view(page)).toBeVisible();
  await expect(tab(right(page), "api-gateway")).toHaveAttribute("aria-selected", "true");
  await expect(table(right(page))).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  await expect(right(page)).toHaveAttribute("data-active", "true");

  // The palette: the same SFTP tab, a new location in its right pane.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP: db");
  await page.getByRole("option", { name: /^SFTP: db-primary/ }).click();
  await expect(page.getByRole("tab", { name: /SFTP/ })).toHaveCount(1);
  // The new tab's empty location was used for the first host; the second host is added beside it.
  await expect(tabs(right(page))).toHaveText([/api-gateway/, /db-primary/]);
  await expect(tab(right(page), "db-primary")).toHaveAttribute("aria-selected", "true");

  // Again for a host already open: its location is shown, not a second one.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP: api");
  await page.getByRole("option", { name: /^SFTP: api-gateway/ }).click();
  await expect(tab(right(page), "api-gateway")).toHaveAttribute("aria-selected", "true");
  await expect(tabs(right(page))).toHaveCount(2);
  expect((await fileSessions(page)).map((s) => s.host)).toEqual(["api-gateway", "db-primary"]);

  // Host details: its menu has Open in SFTP too (only SSH hosts offer it).
  await page.getByRole("tab", { name: /^(Home|Hosts)$/ }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "More actions for build-runner-03" }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Host details actions" }).click();
  await page.getByRole("menuitem", { name: "Open in SFTP" }).click();
  await expect(tab(right(page), "build-runner-03")).toHaveAttribute("aria-selected", "true");
});

test("open in SFTP: a session's Files panel opens its host at the folder shown", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.keyboard.press("Control+Shift+O");
  const panel = page.getByRole("complementary", { name: "Files" });
  await panel.getByRole("grid").getByRole("button", { name: "Open app" }).dblclick();
  await expect(panel.getByRole("grid")).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await panel.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open in SFTP tab" }).click();
  await expect(view(page)).toBeVisible();
  await expect(table(right(page))).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  // Its own files-only connection: the terminal's session is not shared.
  expect((await fileSessions(page)).map((s) => s.host)).toEqual(["api-gateway"]);
});

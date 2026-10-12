// The SFTP tab against the test-only mock backend. Files-only connections against OpenSSH (no
// shell or PTY, changed host keys refused before sign-in) are tested in
// crates/core/tests/sessions_lab.rs.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

type Call = { cmd: string; args: Record<string, unknown> };
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __mockCalls: Call[] }).__mockCalls);
const finishLatest = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __mockTransfers: Map<string, { finish(): void }> };
    [...w.__mockTransfers.values()].at(-1)?.finish();
  });

const view = (page: Page) => page.getByRole("region", { name: "SFTP file manager" });
const left = (page: Page) => view(page).getByRole("region", { name: "Left pane" });
const right = (page: Page) => view(page).getByRole("region", { name: "Right pane" });
const table = (pane: ReturnType<typeof left>) => pane.getByRole("grid", { name: /^Contents of / });

async function openSftp(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
  await page.keyboard.press("Enter");
  await expect(view(page)).toBeVisible();
}

async function connectRight(page: Page, host: string) {
  await right(page).getByRole("group", { name: "Select host" }).getByRole("button", { name: new RegExp(`^${host}`) }).click();
}

async function chooseLocal(page: Page) {
  await left(page).getByRole("button", { name: "Choose folder…" }).click();
  await expect(table(left(page))).toBeVisible();
}

test("sftp: opens from the palette with this computer on the left and a host picker on the right", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await expect(page.getByRole("tab", { name: /SFTP/ })).toBeVisible();
  await expect(left(page).getByRole("button", { name: "Location: This computer" })).toBeVisible();
  await expect(left(page)).toContainText("Choose a folder on this computer");
  await expect(right(page).getByRole("heading", { name: "Connect to host" })).toBeVisible();
  // Only SSH hosts can be picked, and "This computer" is offered too.
  const picker = right(page).getByRole("group", { name: "Select host" });
  await expect(picker.getByRole("button", { name: /^This computer/ })).toBeVisible();
  await expect(picker.getByRole("button", { name: /^api-gateway/ })).toBeVisible();

  await connectRight(page, "api-gateway");
  await expect(right(page).getByRole("button", { name: "Location: api-gateway" })).toBeVisible();
  const remote = table(right(page));
  await expect(remote).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  // A files-only connection: no terminal session was opened and nothing was typed anywhere.
  const all = await calls(page);
  expect(all.filter((c) => c.cmd === "session_open_files")).toHaveLength(1);
  expect(all.filter((c) => c.cmd === "session_open_ssh" || c.cmd === "session_write" || c.cmd === "session_resize")).toHaveLength(0);
  // Columns, folders first, permissions in their own column.
  await expect(remote.getByRole("columnheader")).toHaveText(["Name", "Date Modified", "Size", "Permissions"]);
  await expect(remote.getByRole("button", { name: /^(Open|Select) / })).toHaveText([/app/, /logs/, /backup\.tar\.gz/, /deploy\.sh/, /README\.md/]);
  await expect(remote.getByRole("row", { name: /deploy\.sh/ })).toContainText("-rwxr-xr-x");
  await expect(remote.getByRole("row", { name: /backup\.tar\.gz/ })).toContainText("700 MB");
});

test("sftp: sorting, filter, breadcrumbs and back/forward in a pane", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await connectRight(page, "api-gateway");
  const pane = right(page);
  const remote = table(pane);
  await expect(remote).toBeVisible();

  // Size, descending: folders stay first.
  await pane.getByRole("button", { name: "Sort by Size" }).click();
  await pane.getByRole("button", { name: "Sort by Size" }).click();
  await expect(pane.getByRole("columnheader", { name: /Size/ })).toHaveAttribute("aria-sort", "descending");
  await expect(remote.getByRole("button", { name: /^Select / })).toHaveText([/backup\.tar\.gz/, /README\.md|deploy\.sh/, /README\.md|deploy\.sh/]);

  await pane.getByRole("searchbox", { name: "Filter" }).fill("READ");
  await expect(remote.getByRole("button", { name: /^(Open|Select) / })).toHaveText([/README\.md/]);
  await pane.getByRole("searchbox", { name: "Filter" }).fill("");

  await remote.getByRole("button", { name: "Open app" }).press("Enter");
  await expect(remote).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  const crumbs = pane.getByRole("navigation", { name: "Folder path" });
  await expect(crumbs.getByRole("listitem")).toHaveText(["/", "home", "deploy", "app"]);
  await crumbs.getByRole("button", { name: "home" }).click();
  await expect(remote).toHaveAccessibleName("Contents of /home on api-gateway");
  await pane.getByRole("button", { name: "Back" }).click();
  await expect(remote).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await pane.getByRole("button", { name: "Forward" }).click();
  await expect(remote).toHaveAccessibleName("Contents of /home on api-gateway");
  await pane.getByRole("button", { name: "Up one folder" }).click();
  await expect(remote).toHaveAccessibleName("Contents of / on api-gateway");
  await expect(pane.getByRole("button", { name: "Up one folder" })).toBeDisabled();
});

test("sftp: the pane and row menus create, rename in place, change permissions and delete with confirmation", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await connectRight(page, "api-gateway");
  const pane = right(page);
  const remote = table(pane);
  const actions = () => pane.getByRole("button", { name: "Actions for the right pane" }).click();

  await actions();
  await page.getByRole("menuitemcheckbox", { name: "Show hidden files" }).click();
  await expect(remote.getByRole("button", { name: "Select .bashrc" })).toBeVisible();

  await actions();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByRole("dialog", { name: "New folder" }).getByRole("textbox", { name: "Name" }).fill("releases");
  await page.getByRole("dialog", { name: "New folder" }).getByRole("button", { name: "Create" }).click();
  await expect(remote.getByRole("button", { name: "Open releases" })).toBeVisible();

  await remote.getByRole("button", { name: "Select README.md" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await remote.getByRole("textbox", { name: "New name for README.md" }).fill("NOTES.md");
  await page.keyboard.press("Enter");
  await expect(remote.getByRole("row", { name: /NOTES\.md/ })).toHaveAttribute("aria-selected", "true");
  // The right pane's controls (and their tooltips) stay inside the window.
  expect(await page.locator("main.content").evaluate((el) => [el.scrollWidth - el.clientWidth, el.scrollLeft])).toEqual([0, 0]);

  await remote.getByRole("button", { name: "Select NOTES.md" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Permissions…" }).click();
  const perms = page.getByRole("dialog", { name: "Permissions of “NOTES.md”" });
  await perms.getByRole("textbox", { name: "Mode (octal)" }).fill("9");
  await perms.getByRole("button", { name: "Save" }).click();
  await expect(perms).toContainText("three or four octal digits");
  await perms.getByRole("textbox", { name: "Mode (octal)" }).fill("600");
  await perms.getByRole("button", { name: "Save" }).click();
  await expect(remote.getByRole("row", { name: /NOTES\.md/ })).toContainText("-rw-------");

  // Delete asks first; Cancel has focus and keeps the file.
  await remote.getByRole("button", { name: "Select NOTES.md" }).click();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("alertdialog", { name: "Delete “NOTES.md”?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(remote.getByRole("button", { name: "Select NOTES.md" })).toBeVisible();
  await remote.getByRole("button", { name: "Select NOTES.md" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(remote.getByRole("button", { name: "Select NOTES.md" })).toHaveCount(0);
});

test("sftp: dragging between panes transfers through the queue and asks before replacing", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await chooseLocal(page);
  await connectRight(page, "api-gateway");
  const local = table(left(page));
  const remote = table(right(page));
  await expect(remote).toBeVisible();
  const transfers = view(page).getByRole("region", { name: "Transfers" });

  // This computer → server.
  await local.getByRole("button", { name: "Select notes.md" }).dragTo(right(page).locator(".sftp-body"));
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done");
  await expect(remote.getByRole("button", { name: "Select notes.md" })).toBeVisible();

  // Again: the name exists, so it asks. Keep both.
  await local.getByRole("button", { name: "Select notes.md" }).dragTo(right(page).locator(".sftp-body"));
  const replace = page.getByRole("alertdialog", { name: "Replace “notes.md”?" });
  await expect(replace).toContainText("already in this folder on the server");
  await expect(replace.getByRole("button", { name: "Cancel" })).toBeFocused();
  await replace.getByRole("button", { name: "Keep both" }).click();
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(1)).toHaveText("Done");

  // Server → this computer, by the row menu; the local pane lists again.
  await remote.getByRole("button", { name: "Select README.md" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy to This computer" }).click();
  await finishLatest(page);
  await expect(local.getByRole("button", { name: "Select README.md" })).toBeVisible();
  // And by F5, the two-pane convention.
  await remote.getByRole("button", { name: "Select deploy.sh" }).click();
  await page.keyboard.press("F5");
  await finishLatest(page);
  await expect(local.getByRole("button", { name: "Select deploy.sh" })).toBeVisible();
  const upload = (await calls(page)).find((c) => c.cmd === "files_upload");
  expect(upload?.args.path).toEqual(["notes.md"]);
});

test("sftp: both panes can be hosts, and a copy between them runs server to server", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await connectRight(page, "api-gateway");
  await left(page).getByRole("button", { name: "Location: This computer" }).click();
  await page.getByRole("menuitem", { name: "build-runner-03" }).click();
  await expect(left(page).getByRole("button", { name: "Location: build-runner-03" })).toBeVisible();
  await expect(table(left(page))).toBeVisible();
  await expect(table(right(page))).toBeVisible();

  await table(left(page)).getByRole("button", { name: "Select deploy.sh" }).dragTo(right(page).locator(".sftp-body"));
  await page.getByRole("alertdialog", { name: "Replace “deploy.sh”?" }).getByRole("button", { name: "Replace" }).click();
  const copy = (await calls(page)).filter((c) => c.cmd === "files_copy").at(-1);
  expect(copy?.args.choice).toBe("replace");
  const sessions = await page.evaluate(() => (window as unknown as { __mockFileSessions: { sessionId: string; host: string }[] }).__mockFileSessions);
  expect(copy?.args.srcSession).toBe(sessions.find((s) => s.host === "build-runner-03")?.sessionId);
  expect(copy?.args.dstSession).toBe(sessions.find((s) => s.host === "api-gateway")?.sessionId);
});

test("sftp: the host key is checked as for a terminal; a changed key is refused", async ({ page }) => {
  await openApp(page, { trustPromptFor: "api-gateway", hostKeyChangedFor: "build-runner-03" });
  await openSftp(page);
  await connectRight(page, "api-gateway");
  const trust = page.getByRole("alertdialog", { name: "Verify this server before connecting" });
  await expect(trust).toContainText("SHA256");
  // The safe choice has focus; refusing ends the attempt.
  await expect(trust.getByRole("button", { name: "Do not connect" })).toBeFocused();
  await trust.getByRole("button", { name: "Trust once" }).click();
  await expect(table(right(page))).toBeVisible();

  await left(page).getByRole("button", { name: "Location: This computer" }).click();
  await page.getByRole("menuitem", { name: "build-runner-03" }).click();
  const alert = left(page).getByRole("alert");
  await expect(alert).toContainText("The host's identity changed");
  await expect(alert.getByRole("button", { name: "Open Known hosts" })).toBeVisible();
  await expect(table(left(page))).toHaveCount(0);
});

test("sftp: a password is asked for in a dialog and the session closes with the tab", async ({ page }) => {
  await openApp(page, { passwordPromptFor: "db-primary" });
  await openSftp(page);
  await connectRight(page, "db-primary");
  const dialog = page.getByRole("dialog", { name: "Password for postgres" });
  await dialog.getByLabel("Password").fill("not-a-real-password");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(table(right(page))).toBeVisible();
  const answer = (await calls(page)).find((c) => c.cmd === "session_auth_answer");
  expect(answer).toBeTruthy();

  const opened = (await page.evaluate(() => (window as unknown as { __mockFileSessions: { sessionId: string }[] }).__mockFileSessions)).at(-1);
  await page.getByRole("tab", { name: /SFTP/ }).hover();
  await page.getByRole("button", { name: "Close SFTP" }).click();
  await expect(view(page)).toHaveCount(0);
  await expect.poll(async () => (await calls(page)).some((c) => c.cmd === "session_close" && c.args.sessionId === opened?.sessionId)).toBe(true);
});

test("sftp: switching to another tab and back keeps both panes without listing again", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await chooseLocal(page);
  await connectRight(page, "api-gateway");
  await table(right(page)).getByRole("button", { name: "Open app" }).dblclick();
  await expect(table(right(page))).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  const lists = async () => (await calls(page)).filter((c) => c.cmd === "files_list" || c.cmd === "files_local_list").length;
  const before = await lists();

  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Local terminal");
  await page.keyboard.press("Enter");
  await expect(view(page)).toBeHidden();
  await page.getByRole("tab", { name: /SFTP/ }).click();
  await expect(table(right(page))).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await expect(table(left(page))).toBeVisible();
  expect(await lists()).toBe(before);
});

test("sftp: the local pane changes only inside the chosen folder", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await chooseLocal(page);
  const pane = left(page);
  const local = table(pane);
  await expect(local).toHaveAccessibleName("Contents of Projects on this computer");
  await pane.getByRole("button", { name: "Actions for the left pane" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByRole("dialog", { name: "New folder" }).getByRole("textbox", { name: "Name" }).fill("drafts");
  await page.getByRole("dialog", { name: "New folder" }).getByRole("button", { name: "Create" }).click();
  await expect(local.getByRole("button", { name: "Open drafts" })).toBeVisible();
  const mkdir = (await calls(page)).find((c) => c.cmd === "files_local_mkdir");
  expect(mkdir?.args).toMatchObject({ path: [], name: "drafts" });
  expect(typeof mkdir?.args.token).toBe("string");

  // A folder with something in it is not deleted.
  await local.getByRole("button", { name: "Open photos" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete “photos”?" });
  await expect(confirm).toContainText("removed from this computer");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toContainText("Only an empty folder can be deleted.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(local.getByRole("button", { name: "Open photos" })).toBeVisible();

  // Both panes on this computer: copying is left to the file manager.
  await right(page).getByRole("group", { name: "Select host" }).getByRole("button", { name: /^This computer/ }).click();
  await right(page).getByRole("button", { name: "Choose folder…" }).click();
  await local.getByRole("button", { name: "Select notes.md" }).dragTo(right(page).locator(".sftp-body"));
  await expect(view(page)).toContainText("Copying within this computer is done in your file manager.");
});

test("sftp: a click visibly selects, multi-select and keys work, and opening a folder shows it is loading", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await connectRight(page, "api-gateway");
  const pane = right(page);
  const remote = table(pane);
  const row = (name: RegExp) => remote.getByRole("row", { name });
  const footer = pane.getByRole("status", { name: "Selection" });
  await expect(footer).toHaveText("5 items");

  await remote.getByRole("button", { name: "Select README.md" }).click();
  await expect(row(/README\.md/)).toHaveAttribute("aria-selected", "true");
  await expect(row(/README\.md/)).toHaveClass(/is-selected/);
  await pane.getByRole("searchbox", { name: "Filter" }).focus();
  await expect(row(/README\.md/)).toHaveClass(/is-selected/);
  await expect(footer).toHaveText("1 selected · 5.0 KB");

  await remote.getByRole("button", { name: "Select deploy.sh" }).hover();
  await page.mouse.down();
  await expect(row(/deploy\.sh/)).toHaveAttribute("data-pressed", "true");
  await page.mouse.up();

  await remote.getByRole("button", { name: "Select README.md" }).click();
  await remote.getByRole("button", { name: "Select deploy.sh" }).click({ modifiers: ["ControlOrMeta"] });
  await expect(footer).toHaveText(/^2 selected/);
  await remote.getByRole("button", { name: "Open app" }).click({ modifiers: ["Shift"] });
  // The anchor moved to deploy.sh with the Ctrl click: the range runs from there up to app.
  await expect(remote.locator('tr[aria-selected="true"]')).toHaveCount(4);

  // Several items: one confirmation names how many.
  await remote.getByRole("button", { name: "Select README.md" }).click();
  await remote.getByRole("button", { name: "Select deploy.sh" }).click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alertdialog", { name: "Delete 2 items?" })).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  // Keys: arrows move the selection with focus; Enter on a folder opens it.
  await remote.getByRole("button", { name: "Select backup.tar.gz" }).click();
  await page.keyboard.press("ArrowUp");
  await expect(row(/Open logs/)).toHaveAttribute("aria-selected", "true");
  await expect(remote.getByRole("button", { name: "Open logs" })).toBeFocused();

  await page.evaluate(() => {
    (window as unknown as { __mockListDelay: number }).__mockListDelay = 900;
  });
  await page.keyboard.press("Enter");
  await expect(row(/Open logs/)).toHaveAttribute("data-loading", "true");
  await expect(pane.getByRole("navigation", { name: "Folder path" })).toHaveAttribute("aria-busy", "true");
  await expect(pane.getByRole("navigation", { name: "Folder path" })).toContainText("logs");
  await expect(pane.getByRole("progressbar", { name: "Opening folder" })).toBeVisible();
  await expect(remote).toHaveAccessibleName("Contents of /home/deploy/logs on api-gateway");
  await expect(pane.getByRole("progressbar")).toHaveCount(0);
});

test("sftp: the pane in use is marked, Swap exchanges sides without reconnecting, and a server path can be typed", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await chooseLocal(page);
  await connectRight(page, "api-gateway");
  const remote = table(right(page));
  await expect(remote).toBeVisible();

  // The pane last used is the active one; the other keeps its selection in grey.
  await table(left(page)).getByRole("button", { name: "Select notes.md" }).click();
  await expect(left(page)).toHaveAttribute("data-active", "true");
  await expect(right(page)).not.toHaveAttribute("data-active", "true");
  await remote.getByRole("button", { name: "Select README.md" }).click();
  await expect(right(page)).toHaveAttribute("data-active", "true");
  await expect(left(page)).not.toHaveAttribute("data-active", "true");
  await expect(left(page).locator(".ft")).toHaveAttribute("data-inactive", "true");
  await expect(table(left(page)).getByRole("row", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");

  // Swap: the host moves to the left and keeps its connection, folder and selection.
  const opened = (await calls(page)).filter((c) => c.cmd === "session_open_files").length;
  await view(page).getByRole("button", { name: "Swap panes" }).click();
  await expect(left(page).getByRole("button", { name: "Location: api-gateway" })).toBeVisible();
  await expect(right(page).getByRole("button", { name: "Location: This computer" })).toBeVisible();
  await expect(table(left(page)).getByRole("row", { name: /README\.md/ })).toHaveAttribute("aria-selected", "true");
  expect((await calls(page)).filter((c) => c.cmd === "session_open_files")).toHaveLength(opened);
  expect((await calls(page)).filter((c) => c.cmd === "session_close")).toHaveLength(0);
  // Keyboard order follows what is shown: the left pane comes first.
  const regions = await view(page).locator(".sftp-pane").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(regions).toEqual(["Left pane", "Right pane"]);

  // The server pane's path can be typed; the local one is breadcrumbs only.
  const pane = left(page);
  await pane.getByRole("button", { name: "Edit path" }).click();
  await pane.getByRole("textbox", { name: "Folder on the server" }).fill("/home/deploy/app");
  await page.keyboard.press("Enter");
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await expect(right(page).getByRole("button", { name: "Edit path" })).toHaveCount(0);
  // Back works across a typed path too.
  await pane.getByRole("button", { name: "Back" }).click();
  await expect(table(pane)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
});

test("sftp: the filter, an empty folder and a folder of hidden files each say what is going on", async ({ page }) => {
  await openApp(page);
  await openSftp(page);
  await connectRight(page, "api-gateway");
  const pane = right(page);
  await expect(table(pane)).toBeVisible();
  await pane.getByRole("searchbox", { name: "Filter" }).fill("zzz");
  await expect(pane).toContainText("Nothing here matches the filter.");
  await pane.getByRole("searchbox", { name: "Filter" }).fill("");
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    fs.set("/home/deploy/cfg", { kind: "dir", size: null, permissions: 0o755, modified: 0 });
    fs.set("/home/deploy/cfg/.env", { kind: "file", size: 3, permissions: 0o600, modified: 0 });
    fs.set("/home/deploy/none", { kind: "dir", size: null, permissions: 0o755, modified: 0 });
  });
  await pane.getByRole("button", { name: "Refresh" }).click();
  await table(pane).getByRole("button", { name: "Open cfg" }).dblclick();
  await expect(pane).toContainText("1 hidden item.");
  await pane.locator(".ft-state").getByRole("button", { name: "Show hidden files" }).click();
  await expect(table(pane).getByRole("button", { name: "Select .env" })).toBeVisible();
  await pane.getByRole("button", { name: "Up one folder" }).click();
  await table(pane).getByRole("button", { name: "Open none" }).dblclick();
  await expect(pane).toContainText("This folder is empty");
});

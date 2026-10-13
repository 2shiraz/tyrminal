// The files (SFTP) panel against the test-only mock backend. Real transfers, conflicts and
// cancellation against OpenSSH are tested in crates/core/tests/sessions_lab.rs.
import { type Page, expect, test } from "@playwright/test";

import { uiModifier, openApp } from "./fixtures";

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Files" });
const list = (page: Page) => panel(page).getByRole("grid", { name: /^Contents of \// });
/** The name buttons of the rows, in order (each row also has a "More actions" button). */
const names = (page: Page) => list(page).getByRole("button", { name: /^(Open|Select) / });
const menu = (page: Page) => page.getByRole("menu");
/** Lets the newest running mock transfer complete. */
const finishLatest = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __mockTransfers: Map<string, { finish(): void }> };
    [...w.__mockTransfers.values()].at(-1)?.finish();
  });

/** Opens a row's menu with a right-click on its name and chooses `item`. */
async function rowAction(page: Page, name: string, item: string) {
  await list(page).getByRole("button", { name: new RegExp(`^(Open|Select) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: item }).click();
}

/** Toolbar menus: Upload and "…" (More). */
async function toolbar(page: Page, button: "Upload" | "More", item: string) {
  await panel(page).getByRole("button", { name: button, exact: true }).first().click();
  await menu(page).getByRole(button === "Upload" ? "menuitem" : "menuitemcheckbox", { name: item }).click();
}

/** The server pane's scrolling body (drops land here). */
const body = (page: Page) => panel(page).getByRole("region", { name: /^Files on / }).locator(".fpane-body");

async function goTo(page: Page, path: string) {
  await panel(page).getByRole("button", { name: "Edit path" }).click();
  await panel(page).getByRole("textbox", { name: "Folder on the server" }).fill(path);
  await page.keyboard.press("Enter");
}

test("files: browse the login folder, hidden files on request, folders open and go up", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("status", { name: "Target" })).toHaveText("on api-gateway");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  await expect(panel(page).getByRole("navigation", { name: "Folder path" }).locator("[aria-current=location]")).toHaveText("deploy");
  // Folders first; dotfiles hidden until asked for. Sizes and octal modes in their columns.
  await expect(names(page)).toHaveText([/app/, /logs/, /backup\.tar\.gz/, /deploy\.sh/, /README\.md/]);
  // The panel is narrow: permissions give way first and stay in the name's tooltip, with the
  // exact date; the date column says how long ago.
  await expect(list(page).getByRole("columnheader")).toHaveText(["Name", "Size", "Date Modified"]);
  await expect(list(page).getByRole("row", { name: /backup\.tar\.gz/ })).toContainText("700 MB");
  await expect(list(page).getByRole("row", { name: /deploy\.sh/ })).toContainText("1 h ago");
  await expect(list(page).getByRole("row", { name: /deploy\.sh/ }).locator(".ft-name-text")).toHaveAttribute("title", /^deploy\.sh\n-rwxr-xr-x\n2026-10-11 \d\d:00$/);
  await toolbar(page, "More", "Show hidden files");
  await expect(list(page).getByRole("button", { name: "Select .bashrc" })).toBeVisible();

  await list(page).getByRole("button", { name: "Open app" }).dblclick();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await expect(names(page)).toHaveText([/config\.yml/]);
  await panel(page).getByRole("button", { name: "Up one folder" }).click();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  // Going up selects the folder that was left.
  await expect(list(page).getByRole("row", { name: /Open app/ })).toHaveAttribute("aria-selected", "true");
  // A crumb goes there; typing a path goes there.
  await panel(page).getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "home" }).click();
  await expect(names(page)).toHaveText([/deploy/]);
  await goTo(page, "/home/deploy/logs");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/logs on api-gateway");

  // Server-supplied names are shown as text, control characters made visible.
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    fs.set("/home/\u001b[31mred", { kind: "file", size: 1, permissions: 0o644, modified: 0 });
  });
  await goTo(page, "/home");
  await expect(list(page)).toContainText("\\x1b[31mred");

  // Escape clears a selection first, then closes the panel; the shortcut toggles it.
  await names(page).first().click();
  await page.keyboard.press("Escape");
  await expect(list(page).locator('[aria-selected="true"]')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("files: the path can be typed, and Escape puts the breadcrumbs back", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  const crumbs = panel(page).getByRole("navigation", { name: "Folder path" });
  const field = panel(page).getByRole("textbox", { name: "Folder on the server" });
  await expect(field).toHaveCount(0);

  // Clicking the free space after the crumbs edits the full path, selected.
  await panel(page).getByRole("button", { name: "Edit path" }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("/home/deploy");
  expect(await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 12]);
  // Escape leaves without going anywhere (and does not close the panel).
  await field.fill("/nowhere");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(crumbs).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");

  // Ctrl+L from the list edits the path too; a folder that is not there says so and stays put.
  await names(page).first().click();
  await page.keyboard.press(`${uiModifier}+l`);
  await expect(field).toBeFocused();
  await field.fill("/nowhere");
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("alert")).toContainText("does not exist");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
});

test("files: squeezed breadcrumbs stay in their own place, and the path field shows only while editing", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await list(page).getByRole("button", { name: "Open app" }).dblclick();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  const bar = panel(page).locator(".pathbar");
  const field = panel(page).getByRole("textbox", { name: "Folder on the server" });
  // A narrow pane: the crumbs shrink, and none is drawn over its neighbour (it read "r/oot").
  await bar.evaluate((el) => {
    el.style.flex = "0 0 90px";
    el.style.maxWidth = "90px";
  });
  const spills = await bar.evaluate((el) =>
    [...el.querySelectorAll("li")].flatMap((li) => {
      const slot = li.getBoundingClientRect();
      const crumb = (li.firstElementChild as HTMLElement).getBoundingClientRect();
      const visible = Math.min(crumb.right, slot.right) - Math.max(crumb.left, slot.left);
      return getComputedStyle(li).overflow === "hidden" || visible >= crumb.width - 0.5 ? [] : [li.textContent];
    }),
  );
  expect(spills).toEqual([]);
  // Crumbs and the path field are never both there.
  await expect(field).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Edit path" }).click();
  await expect(field).toBeFocused();
  await expect(panel(page).getByRole("navigation", { name: "Folder path" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  // The free space that edits the path draws no box of its own.
  await panel(page).getByRole("button", { name: "Edit path" }).hover();
  await expect(panel(page).getByRole("button", { name: "Edit path" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("files: uploads and downloads show progress, never replace without asking, and can be cancelled", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  const transfers = panel(page).getByRole("region", { name: "Transfers" });

  await toolbar(page, "Upload", "Upload files…");
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("1.0 KB of 2.0 KB");
  await expect(transfers.getByRole("progressbar", { name: "notes.txt" })).toHaveAttribute("aria-valuenow", "50");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done");
  await expect(list(page).getByRole("button", { name: "Select notes.txt" })).toBeVisible();

  // The same name again asks first; Cancel leaves everything as it was.
  await toolbar(page, "Upload", "Upload files…");
  const replace = page.getByRole("alertdialog", { name: "Replace “notes.txt”?" });
  await expect(replace).toContainText("already in this folder on the server");
  await expect(replace.getByRole("button", { name: "Cancel" })).toBeFocused();
  await replace.getByRole("button", { name: "Cancel" }).click();
  await expect(transfers.getByRole("listitem")).toHaveCount(1);
  await toolbar(page, "Upload", "Upload files…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  await expect(transfers.getByRole("listitem")).toHaveCount(2);
  // Keep both uploads under the next free name instead.
  await toolbar(page, "Upload", "Upload files…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Keep both" }).click();
  await expect(transfers.getByRole("listitem").nth(2)).toContainText("notes (1).txt");
  await transfers.getByRole("button", { name: "Cancel notes (1).txt" }).click();

  // Cancel a running transfer.
  await transfers.getByRole("button", { name: "Cancel notes.txt" }).click();
  await expect(transfers.getByTestId("transfer-state").nth(1)).toHaveText("Cancelled");

  // Download from the row menu into a chosen folder; an existing local file needs confirmation.
  await rowAction(page, "README.md", "Download…");
  await expect(transfers.getByTestId("transfer-state").nth(3)).toHaveText("1.3 KB of 5.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(3)).toHaveText("Done");
  await rowAction(page, "README.md", "Download…");
  await expect(page.getByRole("alertdialog", { name: "Replace “README.md”?" })).toContainText("in the folder you chose");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  await transfers.getByRole("button", { name: "Clear finished" }).click();
  await expect(transfers).toHaveCount(0);
});

test("files: the transfer drawer sums up running transfers, shows the rate, and folds away", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  const transfers = panel(page).getByRole("region", { name: "Transfers" });

  await toolbar(page, "Upload", "Upload files…");
  await rowAction(page, "backup.tar.gz", "Download…");
  const toggle = transfers.getByRole("button", { name: "Hide transfers" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("2 running");
  // A second progress report gives a rate.
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const w = window as unknown as { __mockTransfers: Map<string, { progress(n: number): void }> };
    [...w.__mockTransfers.values()].at(-1)?.progress(400 * 1024 * 1024);
  });
  await expect(transfers.getByTestId("transfer-state").nth(1)).toHaveText(/^400 MB of 700 MB, [\d.]+ (KB|MB|GB)\/s$/);

  // Folded: one line and one bar for everything still running.
  await toggle.click();
  await expect(transfers.getByRole("button", { name: "Show transfers" })).toHaveAttribute("aria-expanded", "false");
  await expect(transfers.getByRole("listitem")).toHaveCount(0);
  await expect(transfers.getByRole("progressbar", { name: "Transfers" })).toBeVisible();
  await transfers.getByRole("button", { name: "Show transfers" }).click();

  // When everything has ended the summary says so.
  await page.evaluate(() => {
    const w = window as unknown as { __mockTransfers: Map<string, { finish(): void }> };
    for (const t of w.__mockTransfers.values()) t.finish();
  });
  await expect(transfers.getByRole("button", { name: "Hide transfers" })).toContainText("All finished");
  await expect(transfers.getByRole("progressbar")).toHaveCount(0);
});

test("files: new folder, inline rename, permissions and delete, with errors explained", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();

  await panel(page).getByRole("button", { name: "New folder" }).click();
  await page.getByRole("dialog", { name: "New folder" }).getByRole("textbox", { name: "Name" }).fill("releases");
  await page.keyboard.press("Enter");
  await expect(list(page).getByRole("button", { name: "Open releases" })).toBeVisible();

  // Rename in place (F2): the name without its extension is selected; an existing name is
  // refused with the reason under the field, which stays.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await page.keyboard.press("F2");
  const field = list(page).getByRole("textbox", { name: "New name for README.md" });
  await expect(field).toBeFocused();
  expect(await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 6]);
  await field.fill("deploy.sh");
  await page.keyboard.press("Enter");
  await expect(list(page).getByRole("alert")).toContainText("already there");
  await expect(field).toBeFocused();
  // Nothing in the panel (a tooltip at its edge, the error under the field) widens the
  // workspace, so focusing the field never shifts the window sideways.
  expect(await page.locator("main.content").evaluate((el) => [el.scrollWidth - el.clientWidth, el.scrollLeft])).toEqual([0, 0]);
  // Escape keeps the old name.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(list(page).getByRole("button", { name: "Select README.md" })).toBeFocused();
  // From the row menu; Enter saves and the renamed row stays selected.
  await rowAction(page, "README.md", "Rename");
  await field.fill("NOTES.md");
  await page.keyboard.press("Enter");
  await expect(list(page).getByRole("row", { name: /NOTES\.md/ })).toHaveAttribute("aria-selected", "true");

  // Permissions take octal digits only.
  await rowAction(page, "NOTES.md", "Permissions…");
  const perms = page.getByRole("dialog", { name: "Permissions of “NOTES.md”" });
  await expect(perms.getByRole("textbox", { name: "Mode (octal)" })).toHaveValue("644");
  await perms.getByRole("textbox", { name: "Mode (octal)" }).fill("999");
  await perms.getByRole("button", { name: "Save" }).click();
  await expect(perms).toContainText("Use three or four octal digits");
  await perms.getByRole("textbox", { name: "Mode (octal)" }).fill("600");
  await perms.getByRole("button", { name: "Save" }).click();
  await expect(list(page).getByRole("row", { name: /NOTES\.md/ }).locator(".ft-name-text")).toHaveAttribute("title", /-rw-------/);

  // Delete asks first (Cancel focused); Delete key works on the selection.
  await list(page).getByRole("button", { name: "Select NOTES.md" }).click();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("alertdialog", { name: "Delete “NOTES.md”?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(list(page).getByRole("button", { name: "Select NOTES.md" })).toHaveCount(0);

  // A folder with contents is not removed; the reason is shown.
  await rowAction(page, "app", "Delete…");
  await page.getByRole("alertdialog", { name: "Delete “app”?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("not be empty");
});

test("files: a local terminal has no files to show", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.locator(".statusbar").getByRole("button", { name: "Files" }).click();
  await expect(panel(page)).toContainText("Files work with a connected SSH session");
});

test("files: whole folders upload and download, report skipped links, and are never merged", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  const transfers = panel(page).getByRole("region", { name: "Transfers" });

  await toolbar(page, "Upload", "Upload folder…");
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("3.0 KB of 6.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done · 3 files, 1 link or special file skipped");
  await expect(list(page).getByRole("button", { name: "Open site" })).toBeVisible();

  // The same folder again is never merged or replaced; keeping both is the only offer.
  await toolbar(page, "Upload", "Upload folder…");
  const folderConflict = page.getByRole("alertdialog", { name: "Replace “site”?" });
  await expect(folderConflict).toContainText("never merged or replaced");
  await expect(folderConflict.getByRole("button", { name: "Replace" })).toHaveCount(0);
  await folderConflict.getByRole("button", { name: "Keep both" }).click();
  await finishLatest(page);
  await expect(list(page).getByRole("button", { name: "Open site (1)" })).toBeVisible();

  // Download the folder being shown.
  await list(page).getByRole("button", { name: "Open app" }).dblclick();
  await toolbar(page, "Upload", "Download this folder…");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(2)).toHaveText("Done");
  // At the root there is no folder above to download into.
  await goTo(page, "/");
  await panel(page).getByRole("button", { name: "Upload", exact: true }).click();
  await expect(menu(page).getByRole("menuitem", { name: "Download this folder…" })).toBeDisabled();
});

test("files: a file opened in an editor is saved only on request, and server changes are not overwritten silently", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await rowAction(page, "README.md", "Open in editor");
  const editing = panel(page).getByRole("region", { name: "Open in editors" });
  await expect(editing.getByTestId("edit-state")).toHaveText("No changes yet");
  await expect(editing.getByRole("button", { name: "Save README.md to the server" })).toBeDisabled();

  await page.evaluate(() => (window as unknown as { __mockEditLocalChange: (n: string) => void }).__mockEditLocalChange("README.md"));
  await expect(editing.getByTestId("edit-state")).toHaveText("Changed locally", { timeout: 5000 });
  await page.evaluate(() => (window as unknown as { __mockEditServerChange: (n: string) => void }).__mockEditServerChange("README.md"));
  await editing.getByRole("button", { name: "Save README.md to the server" }).click();
  const conflict = page.getByRole("alertdialog", { name: "“README.md” changed on the server" });
  await expect(conflict.getByRole("button", { name: "Cancel" })).toBeFocused();
  await conflict.getByRole("button", { name: "Cancel" }).click();
  await expect(editing.getByTestId("edit-state")).toHaveText("Changed locally");
  await editing.getByRole("button", { name: "Save README.md to the server" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace their changes" }).click();
  await expect(editing.getByTestId("edit-state")).toHaveText("Saved to the server");

  await editing.getByRole("button", { name: "Stop editing README.md" }).click();
  await expect(editing).toHaveCount(0);
});

test("files: two panes copy between this computer and the server by F5 or the menu and by drag and drop", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  await toolbar(page, "More", "Show this computer");
  const local = panel(page).getByRole("region", { name: "This computer" });
  await expect(local).toContainText("Choose a folder on this computer");
  await local.getByRole("button", { name: "Choose folder…" }).click();
  const localList = local.getByRole("grid", { name: /on this computer/ });
  await expect(localList.getByRole("button", { name: /^(Open|Select) / })).toHaveText([/photos/, /deploy\.tar\.gz/, /notes\.md/]);
  await expect(localList.getByRole("row", { name: /deploy\.tar\.gz/ })).toContainText("40 KB");
  const transfers = panel(page).getByRole("region", { name: "Transfers" });

  // F5: the local selection to the server folder shown.
  await localList.getByRole("button", { name: "Select notes.md" }).click();
  await page.keyboard.press("F5");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done");
  await expect(list(page).getByRole("button", { name: "Select notes.md" })).toBeVisible();

  // Row menu: a server file to the local folder shown; the local pane lists it.
  await rowAction(page, "README.md", "Copy to This computer");
  await finishLatest(page);
  await expect(localList.getByRole("button", { name: "Select README.md" })).toBeVisible();

  // Drag and drop: a local folder onto the server pane, which is marked as the drop target.
  await localList.getByRole("button", { name: "Open photos" }).dragTo(body(page));
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(2)).toHaveText("Done");
  await expect(list(page).getByRole("button", { name: "Open photos" })).toBeVisible();

  // Local navigation stays inside the chosen folder.
  await localList.getByRole("button", { name: "Open photos" }).dblclick();
  await expect(local.getByRole("navigation", { name: "Folder path" })).toHaveText(/Projects\s*\/?\s*photos/);
  await local.getByRole("button", { name: "Up one folder" }).click();
  await expect(local.getByRole("button", { name: "Up one folder" })).toBeDisabled();
});

test("files: copy to another server is offered with two SSH sessions and runs as a transfer", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  // With one SSH session there is nowhere to copy to.
  await list(page).getByRole("button", { name: "Select README.md" }).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Copy to another server…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await connect(page, "db-primary");
  await rowAction(page, "README.md", "Copy to another server…");
  const dialog = page.getByRole("dialog", { name: "Copy “README.md” to another server" });
  await expect(dialog.getByRole("combobox", { name: "Connected session" })).toHaveValue(/.+/);
  await expect(dialog.getByRole("combobox", { name: "Connected session" }).locator("option")).toHaveText(["api-gateway"]);
  await expect(dialog.getByRole("textbox", { name: "Folder on that server" })).toHaveValue("/home/deploy");
  await dialog.getByRole("button", { name: "Copy" }).click();
  // The destination already has README.md: never replaced silently.
  await page.getByRole("alertdialog", { name: "Replace “README.md”?" }).getByRole("button", { name: "Keep both" }).click();
  const transfers = panel(page).getByRole("region", { name: "Transfers" });
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("2.5 KB of 5.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done");
});

test("files: files dropped from the desktop upload in pieces and ask before replacing", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page).getByRole("button", { name: "Select README.md" })).toBeVisible();
  const drop = (files: { name: string; size: number }[]) =>
    body(page).evaluate((el, specs) => {
      const transfer = new DataTransfer();
      for (const s of specs) transfer.items.add(new File([new Uint8Array(s.size)], s.name));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, files);

  // 2.5 MiB arrives as three ordered pieces and then appears in the folder.
  await drop([{ name: "dump.sql", size: 2.5 * 1024 * 1024 }]);
  await expect(panel(page).getByRole("listitem").filter({ hasText: "dump.sql" }).last()).toContainText(/Done|2\.5 MB/);
  await expect(list(page).getByRole("button", { name: "Select dump.sql" })).toBeVisible();
  const pieces = await page.evaluate(() => (window as unknown as { __mockDropped: { name: string; bytes: number }[] }).__mockDropped);
  expect(pieces.map((p) => p.bytes)).toEqual([1048576, 1048576, 524288]);

  // An existing name asks first; Keep both uploads under the next free name.
  await drop([{ name: "README.md", size: 10 }]);
  const dialog = page.getByRole("alertdialog", { name: "Replace “README.md”?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Keep both/ }).click();
  await expect(list(page).getByRole("button", { name: "Select README (1).md" })).toBeVisible();
});

test("files: switching tabs keeps each session's folder, selection, options and scroll without listing again", async ({ page }) => {
  await openApp(page);
  // Enough entries for the list to scroll.
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    for (let i = 0; i < 80; i++) fs.set(`/home/deploy/app/log-${String(i).padStart(2, "0")}.txt`, { kind: "file", size: 10, permissions: 0o644, modified: 0 });
  });
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await list(page).getByRole("button", { name: "Open app" }).dblclick();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  await toolbar(page, "More", "Show hidden files");
  await panel(page).getByRole("button", { name: "Sort by Size" }).click();
  await list(page).getByRole("button", { name: "Select log-40.txt" }).click();
  await body(page).evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event("scroll"));
  });
  const scrolled = await body(page).evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  const hiddenOn = async () => {
    await panel(page).getByRole("button", { name: "More", exact: true }).click();
    const checked = await menu(page).getByRole("menuitemcheckbox", { name: "Show hidden files" }).getAttribute("aria-checked");
    await page.keyboard.press("Escape");
    return checked;
  };

  // Tab B: another session starts at its own login folder with its own options.
  await connect(page, "db-primary");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on db-primary");
  expect(await hiddenOn()).toBe("false");
  await expect(panel(page).getByRole("columnheader", { name: /Size/ })).toHaveAttribute("aria-sort", "none");

  const listCalls = () =>
    page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.filter((c) => c.cmd === "files_list").length);
  const before = await listCalls();

  // Back to tab A: same folder, selection, options and scroll, and nothing is listed again.
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await expect(panel(page).getByRole("status", { name: "Target" })).toHaveText("on api-gateway");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/app on api-gateway");
  expect(await hiddenOn()).toBe("true");
  await expect(panel(page).getByRole("columnheader", { name: /Size/ })).toHaveAttribute("aria-sort", "ascending");
  await expect(list(page).getByRole("row", { name: /log-40\.txt/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => body(page).evaluate((el) => el.scrollTop)).toBe(scrolled);
  // And back to B, which also kept its place.
  await page.getByRole("tab", { name: /db-primary/ }).click();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on db-primary");
  expect(await listCalls()).toBe(before);

  // Refresh is the way to list again.
  await panel(page).getByRole("button", { name: "Refresh" }).click();
  await expect.poll(listCalls).toBe(before + 1);
});

test("files: a click visibly selects, Shift/Ctrl extend it, keys move it, and opening a folder shows it is loading", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  const row = (name: RegExp) => list(page).getByRole("row", { name });
  const footer = panel(page).getByRole("status", { name: "Selection" });
  await expect(footer).toHaveText("5 items");

  // A click selects: aria-selected and the selected class, and it stays when focus leaves.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await expect(row(/README\.md/)).toHaveAttribute("aria-selected", "true");
  await expect(row(/README\.md/)).toHaveClass(/is-selected/);
  await panel(page).getByRole("button", { name: "Refresh" }).focus();
  await expect(row(/README\.md/)).toHaveClass(/is-selected/);
  await expect(footer).toHaveText("1 selected · 5.0 KB");

  // The pressed state appears on pointer down, before the click completes.
  const pressed = list(page).getByRole("button", { name: "Select deploy.sh" });
  await pressed.hover();
  await page.mouse.down();
  await expect(row(/deploy\.sh/)).toHaveAttribute("data-pressed", "true");
  await page.mouse.up();
  await expect(row(/deploy\.sh/)).not.toHaveAttribute("data-pressed", "true");

  // Ctrl adds, Shift takes a range; the footer counts them.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await list(page).getByRole("button", { name: "Select backup.tar.gz" }).click({ modifiers: [uiModifier] });
  await expect(footer).toHaveText(/^2 selected · 700 MB/);
  await list(page).getByRole("button", { name: "Open app" }).click();
  await list(page).getByRole("button", { name: "Select backup.tar.gz" }).click({ modifiers: ["Shift"] });
  await expect(list(page).locator('tr[aria-selected="true"]')).toHaveCount(3);
  await expect(footer).toHaveText(/^3 selected · 700 MB \+ folders$/);

  // Keyboard: arrows move, Space toggles, Home goes to the top, Ctrl+A takes everything.
  await list(page).getByRole("button", { name: "Select backup.tar.gz" }).click();
  await page.keyboard.press("ArrowDown");
  await expect(row(/deploy\.sh/)).toHaveAttribute("aria-selected", "true");
  await expect(list(page).getByRole("button", { name: "Select deploy.sh" })).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(footer).toHaveText(/^2 selected/);
  await page.keyboard.press("Space");
  await expect(footer).toHaveText(/^1 selected/);
  await page.keyboard.press("Home");
  await expect(row(/Open app/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(`${uiModifier}+a`);
  await expect(footer).toHaveText(/^5 selected/);

  // A click on the free space below the rows clears the selection.
  await body(page).locator(".ft").click({ position: { x: 100, y: 300 } });
  await expect(footer).toHaveText("5 items");

  // A folder that is slow to list: the row and the path show it at once, a bar after 300 ms.
  await page.evaluate(() => {
    (window as unknown as { __mockListDelay: number }).__mockListDelay = 900;
  });
  const path = panel(page).getByRole("navigation", { name: "Folder path" });
  await list(page).getByRole("button", { name: "Open logs" }).dblclick();
  await expect(row(/Open logs/)).toHaveAttribute("data-loading", "true");
  await expect(path).toHaveAttribute("aria-busy", "true");
  await expect(panel(page).getByRole("progressbar", { name: "Opening folder" })).toBeVisible();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/logs on api-gateway");
  await expect(panel(page).getByRole("progressbar")).toHaveCount(0);
  await expect(path).not.toHaveAttribute("aria-busy", "true");
});

test("files: type-ahead finds a name, Enter opens, Backspace goes up, and the menu key opens the row menu", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  const row = (name: RegExp) => list(page).getByRole("row", { name });
  await expect(list(page)).toBeVisible();
  // Opening the panel puts the keyboard in the list.
  await expect(list(page).getByRole("button", { name: "Open app" })).toBeFocused();

  // Typing jumps to the first name that starts with it; typing on extends the search.
  await page.keyboard.type("re");
  await expect(row(/README\.md/)).toHaveAttribute("aria-selected", "true");
  await expect(list(page).getByRole("button", { name: "Select README.md" })).toBeFocused();
  await page.waitForTimeout(900);
  await page.keyboard.type("b");
  await expect(row(/backup\.tar\.gz/)).toHaveAttribute("aria-selected", "true");
  // The same letter typed again moves on to the next name starting with it.
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    fs.set("/home/deploy/data.csv", { kind: "file", size: 3, permissions: 0o644, modified: 0 });
  });
  await panel(page).getByRole("button", { name: "Refresh" }).click();
  await list(page).getByRole("button", { name: "Select backup.tar.gz" }).focus();
  await page.waitForTimeout(900);
  await page.keyboard.type("d");
  await expect(row(/data\.csv/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("d");
  await expect(row(/deploy\.sh/)).toHaveAttribute("aria-selected", "true");
  // Nothing matches: the selection stays.
  await page.waitForTimeout(900);
  await page.keyboard.type("zz");
  await expect(row(/deploy\.sh/)).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(900);
  await page.keyboard.type("lo");
  await expect(row(/Open logs/)).toHaveAttribute("aria-selected", "true");

  // Enter opens the folder; Backspace goes back up and selects it.
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/logs on api-gateway");
  await page.keyboard.press("Backspace");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  await expect(row(/Open logs/)).toHaveAttribute("aria-selected", "true");

  // Shift+F10 opens the row menu for the selection; it lists the shortcuts it answers to.
  await list(page).getByRole("button", { name: "Open logs" }).focus();
  await page.keyboard.press("Shift+F10");
  const rowMenu = page.getByRole("menu", { name: "More actions for logs" });
  await expect(rowMenu.getByRole("menuitem")).toHaveText(["Open", "Download…", "RenameF2", "Duplicate", "Copy path", "Permissions…", "Delete…Del"]);
  await expect(rowMenu.getByRole("menuitem", { name: "Open" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rowMenu).toHaveCount(0);
  await expect(list(page).getByRole("button", { name: "Open logs" })).toBeFocused();

  // Right-click on the free space: the folder's own menu.
  await body(page).locator(".ft").click({ button: "right", position: { x: 100, y: 300 } });
  await expect(page.getByRole("menu", { name: "Folder actions" }).getByRole("menuitem").first()).toHaveText("New folder");
});

test("files: Enter right after typing a name opens that name, even before focus has moved to it", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page).getByRole("button", { name: "Open app" })).toBeFocused();
  // Type-ahead selects logs at once but focuses it a frame later. Enter pressed in between (the
  // next task, before the next frame) still arrives at the app row; it must open what was typed.
  await list(page).evaluate(async (table) => {
    const send = (key: string) => (document.activeElement ?? table).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    send("l");
    send("o");
    await new Promise((resolve) => setTimeout(resolve, 0));
    send("Enter");
  });
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy/logs on api-gateway");
});

test("files: sorting by a column keeps folders first, and empty, hidden-only and failed folders say so", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();

  await panel(page).getByRole("button", { name: "Sort by Size" }).click();
  await panel(page).getByRole("button", { name: "Sort by Size" }).click();
  await expect(panel(page).getByRole("columnheader", { name: /Size/ })).toHaveAttribute("aria-sort", "descending");
  await expect(names(page)).toHaveText([/app|logs/, /app|logs/, /backup\.tar\.gz/, /README\.md/, /deploy\.sh/]);
  await panel(page).getByRole("button", { name: "Sort by Name" }).click();
  await expect(names(page)).toHaveText([/app/, /logs/, /backup\.tar\.gz/, /deploy\.sh/, /README\.md/]);

  // An empty folder.
  await panel(page).getByRole("button", { name: "New folder" }).click();
  await page.getByRole("dialog", { name: "New folder" }).getByRole("textbox", { name: "Name" }).fill("empty");
  await page.keyboard.press("Enter");
  await list(page).getByRole("button", { name: "Open empty" }).dblclick();
  await expect(panel(page)).toContainText("This folder is empty");
  await expect(panel(page)).toContainText("Drop files here or use Upload.");

  // Only hidden files: the count and a way to show them.
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    fs.set("/home/deploy/empty/.env", { kind: "file", size: 3, permissions: 0o600, modified: 0 });
  });
  await panel(page).getByRole("button", { name: "Refresh" }).click();
  await expect(panel(page)).toContainText("1 hidden item.");
  await panel(page).locator(".ft-state").getByRole("button", { name: "Show hidden files" }).click();
  await expect(list(page).getByRole("button", { name: "Select .env" })).toBeVisible();
});

test("files: a folder the server will not list says so in place, first or later, with what to do", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.evaluate(() => {
    (window as unknown as { __mockListFail: number }).__mockListFail = 1;
  });
  await page.keyboard.press("Control+Shift+O");
  // Nothing listed yet: the reason in place of the list, and Try again.
  const failure = panel(page).getByRole("alert");
  await expect(failure).toContainText("No permission to open this folder");
  await expect(failure).toContainText("refused to list");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");

  // From a folder already shown: an inline notice above the list, which stays.
  await page.evaluate(() => {
    (window as unknown as { __mockListFail: number }).__mockListFail = 1;
  });
  await list(page).getByRole("button", { name: "Open app" }).dblclick();
  await expect(panel(page).getByRole("alert")).toContainText("No permission to open this folder");
  await expect(list(page)).toHaveAccessibleName("Contents of /home/deploy on api-gateway");
  await panel(page).getByRole("alert").getByRole("button", { name: "Close" }).click();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

test("files: the date says how long ago, several items get a selection bar, and Duplicate keeps both", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  // Relative date, exact time on hover.
  const modified = list(page).getByRole("row", { name: /README\.md/ }).locator("td.ft-col-modified");
  await expect(modified).toHaveText("1 h ago");
  await expect(modified).toHaveAttribute("title", /^2026-10-11 \d\d:00$/);

  // Two selected: a bar with what can be done to both at once.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await list(page).getByRole("button", { name: "Select deploy.sh" }).click({ modifiers: [uiModifier] });
  const bulk = panel(page).getByRole("toolbar", { name: "2 selected items" });
  await expect(bulk).toContainText("2 selected");
  await expect(bulk.getByRole("button", { name: "Download" })).toBeVisible();
  await bulk.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete 2 items?" })).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await bulk.getByRole("button", { name: "Clear selection" }).click();
  await expect(bulk).toHaveCount(0);

  // Duplicate copies on the same server under the next free name, through the transfer queue.
  await rowAction(page, "README.md", "Duplicate");
  const transfers = panel(page).getByRole("region", { name: "Transfers" });
  await expect(transfers.getByRole("listitem").first()).toContainText("README (1).md");
  const copy = (await page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls)).filter((c) => c.cmd === "files_copy").at(-1);
  expect(copy?.args).toMatchObject({ srcDir: "/home/deploy", dstDir: "/home/deploy", choice: "keep_both" });
  expect(copy?.args.srcSession).toBe(copy?.args.dstSession);
  await finishLatest(page);
  await expect(list(page).getByRole("button", { name: "Select README (1).md" })).toBeVisible();
});

test("files: a failed transfer says why and can be retried in place", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  const transfers = panel(page).getByRole("region", { name: "Transfers" });
  await toolbar(page, "Upload", "Upload files…");
  await page.evaluate(() => {
    const w = window as unknown as { __mockTransfers: Map<string, { fail(m: string): void }> };
    [...w.__mockTransfers.values()].at(-1)?.fail("The connection dropped.");
  });
  await expect(transfers.getByTestId("transfer-state")).toHaveText("Failed: The connection dropped.");
  await expect(transfers.getByRole("button", { name: "Hide transfers" })).toContainText("1 failed");
  await transfers.getByRole("button", { name: "Retry notes.txt" }).click();
  // The same row starts again (the earlier upload had not finished, so nothing asks to replace).
  await expect(transfers.getByRole("listitem")).toHaveCount(1);
  await expect(transfers.getByTestId("transfer-state")).toHaveText("1.0 KB of 2.0 KB");
});

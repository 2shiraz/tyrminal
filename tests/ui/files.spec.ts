// The files (SFTP) panel against the test-only mock backend. Real transfers, conflicts and
// cancellation against OpenSSH are tested in crates/core/tests/sessions_lab.rs.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Files" });
const list = (page: Page) => panel(page).getByRole("list", { name: /^Contents of \// });
/** Lets the newest running mock transfer complete. */
const finishLatest = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __mockTransfers: Map<string, { finish(): void }> };
    [...w.__mockTransfers.values()].at(-1)?.finish();
  });

test("files: browse the login folder, hidden files on request, folders open and go up", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("status", { name: "Target" })).toHaveText(/Files on api-gateway/);
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy");
  // Folders first; dotfiles hidden until asked for.
  await expect(list(page).getByRole("button")).toHaveText([/app/, /logs/, /backup\.tar\.gz.*700 MB/, /deploy\.sh.*755/, /README\.md/]);
  await panel(page).getByRole("switch", { name: "Show hidden files" }).check();
  await expect(list(page).getByRole("button", { name: "Select .bashrc" })).toBeVisible();

  await list(page).getByRole("button", { name: "Open app" }).click();
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy/app");
  await expect(list(page).getByRole("button")).toHaveText([/config\.yml/]);
  await panel(page).getByRole("button", { name: "Up one folder" }).click();
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy");
  // Typing a path goes there.
  await panel(page).getByRole("textbox", { name: "Folder on the server" }).fill("/home");
  await page.keyboard.press("Enter");
  await expect(list(page).getByRole("button")).toHaveText([/deploy/]);

  // Server-supplied names are shown as text, control characters made visible.
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    fs.set("/home/\u001b[31mred", { kind: "file", size: 1, permissions: 0o644, modified: 0 });
  });
  await panel(page).getByRole("button", { name: "Refresh" }).click();
  await expect(list(page)).toContainText("\\x1b[31mred");

  // Escape closes the panel; the shortcut toggles it.
  await panel(page).getByRole("textbox", { name: "Folder on the server" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("files: uploads and downloads show progress, never replace without asking, and can be cancelled", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  const transfers = panel(page).getByRole("region", { name: "Transfers" });

  await panel(page).getByRole("button", { name: "Upload…" }).click();
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("1.0 KB of 2.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done");
  await expect(list(page).getByRole("button", { name: "Select notes.txt" })).toBeVisible();

  // The same name again asks first; Cancel leaves everything as it was.
  await panel(page).getByRole("button", { name: "Upload…" }).click();
  const replace = page.getByRole("alertdialog", { name: "Replace “notes.txt”?" });
  await expect(replace).toContainText("already in this folder on the server");
  await expect(replace.getByRole("button", { name: "Cancel" })).toBeFocused();
  await replace.getByRole("button", { name: "Cancel" }).click();
  await expect(transfers.getByRole("listitem")).toHaveCount(1);
  await panel(page).getByRole("button", { name: "Upload…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  await expect(transfers.getByRole("listitem")).toHaveCount(2);
  // Keep both uploads under the next free name instead.
  await panel(page).getByRole("button", { name: "Upload…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Keep both" }).click();
  await expect(transfers.getByRole("listitem").nth(2)).toContainText("notes (1).txt");
  await transfers.getByRole("button", { name: "Cancel notes (1).txt" }).click();

  // Cancel a running transfer.
  await transfers.getByRole("button", { name: "Cancel notes.txt" }).click();
  await expect(transfers.getByTestId("transfer-state").nth(1)).toHaveText("Cancelled");

  // Download a selected file into a chosen folder; an existing local file needs confirmation.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await panel(page).getByRole("button", { name: "Download…" }).click();
  await expect(transfers.getByTestId("transfer-state").nth(3)).toHaveText("1.3 KB of 5.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(3)).toHaveText("Done");
  await panel(page).getByRole("button", { name: "Download…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Replace “README.md”?" })).toContainText("in the folder you chose");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  await transfers.getByRole("button", { name: "Clear finished" }).click();
  await expect(transfers).toHaveCount(0);
});

test("files: new folder, rename, permissions and delete, with errors explained", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();

  await panel(page).getByRole("button", { name: "New folder" }).click();
  await page.getByRole("dialog", { name: "New folder" }).getByRole("textbox", { name: "Name" }).fill("releases");
  await page.keyboard.press("Enter");
  await expect(list(page).getByRole("button", { name: "Open releases" })).toBeVisible();

  // Rename refuses an existing name and says why.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await panel(page).getByRole("button", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename “README.md”" });
  await rename.getByRole("textbox", { name: "Name" }).fill("deploy.sh");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(rename.getByRole("alert")).toContainText("already there");
  await rename.getByRole("textbox", { name: "Name" }).fill("NOTES.md");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(list(page).getByRole("button", { name: "Select NOTES.md" })).toBeVisible();

  // Permissions take octal digits only.
  await list(page).getByRole("button", { name: "Select NOTES.md" }).click();
  await panel(page).getByRole("button", { name: "Permissions" }).click();
  const perms = page.getByRole("dialog", { name: "Permissions of “NOTES.md”" });
  await expect(perms.getByRole("textbox", { name: "Mode (octal)" })).toHaveValue("644");
  await perms.getByRole("textbox", { name: "Mode (octal)" }).fill("999");
  await perms.getByRole("button", { name: "Save" }).click();
  await expect(perms).toContainText("Use three or four octal digits");
  await perms.getByRole("textbox", { name: "Mode (octal)" }).fill("600");
  await perms.getByRole("button", { name: "Save" }).click();
  await expect(list(page).getByRole("button", { name: "Select NOTES.md" })).toContainText("600");

  // A folder with contents is not removed; the reason is shown.
  await list(page).getByRole("button", { name: "Open app" }).click({ modifiers: [] });
  await panel(page).getByRole("button", { name: "Up one folder" }).click();
  await list(page).getByRole("button", { name: "Select NOTES.md" }).click();
  await panel(page).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete “NOTES.md”?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(list(page).getByRole("button", { name: "Select NOTES.md" })).toHaveCount(0);
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

  await panel(page).getByRole("button", { name: "Upload folder…" }).click();
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("3.0 KB of 6.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done · 3 files, 1 link or special file skipped");
  await expect(list(page).getByRole("button", { name: "Open site" })).toBeVisible();

  // The same folder again is never merged or replaced; keeping both is the only offer.
  await panel(page).getByRole("button", { name: "Upload folder…" }).click();
  const folderConflict = page.getByRole("alertdialog", { name: "Replace “site”?" });
  await expect(folderConflict).toContainText("never merged or replaced");
  await expect(folderConflict.getByRole("button", { name: "Replace" })).toHaveCount(0);
  await folderConflict.getByRole("button", { name: "Keep both" }).click();
  await finishLatest(page);
  await expect(list(page).getByRole("button", { name: "Open site (1)" })).toBeVisible();

  // Download the folder being shown.
  await list(page).getByRole("button", { name: "Open app" }).click();
  await panel(page).getByRole("button", { name: "Download this folder…" }).click();
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(2)).toHaveText("Done");
  // At the root there is no folder above to download into.
  await panel(page).getByRole("textbox", { name: "Folder on the server" }).fill("/");
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("button", { name: "Download this folder…" })).toBeDisabled();
});

test("files: a file opened in an editor is saved only on request, and server changes are not overwritten silently", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await panel(page).getByRole("button", { name: "Edit…" }).click();
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

test("files: two panes copy between this computer and the server by button and by drag and drop", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await expect(list(page)).toBeVisible();
  await panel(page).getByRole("switch", { name: "Show this computer" }).check();
  const local = panel(page).getByRole("region", { name: "This computer" });
  await expect(local).toContainText("Choose a folder on this computer");
  await local.getByRole("button", { name: "Choose folder…" }).click();
  const localList = local.getByRole("list", { name: /on this computer/ });
  await expect(localList.getByRole("button")).toHaveText([/photos/, /deploy\.tar\.gz.*40 KB/, /notes\.md/]);
  const transfers = panel(page).getByRole("region", { name: "Transfers" });

  // Button: local file to the server folder shown.
  await localList.getByRole("button", { name: "Select notes.md" }).click();
  await panel(page).getByRole("button", { name: "Upload to the server folder" }).click();
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").first()).toHaveText("Done");
  await expect(list(page).getByRole("button", { name: "Select notes.md" })).toBeVisible();

  // Button: remote file to the local folder shown; the local pane refreshes.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await panel(page).getByRole("button", { name: "Download to this computer" }).click();
  await finishLatest(page);
  await expect(localList.getByRole("button", { name: "Select README.md" })).toBeVisible();

  // Drag and drop: a local folder onto the server pane.
  await localList.getByRole("button", { name: "Open photos" }).dragTo(panel(page).locator(".files-body"));
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(2)).toHaveText("Done");
  await expect(list(page).getByRole("button", { name: "Open photos" })).toBeVisible();

  // Local navigation stays inside the chosen folder.
  await localList.getByRole("button", { name: "Open photos" }).dblclick();
  await expect(local).toContainText("Projects / photos");
  await local.getByRole("button", { name: "Up one local folder" }).click();
  await expect(local.getByRole("button", { name: "Up one local folder" })).toBeDisabled();
});

test("files: copy to another server is offered with two SSH sessions and runs as a transfer", async ({ page }) => {
  await openApp(page);
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  // With one SSH session there is nowhere to copy to.
  await expect(panel(page).getByRole("button", { name: "Copy to another server…" })).toHaveCount(0);

  await connect(page, "db-primary");
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await panel(page).getByRole("button", { name: "Copy to another server…" }).click();
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
    page.locator(".files-body").evaluate((el, specs) => {
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

test("files: switching tabs keeps each session's folder, selection, toggles and scroll without listing again", async ({ page }) => {
  await openApp(page);
  // Enough entries for the list to scroll.
  await page.evaluate(() => {
    const fs = (window as unknown as { __mockFs: Map<string, unknown> }).__mockFs;
    for (let i = 0; i < 80; i++) fs.set(`/home/deploy/app/log-${String(i).padStart(2, "0")}.txt`, { kind: "file", size: 10, permissions: 0o644, modified: 0 });
  });
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  await list(page).getByRole("button", { name: "Open app" }).click();
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy/app");
  await panel(page).getByRole("switch", { name: "Show hidden files" }).check();
  await list(page).getByRole("button", { name: "Select log-40.txt" }).click();
  await page.locator(".files-body").evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event("scroll"));
  });
  const scrolled = await page.locator(".files-body").evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  // Tab B: another session starts at its own login folder with its own toggles.
  await connect(page, "db-primary");
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy");
  await expect(panel(page).getByRole("switch", { name: "Show hidden files" })).not.toBeChecked();

  const listCalls = () =>
    page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.filter((c) => c.cmd === "files_list").length);
  const before = await listCalls();

  // Back to tab A: same folder, selection, toggles and scroll, and nothing is listed again.
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await expect(panel(page).getByRole("status", { name: "Target" })).toHaveText(/Files on api-gateway/);
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy/app");
  await expect(panel(page).getByRole("switch", { name: "Show hidden files" })).toBeChecked();
  await expect(list(page).getByRole("button", { name: "Select log-40.txt" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.locator(".files-body").evaluate((el) => el.scrollTop)).toBe(scrolled);
  // And back to B, which also kept its place.
  await page.getByRole("tab", { name: /db-primary/ }).click();
  await expect(panel(page).getByRole("textbox", { name: "Folder on the server" })).toHaveValue("/home/deploy");
  expect(await listCalls()).toBe(before);

  // Refresh is the way to list again.
  await panel(page).getByRole("button", { name: "Refresh" }).click();
  await expect.poll(listCalls).toBe(before + 1);
});

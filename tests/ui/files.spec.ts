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
const list = (page: Page) => panel(page).getByRole("list", { name: /Contents of/ });
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

  // Cancel a running transfer.
  await transfers.getByRole("button", { name: "Cancel notes.txt" }).click();
  await expect(transfers.getByTestId("transfer-state").nth(1)).toHaveText("Cancelled");

  // Download a selected file into a chosen folder; an existing local file needs confirmation.
  await list(page).getByRole("button", { name: "Select README.md" }).click();
  await panel(page).getByRole("button", { name: "Download…" }).click();
  await expect(transfers.getByTestId("transfer-state").nth(2)).toHaveText("1.3 KB of 5.0 KB");
  await finishLatest(page);
  await expect(transfers.getByTestId("transfer-state").nth(2)).toHaveText("Done");
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

  // The same folder again is refused, not merged and not offered as a replacement.
  await panel(page).getByRole("button", { name: "Upload folder…" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(transfers.getByTestId("transfer-state").nth(1)).toHaveText(/Failed: Something with that name is already there/);

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

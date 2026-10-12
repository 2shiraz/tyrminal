// OpenSSH import with ProxyJump and ProxyCommand (IMP-02) against the UI test mock: the preview
// says which jump host each host goes through and that ProxyCommand is ignored; imported hosts
// keep their jump host. Chain conversion and refusals are tested in crates/core (import.rs and
// tests/inventory.rs).
import { expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

test("an OpenSSH config's ProxyJump becomes a jump host; ProxyCommand is ignored and said so", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).first().click();
  await page.getByRole("button", { name: "Import" }).click();
  const dialog = page.getByRole("dialog", { name: "Import hosts" });
  const config = "Host bastion\n  HostName bastion.example\nHost inner\n  ProxyJump bastion\nHost legacy\n  ProxyCommand nc %h %p\n";
  await dialog.getByLabel("Choose file").setInputFiles({ name: "config", mimeType: "text/plain", buffer: Buffer.from(config) });
  const preview = dialog.getByTestId("import-preview");
  await expect(preview).toContainText("Goes through the jump host bastion");
  await expect(preview).toContainText("Its ProxyCommand was ignored");
  await expect(dialog).toContainText("ignored (commands from imported files are never run)");
  await dialog.getByRole("button", { name: "Import 3 hosts" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "More actions for inner" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editor = page.getByRole("complementary", { name: "Host details" });
  // "Show more" opens by itself when a jump host is set.
  await expect(editor.getByRole("combobox", { name: "Jump host" })).toHaveValue(/.+/);
  await expect(editor).toContainText("Connects through bastion first");
});

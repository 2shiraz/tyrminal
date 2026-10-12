// Native backup suite (Phase 02 gate): a backup written by the real application restores on a
// fresh install, opens with the original passphrase, and holds every item; a damaged file
// restores nothing. Test builds read the file path from TYRMINAL_E2E_BACKUP_PATH because
// WebDriver cannot drive native file dialogs.
//
//   pnpm build:e2e && node --test tests/native/backup.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { PASSPHRASE, ui } from "./flows.mjs";
import { App } from "./harness.mjs";

describe("backup and restore in the real application", { concurrency: false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "tyrminal-backup-"));
  const file = join(dir, "lab.tyrbackup");
  const env = { TYRMINAL_E2E_BACKUP_PATH: file };
  let recoveryKey;

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a backup is written owner-only and holds no plaintext", async () => {
    const app = await App.launch({ env });
    const s = app.session;
    const t = ui(s);
    try {
      recoveryKey = await t.createVault();
      await t.nav("Hosts");
      await s.clickButton("Add host");
      await s.fill("Name", "backup-host-alpha", { within: "dialog" });
      await s.fill("Address", "192.0.2.44", { within: "dialog" });
      await s.fill("User name", "deploy", { within: "dialog" });
      await s.clickButton("Save", { within: "dialog" });
      await s.waitGone("dialog");
      await t.nav("Settings");
      await s.clickButton("Save a backup…");
      await s.until(async () => /Backup saved as lab\.tyrbackup/.test(await s.execute("return document.body.innerText")), { describe: "saved toast" });
      await app.screenshot("b01-backup-saved");
    } finally {
      await app.quit();
    }
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString(), "TYRBACKP");
    for (const needle of ["backup-host-alpha", "192.0.2.44", "deploy"]) assert.ok(!bytes.includes(needle), `plaintext ${needle}`);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test("restores on a fresh install after a full check, then opens with the passphrase", async () => {
    const app = await App.launch({ env });
    const s = app.session;
    const t = ui(s);
    try {
      await s.until(async () => (await t.heading()) === "Create your local vault", { describe: "onboarding" });
      await s.clickButton("Restore from a backup instead");
      await s.waitFor("dialog");
      await s.clickButton("Choose backup file…", { within: "dialog" });
      await s.waitFor('[data-testid="backup-file"]');
      await s.fill("The backup's passphrase", "not the passphrase", { within: "dialog" });
      await s.clickButton("Check backup", { within: "dialog" });
      await s.until(async () => /did not open the backup/.test(await s.text(await s.waitFor("dialog"))), { describe: "wrong passphrase" });

      // Recovery key works as well, and the preview shows what is inside.
      await s.click(await s.waitFor('dialog .segmented label:nth-child(2)'));
      await s.fill("The backup's recovery key", recoveryKey, { within: "dialog" });
      await s.clickButton("Check backup", { within: "dialog" });
      let preview;
      try {
        preview = await s.text(await s.waitFor('[data-testid="backup-preview"]', { timeout: 20_000 }));
      } catch (error) {
        throw new Error(`${error.message}\n--- dialog ---\n${await s.text(await s.waitFor("dialog"))}`);
      }
      assert.match(preview, /1 hosts · 0 keys · 0 trusted servers · 0 snippets/);
      await app.screenshot("b02-restore-preview");
      await s.clickButton("Restore", { within: "dialog" });
      await s.until(async () => (await t.heading()) === "Unlock your vault", { describe: "unlock after restore", timeout: 20_000 });
      await s.fill("Passphrase", PASSPHRASE);
      await s.clickButton("Unlock");
      await s.until(async () => (await t.heading()) === "Home", { describe: "home", timeout: 20_000 });
      await t.nav("Hosts");
      await s.waitFor('[aria-label="Connect to backup-host-alpha"]');
    } finally {
      await app.quit();
    }
  });

  test("a damaged backup restores nothing", async () => {
    const bytes = readFileSync(file);
    bytes[bytes.length - 40] ^= 0x80;
    writeFileSync(file, bytes);
    const app = await App.launch({ env });
    const s = app.session;
    const t = ui(s);
    try {
      await s.until(async () => (await t.heading()) === "Create your local vault", { describe: "onboarding" });
      await s.clickButton("Restore from a backup instead");
      await s.clickButton("Choose backup file…", { within: "dialog" });
      await s.fill("The backup's passphrase", PASSPHRASE, { within: "dialog" });
      await s.clickButton("Check backup", { within: "dialog" });
      await s.until(async () => /not a valid Tyrminal backup/.test(await s.text(await s.waitFor("dialog"))), { describe: "damaged", timeout: 20_000 });
      assert.equal((await s.findAll('[data-testid="backup-preview"]')).length, 0);
    } finally {
      await app.quit();
    }
  });
});

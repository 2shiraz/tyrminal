// Native key-file import (KEY-01): the real application imports a private key from a file
// picked natively. Test builds read the path from TYRMINAL_E2E_KEY_FILE because WebDriver cannot
// drive native file dialogs. The page only ever shows the file name.
//
//   pnpm build:e2e && node --test tests/native/keys.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { ui } from "./flows.mjs";
import { App, root } from "./harness.mjs";

const fixture = (name) => join(root, "tests", "fixtures", "keys", name);

describe("key files in the real application", { concurrency: false }, () => {
  test("an encrypted PuTTY key file imports with its passphrase; its text never reaches the page", async () => {
    const file = fixture("ecdsa-v3-enc.ppk");
    const app = await App.launch({ env: { TYRMINAL_E2E_KEY_FILE: file } });
    const s = app.session;
    const t = ui(s);
    try {
      await t.createVault();
      await t.nav("Keychain");
      await s.clickButton("Import key");
      await s.waitFor("dialog");
      await s.clickButton("Choose key file…", { within: "dialog" });
      const picked = await s.text(await s.waitFor('[data-testid="picked-key"]'));
      assert.match(picked, /ecdsa-v3-enc\.ppk/);
      assert.match(picked, /Passphrase protected/);
      // Nothing of the key's body is in the page.
      const lines = readFileSync(file, "utf8").split("\n");
      const secretLine = lines[lines.findIndex((l) => l.startsWith("Private-Lines")) + 1];
      assert.ok(secretLine, "fixture has an encrypted private part");
      assert.ok(!(await s.execute("return document.documentElement.outerHTML")).includes(secretLine));

      await s.clickButton("Import key", { within: "dialog" });
      await s.until(async () => /Enter its passphrase/.test(await s.text(await s.waitFor("dialog"))), { describe: "passphrase needed" });
      await s.fill("Key passphrase", "fixture passphrase", { within: "dialog" });
      await s.clickButton("Import key", { within: "dialog" });
      await s.waitGone("dialog");
      await s.until(async () => /ecdsa-sha2-nistp256/.test(await s.execute("return document.body.innerText")), { describe: "key listed" });
      await app.screenshot("k01-key-file-imported");
    } finally {
      await app.quit();
    }
  });
});

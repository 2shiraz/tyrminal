// Native privilege-prompt suite (KEY-18): an identity created in the real UI and assigned to a
// host signs it in to the lab server, and its password is typed into a real no-echo prompt only
// after the user asks with the shortcut and confirms.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/privilege.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { KEYS, ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();
const mac = process.platform === "darwin";
// Key chords use upper-case letters (see terminal.test.mjs).
const insertChord = mac ? [KEYS.meta, KEYS.shift, "P"] : [KEYS.ctrl, KEYS.shift, "P"];
const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("privilege-prompt assistance in the real application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;

  before(async () => {
    app = await App.launch({ prefs: DOM_RENDERER_PREFS });
    s = app.session;
    t = ui(s);
    await t.createVault();
  });

  after(async () => {
    await app?.quit();
  });

  /**
   * Chooses an option of a <select> by its text. WebKitGTK shows selects as native GTK popups
   * that its WebDriver cannot drive (option clicks, arrow keys and typing all leave the value
   * unchanged), so this sets the value and fires the same `change` event a user's choice fires.
   * Everything after it (the Save click, IPC, the vault) runs as in normal use.
   */
  async function chooseOption(selector, text) {
    const chosen = await s.execute(
      `const select = document.querySelector(arguments[0]);
       const option = [...(select?.options ?? [])].find((o) => o.text === arguments[1]);
       if (!option) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
       setter.call(select, option.value);
       select.dispatchEvent(new Event("change", { bubbles: true }));
       return true;`,
      [selector, text],
    );
    assert.ok(chosen, `option ${text} in ${selector}`);
  }

  test("an identity's password is typed into a real prompt only after the shortcut and a confirmation", async () => {
    await t.nav("Keychain");
    await s.clickButton("New identity");
    await s.waitFor("dialog");
    await s.fill("Name", "Lab identity", { within: "dialog" });
    await s.fill("User name", lab.user, { within: "dialog" });
    await s.fill("Password", lab.password, { within: "dialog" });
    await s.clickButton("Save identity", { within: "dialog" });
    await s.waitGone("dialog");

    // The host has no credential of its own; the identity assigned from its menu signs it in.
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user, key: null });
    await s.click(await s.waitFor('button[aria-label="More actions for Lab"]'));
    await s.clickButton("Identity…");
    await s.waitFor("dialog select");
    await chooseOption("dialog select", "Lab identity");
    await s.until(async () => (await s.execute("return document.querySelector('dialog select').value")) !== "", {
      describe: "identity chosen",
    });
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");

    await t.connect("Lab");
    await t.type("export PS1='tyr$ '; clear\n");
    await t.waitForText("tyr$");

    // A no-echo prompt like sudo's; the shell reports only a hash of what it read.
    await t.type(`stty -echo; read typed; stty echo; printf 'G%sT:%s\\n' O "$(printf '%s' "$typed" | sha256sum | cut -c1-16)"\n`);
    await s.chord(insertChord);
    const dialog = await s.waitFor("dialog");
    await s.until(async () => /Types the password of identity “Lab identity” into Lab\./.test(await s.text(dialog)), {
      describe: "confirmation names the identity and host",
    });
    assert.match(await s.text(dialog), /Enter is not pressed for you/);
    await app.screenshot("p01-insert-confirmation");
    await s.clickButton("Type password", { within: "dialog" });
    await s.waitGone("dialog");
    // Typed, not submitted: the read is still waiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!(await t.terminalText()).includes("GOT:"), "nothing is submitted before Enter");
    await t.type("\n");
    await t.waitForText(`GOT:${shortHash(lab.password)}`, "the shell read the identity password");
    assert.ok(!(await t.terminalText()).includes(lab.password), "the password was never shown");
    assert.ok(!(await s.execute("return document.documentElement.outerHTML")).includes(lab.password));
  });
});

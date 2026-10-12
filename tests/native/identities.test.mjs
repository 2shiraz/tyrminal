// Native identities suite (KEY-15, KEY-17, KEY-18): an identity is created in the real UI and
// stored in the real vault, a host signs in to the lab server with it, and its password is typed
// into a real no-echo prompt only after the user asks and confirms.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/identities.test.mjs

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

describe("identities in the real application", { concurrency: false }, () => {
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

  /** Clicks the radio whose label starts with `title` inside the open dialog. */
  async function chooseRadio(title) {
    const radio = await s.until(
      async () => {
        // Each choice label holds exactly one radio, so the two lists line up.
        const labels = await s.findAll("dialog label.choice");
        const radios = await s.findAll('dialog label.choice input[type="radio"]');
        for (const [i, label] of labels.entries()) {
          if ((await s.text(label)).trim().startsWith(title)) return radios[i] ?? null;
        }
        return null;
      },
      { describe: `radio ${title}` },
    );
    await s.click(radio);
  }

  test("a host signs in with an identity, and its password is typed only on request", async () => {
    await t.nav("Keychain");
    await s.clickButton("New identity");
    await s.waitFor("dialog");
    await s.fill("Name", "Lab identity", { within: "dialog" });
    await s.fill("User name", lab.user, { within: "dialog" });
    await s.fill("Password", lab.password, { within: "dialog" });
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");
    await s.until(async () => /Lab identity/.test(await s.execute("return document.body.innerText")), { describe: "identity listed" });
    assert.ok(!(await s.execute("return document.documentElement.outerHTML")).includes(lab.password), "the page does not keep the password");

    // The host sets no user name and no password of its own.
    await t.nav("Hosts");
    await s.clickButton("Add host");
    await s.waitFor("dialog");
    await s.fill("Name", "Lab", { within: "dialog" });
    await s.fill("Address", "127.0.0.1", { within: "dialog" });
    const portField = await s.fill("Port", "", { within: "dialog" });
    await s.clear(portField);
    await s.type(portField, String(lab.servers.a.port));
    await chooseRadio("Identity");
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");

    // No password prompt: the identity signs in.
    await t.connect("Lab");
    await t.type("export PS1='tyr$ '; clear\n");
    await t.waitForText("tyr$");
    await app.screenshot("i01-identity-session");

    // A no-echo prompt like sudo's; the shell reports only a hash of what it read.
    await t.type(`stty -echo; read typed; stty echo; printf 'G%sT:%s\\n' O "$(printf '%s' "$typed" | sha256sum | cut -c1-16)"\n`);
    await s.chord(insertChord);
    const dialog = await s.waitFor("dialog");
    const body = await s.text(dialog);
    assert.match(body, /Types the password of identity “Lab identity” into Lab\./);
    assert.match(body, /Enter is not pressed for you/);
    await app.screenshot("i02-insert-confirmation");
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

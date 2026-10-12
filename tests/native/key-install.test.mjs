// Native key install: a key generated in the real application is refused by the lab server and
// named in the failure notice; "Install this key on the server…" signs in once with the
// password (normal trust and password prompts), installs the key into the lab account's own
// ~/.ssh/authorized_keys, and the next connection signs in with that key alone. The lab's sshd
// reads that file next to its own, which this test never touches.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/key-install.test.mjs

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();
const LABEL = `native fresh key ${process.pid}`;

describe("installing a refused key through the real application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;

  before(async () => {
    app = await App.launch({ prefs: DOM_RENDERER_PREFS });
    s = app.session;
    t = ui(s);
    await t.createVault();
    await t.nav("Keychain");
    await s.clickButton("Generate key");
    await s.fill("Name", LABEL, { within: "dialog" });
    await s.clickButton("Generate key", { within: "dialog" });
    await s.waitGone("dialog");
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user, key: LABEL });
  });

  after(async () => {
    await app?.quit();
  });

  const bodyText = () => s.execute("return document.body.innerText");

  async function trustOnceIfAsked() {
    await s.until(async () => (await s.find("dialog .fingerprint")) !== null, { describe: "trust prompt" });
    await s.clickButton("Trust once", { within: "dialog" });
    await s.waitGone("dialog .fingerprint");
  }

  test("the refused key is named, installed by signing in once with the password, then used", async () => {
    await t.nav("Hosts");
    await s.openHost('[data-testid="host-list"]', "Lab");
    await trustOnceIfAsked();
    await s.until(async () => (await bodyText()).includes(`The server did not accept the key "${LABEL}". Its public key may not be installed on this server.`), {
      describe: "named refusal",
    });
    await app.screenshot("k01-key-refused");

    await s.clickButton("Install this key on the server…");
    await s.until(async () => (await bodyText()).includes(`Install “${LABEL}” on a server`), { describe: "install dialog" });
    await s.clickButton("Sign in with password", { within: "dialog" });
    // A trust-once decision is not remembered: the install connection asks again.
    await trustOnceIfAsked();
    const password = await s.waitFor('dialog input[type="password"]');
    await s.type(password, lab.password);
    await s.clickButton("Continue", { within: "dialog" });

    await s.until(async () => (await bodyText()).includes("Install a public key on this server"), { describe: "deploy step" });
    await s.clickButton("Check the server", { within: "dialog" });
    const line = await s.text(await s.waitFor("dialog .deploy-line"));
    const body = line.trim().split(/\s+/)[1];
    assert.ok(body && /^[A-Za-z0-9+/=]+$/.test(body), line);
    await s.clickButton("Install key", { within: "dialog" });
    await s.until(async () => /Installed in .*authorized_keys/.test(await bodyText()), { describe: "installed" });
    await app.screenshot("k02-key-installed");
    await s.clickButton("Close", { within: "dialog" });
    await s.waitGone("dialog");

    // The next connection signs in with the key alone: no password prompt.
    await s.clickButton("Reconnect");
    await trustOnceIfAsked();
    await s.until(async () => /Connected/.test(await t.statusText()), { describe: "connected with the key" });
    assert.equal(await s.find('dialog input[type="password"]'), null, "no password was asked for");

    // Leave the lab account as it was.
    await t.type(`grep -vF '${body}' ~/.ssh/authorized_keys > ~/.ssh/ak.tmp; mv ~/.ssh/ak.tmp ~/.ssh/authorized_keys; echo cleaned-$((1+1))\n`);
    await t.waitForText(/^cleaned-2\s*$/m, "cleanup ran");
  });
});

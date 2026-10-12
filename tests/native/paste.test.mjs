// Native paste safety (P-25): the real application against a real shell on the lab server. The
// paste event is dispatched on the terminal's input element with the text as clipboard data, so
// the system clipboard (and its permission prompts) stays out of it; everything after that, the
// review and what reaches the shell, is the application's own path.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/paste.test.mjs

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();

describe("paste safety in the real application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;

  before(async () => {
    app = await App.launch({ prefs: DOM_RENDERER_PREFS });
    s = app.session;
    t = ui(s);
    await t.createVault();
    await t.importKey(lab.keys.ed25519);
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
    await t.connect("Lab");
  });

  after(async () => {
    await app?.quit();
  });

  async function paste(text) {
    await s.execute(
      `const text = arguments[0];
       const target = document.querySelector(".terminal-pane:not([hidden]) .xterm-helper-textarea");
       const event = new Event("paste", { bubbles: true, cancelable: true });
       Object.defineProperty(event, "clipboardData", { value: { getData: (type) => (type === "text/plain" ? text : "") } });
       target.dispatchEvent(event);`,
      [text],
    );
  }

  /** A shell with bracketed paste inserts a pasted newline without running the line; Enter runs
   * it there and only adds an empty prompt elsewhere. */
  const enter = () => t.type("\n");

  async function review() {
    const dialog = await s.waitFor("dialog[open]", { describe: "the paste review" });
    return { dialog, title: await s.text(await s.waitFor("dialog[open] h2")), text: await s.text(dialog) };
  }

  test("a paste with a zero-width character is reviewed with the character shown, and sent only when confirmed", async () => {
    await paste("echo p25-$((40+2))-hidden​\n");
    let r = await review();
    assert.match(r.title, /hidden characters/);
    assert.match(r.text, /<U\+200B>/);
    assert.match(r.text, /Pasting into\s+Lab/);
    await app.screenshot("p01-paste-hidden");
    await s.clickButton("Cancel", { within: "dialog[open]" });
    await s.waitGone("dialog[open]");
    // Nothing was sent: the shell never printed the result of the arithmetic.
    await t.type("echo p25-$((40+1))-after-cancel\n");
    await t.waitForText(/^p25-41-after-cancel\s*$/m, "the shell is still at its prompt");
    assert.doesNotMatch(await t.terminalText(), /p25-42-hidden/);

    await paste("echo p25-$((40+2))-hidden​\n");
    r = await review();
    await s.clickButton("Paste", { within: "dialog[open]" });
    await s.waitGone("dialog[open]");
    await enter();
    await t.waitForText(/^p25-42-hidden/m, "the confirmed paste ran");
  });

  test("a bracketed-paste end marker is refused; only the stripped text can be sent", async () => {
    await paste("echo p25-$((40+3))-safe\u001b[201~echo p25-$((40+4))-evil\n");
    const r = await review();
    assert.match(r.title, /end bracketed paste early/);
    assert.match(r.text, /ESC \[201~/);
    const labels = await s.execute(`return [...document.querySelectorAll("dialog[open] button")].map((b) => b.textContent.trim())`);
    assert.ok(!labels.includes("Paste"), `no plain Paste button: ${labels}`);
    await app.screenshot("p02-paste-end-marker");
    await s.clickButton("Remove the marker and paste", { within: "dialog[open]" });
    await s.waitGone("dialog[open]");
    await enter();
    // One command line, not two: the marker never reached the shell to split it.
    await t.waitForText(/^p25-43-safeecho p25-44-evil\s*$/m, "the stripped paste ran as one line");
    assert.doesNotMatch(await t.terminalText(), /^p25-44-evil\s*$/m);
  });
});

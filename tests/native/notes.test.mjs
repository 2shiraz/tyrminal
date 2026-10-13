// Native notes suite (P-30): a note is written in the real Host details panel, stored in the real
// vault, shown by the platform's own WebView without turning markup into elements, kept across a
// lock, and its code block reaches a real SSH session only through the paste review, without
// running. Typed text is ASCII only (macOS WebDriver).
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/notes.test.mjs

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { HOST_PANEL, KEYS, PASSPHRASE, ui, waitUnlocked } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();

const NOTE = [
  "# Runbook",
  "",
  "<script>window.__pwned = 1</script>",
  '<img src="https://tracker.invalid/p.gif" onerror="window.__pwned = 2">',
  "[click me](javascript:window.__pwned=3) and ![rack](https://cdn.invalid/rack.png)",
  "See [the wiki](https://wiki.invalid/runbook).",
  "",
  "```",
  "echo note-$((6*7))",
  "```",
].join("\n");

describe("notes in the real application", { concurrency: false }, () => {
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
  });

  after(async () => {
    await app?.quit();
  });

  async function openHostPanel() {
    await t.nav("Hosts");
    const open = await s.until(
      async () => {
        for (const button of await s.findAll('[data-testid="host-list"] button.host-open')) {
          if ((await s.text(button)).trim() === "Lab") return button;
        }
        return null;
      },
      { describe: "the Lab host" },
    );
    await s.click(open);
    await s.waitFor(HOST_PANEL);
  }

  const noteView = () => s.waitFor(`${HOST_PANEL} .note-card .note-view`);

  test("a Markdown note is stored and shown as text: no element, script, image or link from markup", async () => {
    await openHostPanel();
    await s.clickButton("Add note", { within: HOST_PANEL });
    await s.type(await s.waitFor(`${HOST_PANEL} .note-card textarea`), NOTE);
    await s.clickButton("Save note", { within: HOST_PANEL });
    await s.waitGone(`${HOST_PANEL} .note-card textarea`);
    const text = await s.text(await noteView());
    assert.match(text, /<script>window\.__pwned = 1<\/script>/);
    assert.match(text, /<img src="https:\/\/tracker\.invalid\/p\.gif"/);
    assert.match(text, /\[image: rack\]/);
    const inert = await s.execute(
      `const v = document.querySelector('${HOST_PANEL} .note-card .note-view');
       return {
         elements: v.querySelectorAll("script, img, iframe, svg, style, a, [href], [src], [onerror]").length,
         pwned: window.__pwned ?? null,
         links: [...v.querySelectorAll("button.note-link")].map((b) => b.textContent),
         images: performance.getEntriesByType("resource").filter((e) => /\\.invalid/.test(e.name)).length,
       };`,
    );
    assert.deepEqual(inert, { elements: 0, pwned: null, links: ["the wiki"], images: 0 });
    await app.screenshot("n01-note-in-panel");

    // A link shows its destination first; Cancel opens nothing.
    for (const button of await s.findAll(`${HOST_PANEL} .note-link`)) {
      if ((await s.text(button)).trim() === "the wiki") await s.click(button);
    }
    const dialog = await s.text(await s.waitFor("dialog"));
    assert.match(dialog, /https:\/\/wiki\.invalid\/runbook/);
    await s.clickButton("Cancel", { within: "dialog" });
    await s.waitGone("dialog");
  });

  test("the note is in the vault: it survives a lock and unlock", async () => {
    await s.clickButton("Lock vault", { within: "nav.sidebar" });
    await s.until(async () => (await t.heading()) === "Unlock your vault", { describe: "unlock screen" });
    await s.fill("Passphrase", PASSPHRASE);
    await s.clickButton("Unlock");
    await waitUnlocked(s, { describe: "home" });
    await openHostPanel();
    assert.match(await s.text(await noteView()), /echo note-\$\(\(6\*7\)\)/);
  });

  test("a code block reaches the session only through the paste review, and never runs", async () => {
    await t.connect("Lab");
    await t.type("export PS1='tyr$ '; clear\n");
    await t.waitForText("tyr$");
    await s.click(await s.waitFor('.statusbar button[data-panel="notes"]'));
    const panel = '.side-panel[aria-label="Host notes"]';
    await s.waitFor(`${panel} .note-view`);
    await s.clickButton("Paste into session", { within: panel });
    // The review shows the block; Cancel sends nothing.
    assert.match(await s.text(await s.waitFor("dialog")), /echo note-\$\(\(6\*7\)\)/);
    await s.clickButton("Cancel", { within: "dialog" });
    await s.waitGone("dialog");
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(await t.terminalText(), /echo note-/, "Cancel sent nothing");

    await s.clickButton("Paste into session", { within: panel });
    await s.waitFor("dialog");
    await s.clickButton("Paste", { within: "dialog" });
    await t.waitForText(/tyr\$ echo note-\$\(\(6\*7\)\)\s*$/m, "pasted at the prompt");
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(await t.terminalText(), /^note-42$/m, "the pasted block did not run");
    await app.screenshot("n02-note-pasted");
    await s.chord([KEYS.ctrl, "C"]);
  });
});

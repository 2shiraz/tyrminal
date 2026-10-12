// Native snippets suite (SNP-01..04, SNP-07, TRM-14): snippets are created in the real UI,
// stored in the real vault, and sent by the core to a real SSH session on the lab server.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/snippets.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { KEYS, PASSPHRASE, ui, waitUnlocked } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();

describe("snippets in the real application", { concurrency: false }, () => {
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

  async function newSnippet(name, folder, text) {
    await s.click(await s.waitFor('.side-panel button[aria-label="New snippet"]'));
    await s.waitFor("dialog");
    await s.fill("Name", name, { within: "dialog" });
    await s.fill("Folder", folder, { within: "dialog" });
    await s.type(await s.waitFor("dialog textarea"), text);
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");
  }

  test("the panel targets the visible session; Run sends, Paste only inserts", async () => {
    await t.connect("Lab");
    await t.type("export PS1='tyr$ '; clear\n");
    await t.waitForText("tyr$");
    await s.click(await s.waitFor('.statusbar button[data-panel="snippets"][aria-pressed="false"]'));
    await s.waitFor(".side-panel");
    const target = await s.text(await s.waitFor('.side-panel [aria-label="Target"]'));
    assert.match(target, /Sends to Lab/);
    assert.match(target, new RegExp(`${lab.user}@127\\.0\\.0\\.1`));

    await newSnippet("Echo answer", "Lab/Checks", "echo snippet-$((40+2))");
    await newSnippet("Two lines", "Lab", "echo first-$((1+1))\necho second-$((2+2))");
    await app.screenshot("s01-snippets-panel");

    // Run: sent at once (one line) by the core, from the vault, to this session.
    await s.click(await s.waitFor('.side-panel button[aria-label="Run Echo answer in the terminal"]'));
    await t.waitForText(/^snippet-42$/m, "snippet output");

    // Multi-line: previewed with the exact target first.
    await s.click(await s.waitFor('.side-panel button[aria-label="Run Two lines in the terminal"]'));
    const preview = await s.text(await s.waitFor("dialog"));
    assert.match(preview, /2 lines will be sent to/);
    assert.match(preview, /Lab/);
    assert.match(preview, /echo second-\$\(\(2\+2\)\)/);
    await app.screenshot("s02-run-preview");
    await s.clickButton("Run 2 lines", { within: "dialog" });
    // The shell may print the second result right after its echoed prompt (typeahead).
    await t.waitForText(/(^|\$ )second-4\s*$/m, "second line ran");

    // Paste: the text is inserted at the prompt but does not run until Enter.
    // In the side panel Paste is in the snippet's menu.
    await s.click(await s.waitFor('.side-panel button[aria-label="More actions for Echo answer"]'));
    await s.click(
      await s.until(
        async () => {
          for (const candidate of await s.findAll('[role="menu"] [role="menuitem"]')) {
            if ((await s.text(candidate)).includes("Paste Echo answer into the terminal")) return candidate;
          }
          return null;
        },
        { describe: "Paste in the snippet menu" },
      ),
    );
    await t.waitForText(/tyr\$ echo snippet-\$\(\(40\+2\)\)\s*$/m, "pasted at the prompt");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(((await t.terminalText()).match(/^snippet-42$/gm) ?? []).length, 1, "Paste did not execute the command");
    await s.chord([KEYS.ctrl, "C"]);
  });

  test("the native side refuses a snippet aimed at a session this window does not own", async () => {
    // What injected script in a compromised renderer would do: call the command directly.
    const id = await s.executeAsync(
      `const done = arguments[0]; window.__TAURI_INTERNALS__.invoke("snippet_list").then((l) => done(l[0].id), (e) => done(String(e)));`,
    );
    const outcome = await s.executeAsync(
      `const [snippetId, done] = arguments;
       window.__TAURI_INTERNALS__.invoke("snippet_send", { snippetId, sessionId: "f".repeat(32), mode: "run", bracketed: false })
         .then(() => done("ALLOWED"), (e) => done(e.code ?? String(e)));`,
      [id],
    );
    assert.equal(outcome, "ACCESS_DENIED");
  });

  test("locking clears the panel and closes the session; snippets stay encrypted on disk", async () => {
    await s.clickButton("Lock vault", { within: "nav.sidebar" });
    await s.until(async () => (await t.heading()) === "Unlock your vault", { describe: "unlock screen" });
    const text = await s.execute("return document.body.innerText");
    for (const leaked of ["Echo answer", "Two lines", "snippet-$((40+2))", "Lab/Checks"]) {
      assert.ok(!text.includes(leaked), `"${leaked}" is still on screen after locking`);
    }
    assert.equal((await s.findAll(".side-panel")).length, 0);
    assert.equal((await s.findAll(".terminal-pane")).length, 0);
    for (const name of readdirSync(app.dataDir)) {
      // The single-instance lock file holds no data, and Windows refuses reads of a file another
      // process holds locked: check that it is empty instead of reading it.
      if (name === "instance.lock") {
        assert.equal(statSync(join(app.dataDir, name)).size, 0, "the instance lock file holds no data");
        continue;
      }
      const bytes = readFileSync(join(app.dataDir, name));
      for (const needle of ["Echo answer", "snippet-$((40+2))", "second-$((2+2))"]) {
        assert.ok(!bytes.includes(needle), `plaintext "${needle}" found in ${name}`);
      }
    }
    // Unlock again: the snippets come back from the vault.
    await s.fill("Passphrase", PASSPHRASE);
    await s.clickButton("Unlock");
    await waitUnlocked(s, { describe: "home after unlock" });
    await t.nav("Snippets");
    await s.waitFor('[data-snippet="Echo answer"]');
  });
});

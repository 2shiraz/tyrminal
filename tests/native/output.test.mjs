// Native search across sessions (P-28) and command output (P-29): the real application against
// real shells on the lab server. The shell prints the shell-integration marks (OSC 133 C and D)
// itself with printf, which is what the integration does, so nothing is installed on the lab
// account. Saving uses TYRMINAL_E2E_OUTPUT_PATH in place of the system save dialog.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/output.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { KEYS, ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();
const paletteChord = process.platform === "darwin" ? [KEYS.meta, "K"] : [KEYS.ctrl, KEYS.shift, "K"];

describe("search across sessions and command output in the real application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;
  const dir = mkdtempSync(join(tmpdir(), "tyrminal-e2e-output-"));
  const saved = join(dir, "output.txt");

  before(async () => {
    app = await App.launch({ prefs: DOM_RENDERER_PREFS, env: { TYRMINAL_E2E_OUTPUT_PATH: saved } });
    s = app.session;
    t = ui(s);
    await t.createVault();
    await t.importKey(lab.keys.ed25519);
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
  });

  after(async () => {
    await app?.quit();
    rmSync(dir, { recursive: true, force: true });
  });

  async function palette(text) {
    await s.chord(paletteChord);
    await s.type(await s.waitFor('dialog input[role="combobox"]'), text);
    await s.chord([KEYS.enter]);
  }

  test("search lists matches from every open session and jumps to the one chosen", async () => {
    await t.connect("Lab");
    await t.type("echo first-tab-$((40+2))-marker\n");
    await t.waitForText(/^first-tab-42-marker\s*$/m, "first tab output");
    await t.connect("Lab");
    await t.type("echo second-tab-$((40+2))-marker\n");
    await t.waitForText(/^second-tab-42-marker\s*$/m, "second tab output");

    await palette("Search all sessions");
    await s.type(await s.waitFor('dialog input[type="search"]'), "tab-42-marker");
    const results = await s.waitFor('dialog [data-testid="search-results"]');
    await s.until(async () => (await s.findAll('dialog [data-testid="search-results"] button.search-match')).length === 2, {
      describe: "one match per tab (the typed command lines show $((40+2)), not 42)",
    });
    assert.match(await s.text(results), /first-tab-42-marker/);
    const first = await s.until(
      async () => {
        for (const b of await s.findAll("dialog button.search-match")) if ((await s.text(b)).includes("first-tab-42")) return b;
        return null;
      },
      { describe: "the first tab's match" },
    );
    await app.screenshot("o01-search-sessions");
    await s.click(first);
    await s.waitGone("dialog");
    // The first tab is in front again, with the match selected.
    await t.waitForText(/^first-tab-42-marker\s*$/m, "first tab shown");
    const front = await s.execute(`return [...document.querySelectorAll('[role="tab"].tab:not(.tab-page)')].findIndex((e) => e.getAttribute("aria-selected") === "true")`);
    assert.equal(front, 0, "the first of the two Lab tabs is in front");
  });

  test("a marked command's output is saved without the prompt or the command line", async () => {
    // Without marks the action is not offered.
    await s.chord(paletteChord);
    await s.type(await s.waitFor('dialog input[role="combobox"]'), "command's output");
    await s.until(async () => (await s.findAll('dialog [role="option"]')).length === 0, { describe: "no command-output action" });
    await s.chord([KEYS.escape]);
    await s.waitGone("dialog");

    // OSC 133 C (output starts), the output, D;0 (it ended) — printed by the real shell.
    await t.type("printf '\\033]133;C\\007out-a\\nout-b %s\\n\\033]133;D;0\\007' \"$((6*7))\"\n");
    await t.waitForText(/^out-b 42\s*$/m, "output printed");
    await palette("command's output");
    const list = await s.waitFor('dialog [data-testid="command-list"]');
    assert.match(await s.text(list), /Exit 0/);
    await s.click(await s.waitFor('dialog [data-testid="command-list"] button[aria-label^="Save the output"]'));
    await s.until(() => existsSync(saved), { describe: "output file written" });
    assert.equal(readFileSync(saved, "utf8"), "out-a\nout-b 42");
    await app.screenshot("o02-command-output");
  });
});

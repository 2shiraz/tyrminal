// Native shell integration (AUT-06/07): the real application installs the integration block on
// the lab server only when Install is pressed, a real interactive Bash there reports its folder
// and command through OSC 7/133 to the real terminal, and Suggestions use that folder. Local
// installs write into a disposable home folder (TYRMINAL_E2E_HOME), never the real one.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/integration.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { KEYS, ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();
const mac = process.platform === "darwin";
// Key chords use upper-case letters (see terminal.test.mjs).
const suggestChord = mac ? [KEYS.meta, KEYS.shift, "E"] : [KEYS.ctrl, KEYS.shift, "E"];
const paletteChord = mac ? [KEYS.meta, "K"] : [KEYS.ctrl, KEYS.shift, "K"];

describe("shell integration in the real application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;
  const home = mkdtempSync(join(tmpdir(), "tyrminal-e2e-home-"));

  before(async () => {
    app = await App.launch({ prefs: DOM_RENDERER_PREFS, env: { TYRMINAL_E2E_HOME: home } });
    s = app.session;
    t = ui(s);
    await t.createVault();
    await t.importKey(lab.keys.ed25519);
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
  });

  after(async () => {
    await app?.quit();
    rmSync(home, { recursive: true, force: true });
  });

  async function integrationDialogFromSuggestions() {
    await s.chord(suggestChord);
    await s.waitFor('dialog[aria-labelledby] [data-testid="suggestions"]');
    await s.clickButton("Shell integration…", { within: "dialog" });
    await s.until(async () => /Startup file: ~\/\.bashrc/.test(await s.text(await s.waitFor("dialog"))), { describe: "integration status" });
  }

  test("installed on request on the server, a real Bash reports its folder to suggestions", async () => {
    await t.connect("Lab");
    await integrationDialogFromSuggestions();
    const dialog = await s.text(await s.waitFor("dialog"));
    assert.match(dialog, /Not installed\./);
    assert.match(dialog, /# >>> tyrminal shell integration v1 >>>/);
    await app.screenshot("i01-integration-review");
    await s.clickButton("Install", { within: "dialog" });
    await s.until(async () => /Installed \(version 1\)\./.test(await s.text(await s.waitFor("dialog"))), { describe: "installed" });
    await s.clickButton("Close", { within: "dialog" });
    await s.waitGone("dialog");

    // The lab account's login shell is sh; an interactive Bash reads ~/.bashrc.
    await t.type("bash -i\n");
    await t.type("cd /tmp\n");
    await t.type("echo marks-$((20+22)) bash-${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}\n");
    const screen = await t.waitForText(/^marks-42 bash-\d+\.\d+\s*$/m, "bash ran the command");
    const [major, minor] = /^marks-42 bash-(\d+)\.(\d+)/m.exec(screen).slice(1).map(Number);
    await s.chord(suggestChord);
    const context = await s.waitFor('[data-testid="shell-context"]');
    await s.until(async () => /Folder: \/tmp/.test(await s.text(context)), { describe: "folder from OSC 7" });
    // The command marks come from PS0, which needs Bash 4.4 or newer; macOS's system Bash 3.2
    // reports the folder and prompt only (documented in ADR 0006).
    if (major > 4 || (major === 4 && minor >= 4)) {
      await s.until(async () => /Last command: echo marks-\$\(\(20\+22\)\) bash-.* \(succeeded\)/.test(await s.text(context)), { describe: "command from OSC 133" });
    } else {
      assert.doesNotMatch(await s.text(context), /Last command/);
    }
    await app.screenshot("i02-shell-context");
    // Straight on to the setup from the same dialog (pressing Escape is not reliable through
    // WebDriver on every platform, and nothing here depends on it).
    await s.clickButton("Shell integration…", { within: "dialog" });
    await s.until(async () => /Installed \(version 1\)\./.test(await s.text(await s.waitFor("dialog"))), { describe: "integration status" });
    await s.clickButton("Remove", { within: "dialog" });
    await s.until(async () => /Not installed\./.test(await s.text(await s.waitFor("dialog"))), { describe: "removed" });
    await s.clickButton("Close", { within: "dialog" });
    await s.waitGone("dialog");
    // Leave Bash, then leave the lab account as it was: no backup, and no empty startup file.
    await t.type("exit\n");
    // Interactive Bash prints "exit" on its own line as it leaves; the cleanup is typed only once
    // sh's prompt follows it, so it is not read (and echoed) while Bash is still exiting.
    await t.waitForText(/^exit\s*\n[^\n]*\$\s*$/m, "back at the login shell's prompt");
    await t.type("rm -f ~/.bashrc.tyrminal-backup; [ -s ~/.bashrc ] || rm -f ~/.bashrc; echo cleaned-$((1+1))\n");
    await t.waitForText(/^cleaned-2\s*$/m, "cleanup ran");
  });

  test("on this computer it writes only into the chosen shell's startup file, on request", async () => {
    await s.clickButton("Local terminal", { within: "nav.sidebar" });
    await s.until(async () => /Connected/.test(await t.statusText()), { describe: "local shell" });
    await s.chord(paletteChord);
    await s.type(await s.waitFor('dialog input[role="combobox"]'), "shell integration");
    await s.chord([KEYS.enter]);
    await s.until(async () => /On this computer/.test(await s.text(await s.waitFor("dialog"))), { describe: "local integration" });
    if (process.platform === "win32") {
      await s.until(async () => /macOS and Linux/.test(await s.text(await s.waitFor("dialog"))), { describe: "not offered on Windows" });
      await s.clickButton("Close", { within: "dialog" });
      return;
    }
    // Chosen like a user's pick, without clicking an <option>: macOS WebKit opens a native menu
    // for a select, and a WebDriver click on one of its options does not choose it.
    await s.waitFor('dialog select option[value="bash"]');
    await s.execute(
      `const select = document.querySelector('dialog select option[value="bash"]').closest("select");
       Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "bash");
       select.dispatchEvent(new Event("change", { bubbles: true }));`,
    );
    await s.until(async () => /Startup file: ~\/\.bashrc · Not installed\./.test(await s.text(await s.waitFor("dialog"))), { describe: "bash status" });
    assert.ok(!existsSync(join(home, ".bashrc")), "looking writes nothing");
    await s.clickButton("Install", { within: "dialog" });
    await s.until(async () => /Installed \(version 1\)\./.test(await s.text(await s.waitFor("dialog"))), { describe: "installed" });
    const text = readFileSync(join(home, ".bashrc"), "utf8");
    assert.match(text, /^# >>> tyrminal shell integration v1 >>>\n/);
    assert.match(text, /# <<< tyrminal shell integration <<<\n$/);
    await s.clickButton("Remove", { within: "dialog" });
    await s.until(async () => /Not installed\./.test(await s.text(await s.waitFor("dialog"))), { describe: "removed" });
    assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), "");
    assert.ok(readFileSync(join(home, ".bashrc.tyrminal-backup"), "utf8").includes("tyrminal shell integration"));
    await s.clickButton("Close", { within: "dialog" });
  });
});

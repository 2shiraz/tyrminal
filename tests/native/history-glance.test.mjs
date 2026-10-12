// Native command history (AUT-01) and server at a glance (P-32): the real application against a
// real shell on the lab server. History needs the shell-integration command marks (OSC 133 A, B
// and C); a Bash started for the test prints them from PS1 and PS0, which is what the
// integration does, so nothing is installed on the lab account. The server panel reads the lab
// server over its own channel of the same connection.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/history-glance.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { KEYS, PASSPHRASE, ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();
const mac = process.platform === "darwin";
// Key chords use upper-case letters (see terminal.test.mjs).
const suggestChord = mac ? [KEYS.meta, KEYS.shift, "E"] : [KEYS.ctrl, KEYS.shift, "E"];

describe("command history and the server panel in the real application", { concurrency: false }, () => {
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

  /** A Bash whose prompt carries the integration's marks: A and B around the prompt, C as a
   * command starts. C comes from PS0 (Bash 4.4 and newer, as in the integration); an older Bash
   * (the macOS lab's /bin/bash 3.2) prints it from a DEBUG trap instead. A trap firing again
   * within the same line finds no prompt to read and adds nothing. */
  async function markedShell() {
    await t.type("exec bash --norc --noprofile -i\n");
    await t.type(
      "PS1='\\[\\e]133;A\\a\\]tyr$ \\[\\e]133;B\\a\\]'; " +
        "if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4))); then PS0=$'\\e]133;C\\a'; " +
        "else trap 'printf \"\\033]133;C\\007\"' DEBUG; fi; clear\n",
    );
    await t.waitForText(/^tyr\$ \s*$/m, "marked prompt");
  }

  async function openSuggestions() {
    await s.chord(suggestChord);
    return s.waitFor('dialog [data-testid="suggestions"]');
  }

  async function historyItems() {
    const items = [];
    for (const option of await s.findAll('dialog [data-testid="suggestions"] [role="option"][data-kind="history"]')) {
      items.push((await s.text(option)).trim());
    }
    return items;
  }

  async function manager() {
    await s.clickButton("History…", { within: "dialog" });
    return s.waitFor('dialog [data-testid="history-manager"]');
  }

  /** Dismisses the dialog as Escape does (its `cancel` event); Escape itself is not reliable
   * through WebDriver on every platform (see integration.test.mjs). Focus returns to the terminal. */
  async function closeDialog() {
    await s.execute(`document.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }))`);
    await s.waitGone("dialog");
  }

  test("history is off until turned on; then marked command lines are kept, never input to a running command", async () => {
    await t.connect("Lab");
    await markedShell();

    // Off by default: a marked command is not remembered.
    await t.type("echo before-$((40+2))\n");
    await t.waitForText(/^before-42\s*$/m, "ran while history is off");
    await openSuggestions();
    await manager();
    await s.until(async () => /No commands remembered yet\./.test(await s.text(await s.waitFor("dialog"))), { describe: "nothing remembered" });

    // Turn it on from the manager.
    await s.click(await s.waitFor('dialog [data-testid="history-manager"] input[role="switch"]'));
    await s.until(async () => (await s.execute(`return document.querySelector('dialog input[role="switch"]')?.checked ?? null`)) === true, {
      describe: "history on",
    });
    await closeDialog();

    // A command line, one with a leading space, and a password typed while a command runs.
    await t.type("echo kept-$((40+2))\n");
    await t.waitForText(/^kept-42\s*$/m, "remembered command ran");
    await t.type(" echo secret-line-$((1+1))\n");
    await t.waitForText(/^secret-line-2\s*$/m, "leading-space command ran");
    await t.type("read -rs -p 'Password: ' pw; echo; echo got-${#pw}\n");
    await t.waitForText(/^Password:\s*$/m, "password prompt");
    await t.type("hunter2-typed-while-running\n");
    await t.waitForText(/^got-27\s*$/m, "password read by the running command");
    await app.screenshot("h01-commands-run");

    // The setting is cached for a few seconds in the page; the commands above were sent after it.
    await openSuggestions();
    await s.until(async () => (await historyItems()).some((i) => i.includes("echo kept-$((40+2))")), { describe: "remembered command suggested" });
    const items = await historyItems();
    assert.ok(!items.some((i) => i.includes("before-")), `a command run while history was off is not remembered: ${items}`);
    assert.ok(!items.some((i) => i.includes("secret-line")), `a line with a leading space is not remembered: ${items}`);
    assert.ok(!items.some((i) => i.includes("hunter2")), `input to a running command is never remembered: ${items}`);
    await app.screenshot("h02-history-suggested");

    // Choosing one puts it on the command line; it does not run.
    for (const option of await s.findAll('dialog [data-testid="suggestions"] [role="option"][data-kind="history"]')) {
      if ((await s.text(option)).includes("echo kept-$((40+2))")) {
        await s.click(option);
        break;
      }
    }
    await s.waitGone("dialog");
    await t.waitForText(/^tyr\$ echo kept-\$\(\(40\+2\)\)\s*$/m, "inserted at the prompt");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(((await t.terminalText()).match(/^kept-42\s*$/gm) ?? []).length, 1, "the inserted command did not run");
    await s.chord([KEYS.ctrl, "C"]);
  });

  test("history is encrypted in the vault, survives a lock, and can be forgotten", async () => {
    await s.clickButton("Lock vault", { within: "nav.sidebar" });
    await s.until(async () => (await t.heading()) === "Unlock your vault", { describe: "unlock screen" });
    for (const name of readdirSync(app.dataDir)) {
      if (name === "instance.lock") {
        assert.equal(statSync(join(app.dataDir, name)).size, 0, "the instance lock file holds no data");
        continue;
      }
      const bytes = readFileSync(join(app.dataDir, name));
      assert.ok(!bytes.includes("kept-$((40+2))"), `plaintext history found in ${name}`);
    }
    await s.fill("Passphrase", PASSPHRASE);
    await s.clickButton("Unlock");
    await s.until(async () => (await t.heading()) === "Home", { describe: "home after unlock", timeout: 20_000 });

    await t.connect("Lab");
    await openSuggestions();
    const list = await manager();
    await s.until(async () => /echo kept-\$\(\(40\+2\)\)/.test(await s.text(list)), { describe: "history after unlock" });
    assert.match(await s.text(list), /Lab/);
    await s.click(await s.waitFor('dialog button[aria-label="Forget echo kept-$((40+2))"]'));
    // The command line of the password prompt is remembered (it is what the shell showed at its
    // prompt); what was typed into it is not.
    assert.match(await s.text(list), /read -rs -p 'Password: ' pw/);
    assert.doesNotMatch(await s.text(list), /hunter2/);
    await s.until(async () => !/echo kept-\$\(\(40\+2\)\)/.test(await s.text(list)), { describe: "forgotten" });
    await closeDialog();
  });

  test("the server panel shows the lab server's uptime, load, memory and disks without touching the shell", async () => {
    await t.connect("Lab");
    await markedShell();
    await s.click(await s.waitFor('.statusbar button[data-panel="server"][aria-pressed="false"]'));
    const panel = await s.waitFor('.side-panel[data-panel-kind="server"]');
    // A Linux lab server gives values; another system (the macOS lab is the Mac's own sshd) is
    // reported as not Linux, with nothing guessed.
    const linux = (lab.serverOs ?? "linux") === "linux";
    const shown = linux ? '.side-panel [data-glance="uptime"]' : '.side-panel [data-glance="unavailable"]';
    await s.waitFor(shown, { describe: "the panel's answer", timeout: 20_000 });
    if (linux) {
      const uptime = await s.text(await s.waitFor('.side-panel [data-glance="uptime"]'));
      assert.match(uptime, /^\d+ (d \d+ h|h \d+ min|min)$/, `uptime: ${uptime}`);
      const load = await s.text(await s.waitFor('.side-panel [data-glance="load"]'));
      assert.match(load, /^\d+\.\d\d\s+\d+\.\d\d\s+\d+\.\d\d$/, `load: ${load}`);
      const memory = await s.text(await s.waitFor('.side-panel [data-glance="memory"]'));
      if (memory === "Unavailable") {
        // Only when the server has no MemAvailable line (WSL 1 has none): it is not estimated.
        await t.type("echo mem-available-$(grep -c '^MemAvailable:' /proc/meminfo)\n");
        await t.waitForText(/^mem-available-0\s*$/m, "the server reports no MemAvailable");
        await t.type("clear\n");
        await t.waitForText(/^tyr\$ \s*$/m, "cleared");
      } else {
        assert.match(memory, /used/);
      }
      const mounts = await s.execute(`return [...document.querySelectorAll('.side-panel [data-glance="disks"] li > .mono')].map((e) => e.textContent)`);
      assert.ok(mounts.includes("/"), `the root filesystem is listed: ${mounts}`);
      assert.ok(mounts.every((m) => m.startsWith("/")), `mount points only: ${mounts}`);
    } else {
      assert.equal(await s.text(await s.waitFor(shown)), "Not available. This works on Linux servers only.");
    }
    await app.screenshot("h03-server-panel");

    // It reads again while open, on its own channel: the shell saw none of it.
    await new Promise((r) => setTimeout(r, 6_000));
    assert.equal((await s.findAll(shown)).length, 1);
    const screen = await t.terminalText();
    assert.doesNotMatch(screen, /proc\/|loadavg|uname/, "nothing was typed into the shell");

    // Off for this host, then on again.
    await s.click(await s.waitFor('.side-panel input[role="switch"]'));
    await s.until(async () => /Off for this host\./.test(await s.text(panel)), { describe: "off for the host" });
    await s.click(await s.waitFor('.side-panel input[role="switch"]'));
    await s.waitFor(shown, { timeout: 20_000 });

    // Locking closes the panel with the session.
    await s.clickButton("Lock vault", { within: "nav.sidebar" });
    await s.until(async () => (await t.heading()) === "Unlock your vault", { describe: "unlock screen" });
    assert.equal((await s.findAll(".side-panel")).length, 0);
  });
});

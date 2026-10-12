// Native end-to-end test: the real application binary (WKWebView/WebView2 + Rust core), a real
// vault on disk, and real OpenSSH servers from the lab. Nothing is mocked.
//
//   pnpm lab:up && pnpm build:e2e && pnpm test:native
//
// Covers the Phase 02 gate (create → store → lock → reopen → unlock) and the Phase 03 gate
// (connect to a disposable server and run a fixture command; a changed host key blocks before
// credentials are sent).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { chooseKey, HOST_PANEL, KEYS, saveAndCloseHostPanel } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab, startForwarder } from "./harness.mjs";

const PASSPHRASE = "native e2e passphrase 42";
const lab = loadLab();

function authLogLines(server) {
  const { container, logFile } = lab.servers[server];
  let text;
  if (logFile) {
    text = readFileSync(logFile, "utf8");
  } else {
    // `docker logs` writes sshd's stderr to our stderr; capture both.
    const r = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    text = `${r.stdout}${r.stderr}`;
  }
  return text.split("\n").filter((l) => /Accepted |Failed |Postponed |userauth/.test(l)).length;
}

describe("Tyrminal desktop application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  /** @type {import("./webdriver.mjs").Session} */ let s;
  let forwarder;
  let recoveryKey = "";

  const terminalText = () => s.execute(`return [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows")].map((e) => e.innerText).join("\\n")`);
  // Each newline is the Enter key (a terminal sends CR), not a typed line feed: PowerShell's
  // line editor, the Windows local shell, treats a line feed as "continue on the next line".
  const typeInTerminal = async (text) => {
    const input = await s.waitFor(".terminal-pane:not([hidden]) .xterm-helper-textarea");
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (line) await s.type(input, line);
      if (i < lines.length - 1) await s.chord([KEYS.enter]);
    }
  };
  const NAV_IDS = { Home: "home", Hosts: "hosts", Snippets: "snippets", Keychain: "keychain", "Known hosts": "knownHosts", Settings: "settings" };
  const nav = async (label) => s.click(await s.waitFor(`nav.sidebar [data-nav="${NAV_IDS[label]}"]`));
  const statusText = async () => s.text(await s.waitFor(".statusbar"));
  /** Host entries on the Hosts page (cards), as the user reads them. */
  const hostText = () => s.until(() => s.execute(`return document.querySelector('[data-testid="host-list"] li')?.innerText ?? null`), { describe: "a host entry" });
  // Read in one step in the page, so a re-render cannot invalidate an element handle mid-read.
  const heading = () => s.until(() => s.execute(`return document.querySelector("h1")?.textContent ?? null`), { describe: "a heading" });
  const listItemText = () => s.until(() => s.execute(`return document.querySelector("ul.list li")?.innerText ?? null`), { describe: "a list row" });

  before(async () => {
    forwarder = await startForwarder(lab.servers.a.port);
    app = await App.launch({ prefs: DOM_RENDERER_PREFS });
    s = app.session;
  });

  after(async () => {
    forwarder?.close();
    await app?.quit();
  });

  test("first launch needs no account and creates a local vault", async () => {
    assert.equal(await heading(), "Create your local vault");
    await app.screenshot("01-onboarding");
    await s.fill("Vault passphrase", PASSPHRASE);
    await s.fill("Repeat passphrase", PASSPHRASE);
    await s.clickButton("Create vault");

    // The recovery key is shown once and must be confirmed by typing one group back.
    await s.until(async () => (await heading()) === "Save your recovery key", { describe: "recovery key screen", timeout: 20_000 });
    recoveryKey = (await s.text(await s.waitFor(".recovery-key"))).trim().split(/\s+/).join("-");
    assert.match(recoveryKey, /^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    await app.screenshot("02-recovery-key");
    const prompt = await s.execute(`return [...document.querySelectorAll("label")].map((l) => l.textContent).find((t) => t.includes("type group"))`);
    const group = Number(/group (\d+)/.exec(prompt)[1]);

    // A wrong answer does not get through.
    await s.fill(prompt, "ZZZZZ");
    await s.clickButton("I have saved it");
    await s.waitFor('[role="alert"]');
    const field = await s.waitFor("input.mono");
    await s.clear(field);
    await s.type(field, recoveryKey.split("-")[group - 1]);
    await s.clickButton("I have saved it");

    await s.until(async () => (await heading()) === "Home", { describe: "main window" });
    assert.match(await s.execute("return document.body.innerText"), /Welcome to Tyrminal/);
    await app.screenshot("03-home-empty");
    await nav("Hosts");
    assert.match(await s.execute("return document.body.innerText"), /No hosts yet/);
  });

  test("imports a key and saves a host; secrets never come back to the UI", async () => {
    await nav("Keychain");
    await s.clickButton("Import key");
    await s.fill("Name", "lab key", { within: "dialog" });
    const textarea = await s.waitFor("dialog textarea");
    await s.type(textarea, readFileSync(lab.keys.ed25519, "utf8"));
    await s.clickButton("Import key", { within: "dialog" });
    await s.waitGone("dialog");
    const keyRow = await listItemText();
    assert.match(keyRow, /lab key/);
    assert.match(keyRow, /ssh-ed25519 · SHA256:/);
    await app.screenshot("04-keychain");

    await nav("Hosts");
    await s.clickButton("Add host");
    await s.fill("Name", "Lab server", { within: HOST_PANEL });
    await s.fill("Address", "127.0.0.1", { within: HOST_PANEL });
    const port = await s.fill("Port", "", { within: HOST_PANEL });
    await s.clear(port);
    await s.type(port, String(forwarder.port));
    await s.fill("User name", lab.user, { within: HOST_PANEL });
    // A new host asks for the password unless a key is chosen.
    await chooseKey(s, "lab key");
    await app.screenshot("05-host-editor");
    await saveAndCloseHostPanel(s);
    const hostRow = await hostText();
    assert.match(hostRow, /Lab server/);
    assert.match(hostRow, new RegExp(`${lab.user}@127\\.0\\.0\\.1 port ${forwarder.port}`));
    assert.match(hostRow, /Key: lab key/);

    // The renderer holds no private key material anywhere in its document.
    const html = await s.execute("return document.documentElement.outerHTML");
    assert.ok(!html.includes("PRIVATE KEY"), "private key text must not remain in the DOM");
  });

  test("first connection asks to verify the server, then runs a fixture command", async () => {
    await s.clickButton("Connect");
    await s.until(async () => (await s.find("dialog")) && /Verify this server/.test(await s.text(await s.find("dialog h2"))), {
      describe: "trust prompt",
    });
    const dialog = await s.text(await s.find("dialog"));
    assert.match(dialog, /Nothing has been sent to the server yet/);
    assert.match(dialog, /ssh-ed25519/);
    const shown = await s.attribute(await s.waitFor("dialog .fingerprint"), "aria-label");
    assert.equal(shown, lab.servers.a.hostKeyEd25519Fingerprint, "the fingerprint shown is the server's real fingerprint");
    await app.screenshot("06-trust-prompt");
    await s.clickButton("Trust and remember", { within: "dialog" });
    await s.waitGone("dialog");

    await s.until(async () => /Connected/.test(await statusText()), { describe: "connected status" });
    await typeInTerminal("echo native-$((40+2)) && id -un\n");
    // Both lines of output: the arithmetic result and then the remote user name.
    await s.until(async () => /native-42/.test(await terminalText()) && new RegExp(`\\n${lab.user}\\b`).test(await terminalText()), {
      describe: "fixture command output",
    });
    await app.screenshot("07-terminal");
  });

  test("terminal survives a tab switch and a local terminal runs alongside", async () => {
    await s.clickButton("Local terminal", { within: "nav.sidebar" });
    await s.until(async () => (await s.findAll(".terminal-pane")).length === 2, { describe: "second terminal" });
    await s.until(async () => /Connected/.test(await statusText()) && /Local terminal/.test(await statusText()), { describe: "local shell" });
    await typeInTerminal("echo local-$((40+2))\n");
    await s.until(async () => /local-42/.test(await terminalText()), { describe: "local command output" });

    // Back to the SSH tab: its earlier output is still on screen and it still accepts input.
    const tabs = await s.findAll('.tabstrip [role="tab"]');
    await s.click(tabs[1]);
    await s.until(async () => /native-42/.test(await terminalText()), { describe: "preserved ssh screen" });
    await typeInTerminal("echo again-$((40+2))\n");
    await s.until(async () => /again-42/.test(await terminalText()), { describe: "ssh still interactive" });
  });

  test("a connection dropped by the server reconnects by itself", async () => {
    // Kill this session's sshd process from inside the session: the TCP link ends without an
    // SSH disconnect, as when a network drops. The app retries with backoff and reconnects
    // with the stored trust and key; nothing is asked again.
    await typeInTerminal("kill -9 $PPID\n");
    await s
      .until(async () => (await s.find('[data-testid="auto-reconnect"]')) !== null, { describe: "automatic reconnect countdown" })
      .catch(async (error) => {
        const pane = await s.execute(`return document.querySelector(".terminal-pane:not([hidden])")?.innerText.slice(-600) ?? ""`);
        throw new Error(`${error.message}\n--- pane ---\n${pane}`);
      });
    await s.until(async () => /Connected/.test(await statusText()) && !(await s.find('[data-testid="auto-reconnect"]')), {
      describe: "reconnected",
      timeout: 20_000,
    });
    assert.equal(await s.find("dialog"), null, "reconnecting asked for nothing");
    await typeInTerminal("echo back-$((40+2))\n");
    await s.until(async () => /back-42/.test(await terminalText()), { describe: "reconnected session is interactive" });
  });

  test("locking closes every session and nothing decrypted stays on screen", async () => {
    await s.clickButton("Lock vault", { within: "nav.sidebar" });
    await s.until(async () => (await heading()) === "Unlock your vault", { describe: "unlock screen" });
    const text = await s.execute("return document.body.innerText");
    for (const leaked of ["Lab server", "lab key", "native-42", "127.0.0.1"]) {
      assert.ok(!text.includes(leaked), `"${leaked}" is still visible after locking`);
    }
    assert.equal((await s.findAll(".terminal-pane")).length, 0);
    await app.screenshot("08-locked");

    // A wrong passphrase is refused with a clear message.
    await s.fill("Passphrase", "not the passphrase");
    await s.clickButton("Unlock");
    assert.match(await s.text(await s.waitFor('[role="alert"]')), /did not unlock the vault/);
  });

  test("the vault survives an application restart and unlocks with the recovery key", async () => {
    const dataDir = app.dataDir;
    await app.quit({ keepData: true });
    // What is on disk: an owner-only database with no plaintext host data.
    for (const name of readdirSync(dataDir)) {
      const bytes = readFileSync(join(dataDir, name));
      for (const needle of ["Lab server", "lab key", "OPENSSH PRIVATE KEY", lab.user + "@", PASSPHRASE]) {
        assert.ok(!bytes.includes(needle), `plaintext "${needle}" found in ${name}`);
      }
    }

    app = await App.launch({ dataDir, prefs: DOM_RENDERER_PREFS });
    s = app.session;
    assert.equal(await heading(), "Unlock your vault");
    await s.clickButton("Use recovery key instead");
    await s.fill("Recovery key", recoveryKey.toLowerCase().replaceAll("-", " "));
    await s.clickButton("Unlock");
    await s.until(async () => (await heading()) === "Home", { describe: "main window after recovery unlock", timeout: 20_000 });
    await nav("Hosts");
    assert.match(await hostText(), /Lab server/);

    await nav("Known hosts");
    const known = await listItemText();
    assert.ok(known.includes(lab.servers.a.hostKeyEd25519Fingerprint), "trust recorded before the restart is still there");
    assert.match(known, new RegExp(`127\\.0\\.0\\.1 port ${forwarder.port}`));
    await app.screenshot("09-known-hosts");
  });

  test("a changed host key blocks the connection before any credential is sent", async () => {
    // The same endpoint now answers with a different server's key.
    forwarder.retarget(lab.servers.b.port);
    const before = authLogLines("b");

    await nav("Hosts");
    await s.clickButton("Connect");
    await s.until(async () => /identity has changed/.test(await s.execute("return document.body.innerText")), {
      describe: "changed-key warning",
    });
    const overlay = await s.text(await s.waitFor(".terminal-overlay"));
    assert.match(overlay, /no password or key was sent/);
    const shown = [];
    for (const element of await s.findAll(".terminal-overlay .fingerprint")) shown.push(await s.attribute(element, "aria-label"));
    assert.deepEqual(shown, [lab.servers.b.hostKeyEd25519Fingerprint, lab.servers.a.hostKeyEd25519Fingerprint]);
    assert.equal(await s.find("dialog"), null, "no trust prompt is offered for a changed key");
    await app.screenshot("10-host-key-changed");

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(authLogLines("b"), before, "the impostor server saw authentication activity");

    // Trust was not replaced: the only known key is still the original one.
    await s.clickButton("Open Known hosts");
    await s.until(async () => (await heading()) === "Known hosts", { describe: "known hosts page" });
    await app.screenshot("11-known-hosts-after-change");
    await s.waitFor("ul.list li"); // the list loads asynchronously
    const entries = await s.findAll("ul.list li");
    assert.equal(entries.length, 1);
    assert.ok((await s.text(entries[0])).includes(lab.servers.a.hostKeyEd25519Fingerprint));
  });

  test("replacing trust requires a reason and then asks to verify the new key", async () => {
    await s.clickButton("Remove trust");
    await s.waitFor("dialog");
    const removeDisabled = () =>
      s.execute(`return [...document.querySelectorAll("dialog button")].find((b) => b.textContent.trim() === "Remove trust")?.disabled`);
    assert.equal(await removeDisabled(), true, "cannot remove trust without a reason");
    await s.type(await s.waitFor("dialog textarea"), "lab server rebuilt for the test");
    await s.clickButton("Remove trust", { within: "dialog" });
    await s.waitGone("dialog");
    // The dialog closes before the list has reloaded, so wait for the reloaded (empty) list.
    await s.until(async () => /No trusted servers yet/.test(await s.execute("return document.body.innerText")), {
      describe: "empty known hosts list",
    });

    await nav("Hosts");
    await s.clickButton("Connect");
    await s.until(async () => (await s.find("dialog .fingerprint")) !== null, { describe: "new trust prompt" });
    assert.equal(await s.attribute(await s.find("dialog .fingerprint"), "aria-label"), lab.servers.b.hostKeyEd25519Fingerprint);
    await s.clickButton("Do not connect", { within: "dialog" });
    await s.until(async () => /cancelled/.test(await s.execute("return document.body.innerText")), { describe: "cancelled state" });
  });

  test("the window is locked down: no remote content, no extra native capabilities", async () => {
    const report = await s.execute(`
      const scripts = [...document.scripts].map((x) => x.src);
      const links = [...document.querySelectorAll("link[href]")].map((x) => x.href);
      return {
        origin: location.origin,
        remote: [...scripts, ...links].filter((u) => u && !u.startsWith(location.origin)),
        globalTauri: typeof window.__TAURI__,
        localStorageKeys: Object.keys(localStorage).length,
        fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
      };`);
    assert.deepEqual(report.remote, [], "every script and stylesheet is bundled");
    assert.equal(report.globalTauri, "undefined", "the global Tauri API object is not exposed");
    assert.equal(report.localStorageKeys, 0, "nothing is kept in localStorage");

    // Commands that were never granted are refused by the runtime, whatever the page asks for.
    // (This reaches for the internal invoke function deliberately: it is what injected script
    // in a compromised renderer would do.)
    const attempts = ["plugin:app|version", "plugin:path|resolve_directory", "plugin:webview|create_webview_window", "plugin:shell|open", "plugin:fs|read_text_file", "plugin:dialog|open", "plugin:dialog|save", "read_any_file", "decrypt_secret"];
    const outcomes = await s.executeAsync(`
      const [commands, done] = arguments;
      Promise.all(commands.map((c) => window.__TAURI_INTERNALS__.invoke(c, {}).then(() => "ALLOWED", (e) => "denied: " + String(e).slice(0, 80))))
        .then(done);`, [attempts]);
    for (const [index, outcome] of outcomes.entries()) {
      assert.match(outcome, /^denied: /, `${attempts[index]} must not be callable from the renderer`);
    }
  });

  test("quick unlock uses the OS secret store, or refuses plainly when there is none", async (t) => {
    await s.click(await s.waitFor('nav.sidebar [data-nav="settings"]'));
    const setting = await s.waitFor('[data-testid="quick-unlock"]');
    await s.until(async () => /Quick unlock is (on|off)/.test(await s.text(setting)), { describe: "quick unlock state" });
    await s.clickButton("Turn on quick unlock…");
    await s.fill("Current passphrase", PASSPHRASE, { within: "dialog" });
    await s.clickButton("Turn on", { within: "dialog" });
    const outcome = await s.until(async () => {
      const text = await s.execute("return document.body.innerText");
      if (/Quick unlock is on for this device/.test(text)) return "on";
      if (/keychain is not available/.test(text)) return "unavailable";
      return null;
    }, { describe: "quick unlock outcome", timeout: 20_000 });
    t.diagnostic(`quick unlock path: ${outcome}`);
    if (outcome === "unavailable") {
      // No OS secret store here (e.g. Linux without a Secret Service): nothing changed.
      await s.clickButton("Cancel", { within: "dialog" });
      assert.match(await s.text(await s.waitFor('[data-testid="quick-unlock"]')), /Quick unlock is off/);
      return;
    }
    await s.click(await s.waitFor('nav.sidebar [data-nav="lock"]'));
    await s.until(async () => (await heading()) === "Unlock your vault", { describe: "locked" });
    await s.clickButton("Unlock with this device");
    await s.until(async () => (await heading()) === "Home", { describe: "unlocked by the device", timeout: 20_000 });
    // Turn it off again so the test leaves no keychain item behind.
    await s.click(await s.waitFor('nav.sidebar [data-nav="settings"]'));
    await s.clickButton("Turn off quick unlock");
    await s.until(async () => /Quick unlock is off/.test(await s.text(await s.waitFor('[data-testid="quick-unlock"]'))), { describe: "off" });
  });

  test("a second instance on the same data refuses to start and leaves the first untouched", async () => {
    const second = await App.launch({ dataDir: app.dataDir });
    try {
      await second.session.until(
        async () => /already open/.test(await second.session.execute("return document.body.innerText")),
        { describe: "already-open message", timeout: 20_000 },
      );
      const text = await second.session.execute("return document.body.innerText");
      assert.match(text, /could not start/);
      assert.ok(!/Unlock your vault|Create your local vault/.test(text), "the second instance shows no vault screen");
    } finally {
      await second.quit({ keepData: true });
    }
    // The first instance still works.
    assert.ok(await s.execute(`return document.querySelector("nav.sidebar, .auth-card") !== null`), "first window still renders");
    assert.ok(!/already open/.test(await s.execute("return document.body.innerText")));
  });
});

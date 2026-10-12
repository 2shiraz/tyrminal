// Native terminal suite: real full-screen applications on a real OpenSSH lab server, driven
// through the real application (WebView + Rust core). Covers rendering, keyboard input
// (including Ctrl+C), mouse reporting, resize, exit, colors, wide characters and a malformed
// escape-sequence corpus.
//
// Key chords use upper-case letters: the embedded WebDriver server derives keyCode from the
// character code, and only the upper-case letter gives the keyCode a real keyboard produces
// (67 for C), which is what the terminal's key handling reads.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/terminal.test.mjs

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { KEYS, ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();
const appAvailable = (name) => lab.apps?.[name] === true;
/** The exact program the lab detected (a login shell's PATH may prefer another one). */
const appCmd = (name) => lab.appPaths?.[name] ?? name;

describe("terminal with real applications", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;

  before(async () => {
    app = await App.launch({ prefs: DOM_RENDERER_PREFS });
    s = app.session;
    t = ui(s);
    // Page errors (for example from a render frame) are collected for failure reports.
    await s.execute(`
      window.__tyrErrors = [];
      addEventListener("error", (e) => window.__tyrErrors.push(String(e.message).slice(0, 300)));
      addEventListener("unhandledrejection", (e) => window.__tyrErrors.push("rejection: " + String(e.reason).slice(0, 300)));`);
    await t.createVault();
    await t.importKey(lab.keys.ed25519);
    await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
    await t.connect("Lab");
    // A predictable prompt and UTF-8 locale for the applications.
    await t.type("export PS1='tyr$ ' LANG=C.UTF-8 LC_ALL=C.UTF-8; clear\n");
    await t.waitForText("tyr$");
  });

  after(async () => {
    await app?.quit();
  });

  async function run(command, done) {
    await t.type(`${command}\n`);
    return t.waitForText(done, `output of ${command}`);
  }

  // Every test starts at a responsive shell prompt, so an application left running fails the
  // test that left it, not the next one.
  let readiness = 0;
  beforeEach(async () => {
    if (!t) return;
    readiness += 1;
    const n = 1000 + readiness;
    await run(`echo ready-$((${n - 1}+1))`, new RegExp(`^ready-${n}$`, "m"));
  });

  test("16, 256 and 24-bit colors reach the renderer with the exact values", async () => {
    if (lab.colorsScript) {
      await run(lab.colorsScript, "COLORS-DONE");
    } else {
      await run(
        "printf '\\033[31mANSI-RED\\033[0m \\033[38;5;196mC256-196\\033[0m \\033[38;2;10;200;30mTRUECOLOR-0AC81E\\033[0m\\nCOLORS-DONE\\n'",
        "COLORS-DONE",
      );
    }
    const styles = await s.execute(`
      const find = (text) => [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows span")].find((e) => e.textContent.includes(text));
      const info = (text) => { const e = find(text); return e ? { cls: e.className, color: getComputedStyle(e).color } : null; };
      return { red: info("ANSI-RED"), c256: info("C256-196"), truecolor: info("TRUECOLOR-0AC81E") };`);
    assert.match(styles.red.cls, /xterm-fg-1\b/, JSON.stringify(styles.red));
    assert.match(styles.c256.cls, /xterm-fg-196\b/, JSON.stringify(styles.c256));
    assert.equal(styles.truecolor.color, "rgb(10, 200, 30)");
    await app.screenshot("t01-colors");
  });

  test("wide and combining characters occupy the right number of cells", async () => {
    // Each pair of lines puts an X at the same column after different-width text.
    // Octal escapes keep the typed command ASCII: this test is about rendering widths, and
    // typing CJK through WebDriver depends on the platform's input method (IME is covered by
    // the UI tests). The bytes are 日本語, 🚀 and e + U+0301.
    await run(
      "printf '\\346\\227\\245\\346\\234\\254\\350\\252\\236X\\nabcdefX\\n\\360\\237\\232\\200X\\nabX\\ne\\314\\201X\\naX\\nWIDTH-DONE\\n'",
      /^WIDTH-DONE$/m,
    );
    const xs = await s.execute(`
      const rows = [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows > div")];
      const xOf = (prefix) => {
        const row = rows.find((r) => r.textContent.replaceAll("\\u00a0", " ").startsWith(prefix));
        if (!row) return null;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node; while ((node = walker.nextNode())) {
          const i = node.textContent.indexOf("X");
          if (i >= 0) { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); return Math.round(r.getBoundingClientRect().left); }
        }
        return null;
      };
      return [xOf("日本語X"), xOf("abcdefX"), xOf("🚀X"), xOf("abX"), xOf("e\\u0301X"), xOf("aX")];`);
    assert.ok(xs.every((x) => typeof x === "number"), JSON.stringify(xs));
    assert.ok(Math.abs(xs[0] - xs[1]) <= 1, `CJK: ${xs[0]} vs ${xs[1]}`);
    assert.ok(Math.abs(xs[2] - xs[3]) <= 1, `emoji: ${xs[2]} vs ${xs[3]}`);
    assert.ok(Math.abs(xs[4] - xs[5]) <= 1, `combining mark: ${xs[4]} vs ${xs[5]}`);
  });

  test("every terminal row is inside the visible terminal area", async () => {
    // A row pitch larger than the one the size was fitted with pushes the last rows under the
    // status bar, where a full-screen application's bottom line (htop's F10 Quit) is hidden.
    const m = await s.execute(`
      const host = document.querySelector(".terminal-pane:not([hidden]) .terminal-host");
      const rows = [...host.querySelectorAll(".xterm-rows > div")];
      const h = host.getBoundingClientRect();
      const last = rows.at(-1).getBoundingClientRect();
      const first = rows[0].getBoundingClientRect();
      const bar = document.querySelector(".statusbar")?.getBoundingClientRect();
      return { count: rows.length, hostTop: h.top, hostBottom: h.bottom, firstTop: first.top, lastBottom: last.bottom,
        rowHeight: first.height, barTop: bar?.top ?? null, dpr: devicePixelRatio,
        hit: String(document.elementFromPoint(last.left + 4, last.top + last.height / 2)?.className ?? "").slice(0, 60) };`);
    const detail = JSON.stringify(m);
    assert.ok(m.lastBottom <= m.hostBottom + 0.5, `last row ends below the terminal area: ${detail}`);
    assert.ok(m.barTop === null || m.lastBottom <= m.barTop + 0.5, `last row overlaps the status bar: ${detail}`);
    assert.doesNotMatch(m.hit, /statusbar/, detail);
  });

  test("Ctrl+C interrupts a running command", async () => {
    // `&&`, not `;`: after an interrupted command some shells (zsh) go on with the rest of a
    // `;` list, others (bash) abandon it. With `&&` the echo runs only if sleep was not killed.
    const started = Date.now();
    await t.type("sleep 30 && echo NOT-INTERRUPTED\n");
    await new Promise((r) => setTimeout(r, 300));
    await s.chord([KEYS.ctrl, "C"]);
    await run("echo after-$((20+22))", "after-42");
    assert.ok(Date.now() - started < 20_000, "the sleep was interrupted, not waited out");
    // The command line itself contains the word; the output line must not appear.
    assert.doesNotMatch(await t.terminalText(), /^NOT-INTERRUPTED\s*$/m);
  });

  test("vim: alternate screen, editing, save and exit restore the shell screen", { skip: !appAvailable("vim") && "BLOCKED: vim is not installed on the lab server" }, async () => {
    await run("echo before-vim", "before-vim");
    await t.type(`${appCmd("vim")} -u NONE -N -n /tmp/tyr-vim-$$.txt\n`);
    await t.waitForText(/^~\s*$/m, "vim empty buffer");
    assert.ok(!(await t.terminalText()).includes("before-vim"), "vim uses the alternate screen");
    await t.type("ihello from vim");
    await s.chord([KEYS.escape]);
    await t.type(":wq");
    await s.chord([KEYS.enter]);
    await t.waitForText("before-vim", "shell screen restored after vim");
    await run("printf 'vim:'; cat /tmp/tyr-vim-$$.txt; rm -f /tmp/tyr-vim-$$.txt", /^vim:hello from vim$/m);
  });

  test("nano: keyboard shortcuts with Ctrl write and exit", { skip: !appAvailable("nano") && "BLOCKED: nano is not installed on the lab server" }, async () => {
    await t.type(`${appCmd("nano")} --ignorercfile /tmp/tyr-nano-$$.txt\n`);
    await t.waitForText("GNU nano", "nano title bar");
    await t.type("hello from nano");
    await s.chord([KEYS.ctrl, "O"]);
    // nano before 8 says "File Name to Write", later versions "Write to File".
    await t.waitForText(/File Name to Write|Write to File/i, "nano save prompt");
    await s.chord([KEYS.enter]);
    await t.waitForText(/Wrote 1 line/i, "nano saved the file");
    await s.chord([KEYS.ctrl, "X"]);
    await t.waitForText(/^tyr\$\s*$/m, "shell prompt after nano");
    await run("printf 'nano:'; cat /tmp/tyr-nano-$$.txt; rm -f /tmp/tyr-nano-$$.txt", /^nano:hello from nano$/m);
    await app.screenshot("t02-after-nano");
  });

  test("tmux: status line, split panes with box drawing, exit", { skip: !appAvailable("tmux") && "BLOCKED: tmux is not installed on the lab server" }, async () => {
    await t.type(`${appCmd("tmux")} -f /dev/null new-session -s tyrlab\n`);
    await t.waitForText("[tyrlab]", "tmux status line");
    await s.chord([KEYS.ctrl, "B"]);
    await t.type("%");
    await s.until(async () => ((await t.terminalText()).match(/│/g) ?? []).length >= 5, { describe: "vertical pane border" });
    await app.screenshot("t03-tmux");
    await t.type("exit\n");
    await new Promise((r) => setTimeout(r, 400));
    await t.type("exit\n");
    await t.waitForText(/\[exited\]/, "tmux exited");
  });

  test("htop: full-screen redraw and mouse reporting (click F10 Quit)", { skip: !appAvailable("htop") && "BLOCKED: htop is not installed on the lab server" }, async () => {
    await t.type(`${appCmd("htop")}\n`);
    await t.waitForText(/Load average|Tasks:/, "htop header");
    await app.screenshot("t04-htop");
    const box = await s.execute(`
      const spans = [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows span")].filter((e) => e.textContent.includes("Quit"));
      const e = spans.at(-1); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    assert.ok(box, "the function key bar shows Quit");
    // Where the click actually lands (diagnostic for platforms whose pointer mapping differs).
    await s.execute(`window.__tyrClicks = []; document.addEventListener("mousedown", (e) => window.__tyrClicks.push({ x: e.clientX, y: e.clientY, target: String(e.target.className).slice(0, 40), trusted: e.isTrusted }), { capture: true, once: true });`);
    try {
      await s.clickAt(box.x, box.y);
      await t.waitForText(/^tyr\$\s*$/m, "shell prompt after clicking Quit").catch(async (error) => {
        const clicks = await s.execute("return JSON.stringify(window.__tyrClicks)").catch(() => "?");
        throw new Error(`${error.message}\n--- click aimed at ${JSON.stringify(box)}, received ${clicks}`);
      });
    } finally {
      // Never leave htop running for the next test: F10 quits if the click did not.
      if (/Load average|Tasks:|F10Quit|Environment of process/.test(await t.terminalText())) {
        await s.chord([KEYS.escape]);
        await s.chord([KEYS.f10]);
      }
    }
    await run("echo after-htop", "after-htop");
  });

  test("mc: panels with box drawing, function keys, quit dialog", { skip: !appAvailable("mc") && "BLOCKED: mc is not installed on the lab server" }, async () => {
    await t.type(`${appCmd("mc")} -u\n`);
    await t.waitForText(/Left\s+File\s+Command/, "mc menu bar");
    const text = await t.terminalText();
    assert.match(text, /[┌┐└┘─│]/, "panel borders are box-drawing characters");
    await app.screenshot("t05-mc");
    // F10 quits (current mc versions do not ask for confirmation by default).
    await s.chord([KEYS.f10]);
    await t.waitForText(/^tyr\$\s*$/m, "shell prompt after mc");
    await run("echo after-mc", "after-mc");
  });

  test("resize reaches the remote side", async () => {
    // The pane gets narrower when the snippets panel opens and wider when it closes; the window
    // size is fixed by the test runner. Each change must reach the remote PTY.
    const size = async (marker) => {
      const text = await run(`clear; stty size; echo ${marker}`, marker);
      const [, rows, cols] = new RegExp(`(\\d+) (\\d+)\\s*\\n.*${marker}`).exec(text) ?? [];
      return { rows: Number(rows), cols: Number(cols) };
    };
    const before = await size("SIZE-A");
    await s.click(await s.waitFor('.statusbar button[aria-pressed]'));
    await s.waitFor(".side-panel");
    await new Promise((r) => setTimeout(r, 400));
    await s.click(await s.waitFor(".terminal-pane:not([hidden]) .xterm-helper-textarea"));
    const narrow = await size("SIZE-B");
    assert.ok(narrow.cols < before.cols - 20, `columns shrank with the panel open: ${before.cols} → ${narrow.cols}`);
    assert.equal(narrow.rows, before.rows);
    await s.click(await s.waitFor('.statusbar button[aria-pressed="true"]'));
    await s.waitGone(".side-panel");
    await new Promise((r) => setTimeout(r, 400));
    await s.click(await s.waitFor(".terminal-pane:not([hidden]) .xterm-helper-textarea"));
    const restored = await size("SIZE-C");
    assert.equal(restored.cols, before.cols, "the original width came back");
  });

  test("malformed and hostile escape sequences change nothing outside the terminal", async () => {
    const corpus = [
      "\\033[", // incomplete CSI
      "\\033[99999999999999999999A\\033[99999999999999999999;99999999999999999999H", // overflowing params
      "\\033]0;<img src=x onerror=alert(1)>\\007", // HTML-looking title
      "\\033]2;\\342\\200\\256gnp.exe\\007", // bidi override in a title
      "\\033P1;2|unterminated DCS", // DCS without ST
      "\\033\\\\",
      "\\377\\376\\300\\200", // invalid UTF-8
      "\\302\\233 31m", // 8-bit CSI as UTF-8 C1
      "\\033]52;c;?\\007", // clipboard read request: never answered
      "\\033]8;;javascript:alert(1)\\033\\\\js-link\\033]8;;\\033\\\\", // non-web hyperlink
      "\\033]1337;File=name=eA==;inline=1:AAAA\\007", // iTerm2 image protocol
      "\\033_Gf=100;AAAA\\033\\\\", // kitty graphics
      "\\033[?1049h\\033[?1049l", // alternate screen toggle
      "\\033c", // full reset
    ];
    await t.type(`printf '${corpus.join("")}'; head -c 30000 /dev/zero | tr '\\\\0' A | sed 's/^/\\x1b]2;/'; printf '\\007'; echo; echo corpus-end\n`);
    await t.waitForText("corpus-end", "the terminal survives the corpus");
    const page = await s.execute(`return {
      dialogs: document.querySelectorAll("dialog[open]").length,
      images: document.querySelectorAll(".tabstrip img, .terminal-pane img").length,
      title: document.querySelector('.tabstrip [aria-selected="true"]')?.textContent ?? "",
      bidi: /[\\u202a-\\u202e\\u2066-\\u2069]/.test(document.querySelector(".tabstrip")?.textContent ?? ""),
    };`);
    assert.equal(page.dialogs, 0, "no dialog was opened by output");
    assert.equal(page.images, 0, "no image or markup was created from output");
    assert.equal(page.bidi, false, "bidirectional controls were stripped from the title");
    assert.ok(page.title.length < 200, "the remote title is bounded");
    // Still interactive afterwards.
    await run("echo alive-$((6*7))", "alive-42");
    await app.screenshot("t06-after-corpus");
  });

  test("the session status bar reports the renderer and size", async () => {
    const status = await t.statusText();
    assert.match(status, /Renderer: Compatibility/);
    assert.match(status, /\d+×\d+/);
  });
});

describe("GPU renderer in the real WebView", { concurrency: false }, () => {
  test("the WebGL renderer is used when the WebView supports it, otherwise the fallback is reported", async () => {
    const app = await App.launch({ prefs: { theme: "dark", terminal: { renderer: "auto", cursorBlink: false } } });
    try {
      const s = app.session;
      const t = ui(s);
      await t.createVault();
      await s.clickButton("Local terminal", { within: "nav.sidebar" });
      await s.until(async () => /Connected/.test(await t.statusText()), { describe: "local shell" });
      const status = await t.statusText();
      const webgl = await s.execute(`const c = document.createElement("canvas"); return !!c.getContext("webgl2");`);
      const renderer = await s.execute(`return document.querySelector(".terminal-pane:not([hidden]) .terminal-host")?.dataset.renderer ?? null`);
      // Record what this platform's WebView did; both outcomes are valid, a mismatch is not.
      assert.equal(renderer, webgl ? "webgl" : "dom", `WebGL2 available: ${webgl}`);
      assert.match(status, webgl ? /Renderer: GPU/ : /Renderer: Compatibility/);
      await app.screenshot(`t07-renderer-${renderer}`);
    } finally {
      await app.quit();
    }
  });
});

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

  test("text composed through an input method reaches the shell once, as UTF-8 (TRM-11)", async () => {
    // WebDriver cannot drive the platform IME, so the composition is played as the WebView
    // delivers it to the page: compositionstart, preedit updates in the input element, then
    // compositionend. Everything after that (xterm's composition handling, the encoder, IPC,
    // the core and the real shell) is the production path.
    // The ordered composition handling is installed on xterm's helper in this WebView too.
    assert.equal(await s.execute(`return document.querySelector(".pane[data-focused=true] .terminal-host")?.dataset.composition ?? null`), "ordered");
    // od reads the terminal line itself, so the bytes it prints are exactly what arrived: no
    // shell expansion or completion in between.
    await t.type("od -An -tx1; echo IME-DONE\n");
    await new Promise((r) => setTimeout(r, 300));
    const composed = await s.execute(`
      const ta = document.querySelector(".pane[data-focused=true] .xterm-helper-textarea");
      ta.focus();
      const at = ta.value.length;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      for (const preedit of ["に", "にほん", "にほんご"]) {
        ta.value = ta.value.slice(0, at) + preedit;
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: preedit }));
      }
      const preview = document.querySelector(".pane[data-focused=true] .composition-view");
      const shown = preview?.classList.contains("active") ? preview.textContent : null;
      ta.value = ta.value.slice(0, at) + "日本語";
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語" }));
      return shown;`);
    assert.equal(composed, "にほんご", "the preedit text is shown while composing");
    await t.type("\n");
    await s.chord([KEYS.ctrl, "D"]);
    const text = await t.waitForText(/^IME-DONE$/m, "od output");
    // The nine UTF-8 bytes of 日本語 and the newline, once.
    assert.match(text, /^\s*e6 97 a5 e6 9c ac e8 aa 9e 0a\s*$/m);
  });

  test("every terminal row is inside the visible terminal area", async () => {
    // A row pitch larger than the one the size was fitted with pushes the last rows under the
    // status bar, where a full-screen application's bottom line (htop's F10 Quit) is hidden.
    const m = await s.execute(`
      const host = document.querySelector(".terminal-pane:not([hidden]) .terminal-host");
      const rows = [...host.querySelectorAll(".xterm-rows > div")];
      const h = host.getBoundingClientRect();
      const screen = host.querySelector(".xterm-screen").getBoundingClientRect();
      const last = rows.at(-1).getBoundingClientRect();
      const first = rows[0].getBoundingClientRect();
      const bar = document.querySelector(".statusbar")?.getBoundingClientRect();
      return { count: rows.length, hostTop: h.top, hostBottom: h.bottom, hostRight: h.right, screenRight: screen.right, firstTop: first.top, lastBottom: last.bottom,
        rowHeight: first.height, barTop: bar?.top ?? null, dpr: devicePixelRatio,
        hit: String(document.elementFromPoint(last.left + 4, last.top + last.height / 2)?.className ?? "").slice(0, 60) };`);
    const detail = JSON.stringify(m);
    assert.ok(m.lastBottom <= m.hostBottom + 0.5, `last row ends below the terminal area: ${detail}`);
    assert.ok(m.screenRight <= m.hostRight + 0.5, `last column ends past the terminal area: ${detail}`);
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
    await s.click(await s.waitFor('.statusbar button[data-panel="snippets"]'));
    await s.waitFor(".side-panel");
    await new Promise((r) => setTimeout(r, 400));
    await s.click(await s.waitFor(".terminal-pane:not([hidden]) .xterm-helper-textarea"));
    const narrow = await size("SIZE-B");
    assert.ok(narrow.cols < before.cols - 20, `columns shrank with the panel open: ${before.cols} → ${narrow.cols}`);
    assert.equal(narrow.rows, before.rows);
    await s.click(await s.waitFor('.statusbar button[data-panel="snippets"][aria-pressed="true"]'));
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

/** The command palette shortcut: Cmd+K on macOS, Ctrl+Shift+K elsewhere (lib/shortcuts.ts). */
const PALETTE = process.platform === "darwin" ? [KEYS.meta, "K"] : [KEYS.ctrl, KEYS.shift, "K"];

describe("workspaces with real sessions", { concurrency: false }, () => {
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
    await t.type("export PS1='tyr$ '; clear\n");
    await t.waitForText("tyr$");
  });

  after(async () => {
    await app?.quit();
  });

  const tabState = (name) =>
    s.execute(
      `const tab = [...document.querySelectorAll(".tabstrip .tab:not(.tab-page)")].find((e) => e.textContent.includes(${JSON.stringify(name)}));
       return tab ? { status: tab.dataset.status ?? null, unread: tab.dataset.unread ?? null, selected: tab.getAttribute("aria-selected"), name: tab.textContent } : null;`,
    );
  /** Clicks a terminal tab with a real pointer. */
  const clickTab = async (name) => {
    const rect = await s.until(
      () =>
        s.execute(
          `const e = [...document.querySelectorAll(".tabstrip .tab:not(.tab-page)")].find((e) => e.textContent.includes(${JSON.stringify(name)}));
           if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + 12, y: r.y + r.height / 2 };`,
        ),
      { describe: `tab ${name}` },
    );
    await s.clickAt(rect.x, rect.y);
  };
  const selectTab = (name) => clickTab(name);

  test("output from a background SSH session marks its tab unread until it is shown", async () => {
    await t.type("sleep 2; echo LATE-$((40+2))\n");
    await s.clickButton("Local terminal", { within: "nav.sidebar" });
    await s.until(async () => (await tabState("Local terminal"))?.status === "ok", { describe: "local shell" });
    assert.equal((await tabState("Lab")).unread, null, "nothing unseen yet");
    await s.until(async () => (await tabState("Lab"))?.unread === "true", { describe: "Lab tab marked unread", timeout: 10_000 });
    await selectTab("Lab");
    await t.waitForText("LATE-42");
    await s.until(async () => (await tabState("Lab"))?.unread === null, { describe: "unread cleared" });
    await app.screenshot("w01-unread-cleared");
  });

  test("duplicating a tab opens a new, separate session to the same host", async () => {
    await selectTab("Lab");
    await t.type("echo ORIGINAL-$((1+1))\n");
    await t.waitForText("ORIGINAL-2");
    // Keyboard route: the command palette's "Duplicate tab" acts on the tab in front.
    await s.chord(PALETTE);
    const palette = await s.waitFor("dialog.palette input");
    await s.type(palette, "Duplicate tab");
    await s.until(() => s.execute(`return document.querySelector('dialog.palette [role="option"][aria-selected="true"]')?.textContent?.includes("Duplicate tab") || null`), {
      describe: "palette match",
    });
    await s.chord([KEYS.enter]);
    const labTabs = () => s.execute(`return [...document.querySelectorAll(".tabstrip .tab:not(.tab-page)")].filter((e) => e.textContent.includes("Lab")).length`);
    await s.until(async () => ((await labTabs()) === 2 ? true : null), { describe: "a second Lab tab" }).catch(async (e) => {
      const state = await s.execute(`return JSON.stringify({ tabs: [...document.querySelectorAll(".tabstrip .tab")].map((e) => e.textContent), dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.className + ":" + d.textContent.slice(0, 80)) })`);
      throw new Error(`${e.message} ${state}`);
    });
    // A new session is a new server connection: the host key is confirmed again ("Trust once").
    await s.until(async () => (await s.find("dialog .fingerprint")) !== null, { describe: "trust prompt for the copy" });
    await s.clickButton("Trust once", { within: "dialog" });
    await s.waitGone("dialog");
    await s.until(async () => /Connected/.test(await t.statusText()), { describe: "copy connected" });
    const tabs = await s.execute(`return [...document.querySelectorAll(".tabstrip .tab:not(.tab-page)")].map((e) => e.textContent)`);
    assert.equal(tabs.filter((x) => x.includes("Lab")).length, 2, JSON.stringify(tabs));
    // Its screen starts fresh: nothing from the original tab is replayed into it.
    await t.waitForText(/^\$/m, "a prompt in the copy");
    assert.doesNotMatch(await t.terminalText(), /ORIGINAL-2/);
    await t.type("echo COPY-$((2+2))\n");
    await t.waitForText("COPY-4");
    await app.screenshot("w02-duplicate");
  });

  test("16 panes of real local shells: the limit holds, a grid tiles them, input reaches only the focused one", async () => {
    await s.clickButton("Local terminal", { within: "nav.sidebar" });
    await s.until(async () => (await tabState("Local terminal"))?.status === "ok", { describe: "local shell" });
    const visibleCount = () => s.execute(`return document.querySelectorAll(".pane:not([hidden])").length`);
    const total = () => s.execute(`return document.querySelectorAll(".pane").length`);
    // Other tabs already hold panes; split until 16 are open in all (the grid below re-tiles them).
    const runCommand = async (name) => {
      await s.chord(PALETTE);
      const input = await s.waitFor("dialog.palette input");
      await s.type(input, name);
      await s.until(() => s.execute(`return document.querySelector('dialog.palette [role="option"][aria-selected="true"]')?.textContent?.includes(${JSON.stringify(name)}) || null`), { describe: name });
      await s.chord([KEYS.enter]);
      await s.waitGone("dialog.palette");
    };
    for (let i = 0; (await total()) < 16 && i < 16; i += 1) {
      const before = await total();
      // The palette first, then the focused pane's own header button.
      const button = i === 0 ? null : await s.find('.pane:not([hidden])[data-focused="true"] .pane-header button[aria-label="Split pane right"]');
      if (button) await s.click(button);
      else await runCommand("Split pane right");
      await s.until(async () => (await total()) === before + 1, { describe: `pane ${before + 1}` });
    }
    assert.equal(await total(), 16);
    // Repeated halving leaves the newest panes very narrow; tile them before using their headers.
    await runCommand("Arrange panes in a grid");
    await s.click(await s.waitFor('.pane:not([hidden])[data-focused="true"] .pane-header button[aria-label="Split pane right"]'));
    await s.until(() => s.execute(`return document.body.textContent.includes("At most 16 panes can be open")`), { describe: "limit message" }).catch(async (e) => {
      const state = await s.execute(`return JSON.stringify({ panes: document.querySelectorAll(".pane").length, focused: document.querySelector('.pane:not([hidden])[data-focused="true"]')?.getBoundingClientRect(), toasts: document.querySelector(".toasts, [role=region]")?.outerHTML?.slice(0, 300) })`);
      throw new Error(`${e.message} ${state}`);
    });
    assert.equal(await total(), 16);
    const mine = await visibleCount();
    // Every local pane reaches a connected shell.
    await s.until(
      () => s.execute(`return [...document.querySelectorAll(".pane:not([hidden]) .status-dot")].filter((d) => d.dataset.tone === "ok").length`).then((n) => (n === mine ? n : null)),
      { describe: "all panes connected", timeout: 30_000 },
    );
    // A literal token: the local shell differs per platform (PowerShell on Windows), and the point
    // is where the input goes, not what the shell computes.
    await t.type("echo ONLY-HERE-42\n");
    await s.until(
      () => s.execute(`return [...document.querySelectorAll(".pane:not([hidden]) .xterm-rows")].filter((e) => e.textContent.includes("ONLY-HERE-42")).length`).then((n) => (n > 0 ? n : null)),
      { describe: "echo in the focused pane" },
    );
    const panesWithText = await s.execute(`return [...document.querySelectorAll(".pane:not([hidden])")].filter((p) => p.querySelector(".xterm-rows")?.textContent.includes("ONLY-HERE-42")).map((p) => p.dataset.focused)`);
    assert.deepEqual(panesWithText, ["true"], "only the focused pane received the input");
    await app.screenshot("w03-sixteen-panes");
  });

  test("a saved layout restores disconnected; only Connect opens a new session", async () => {
    const runCommand = async (name) => {
      await s.chord(PALETTE);
      const input = await s.waitFor("dialog.palette input");
      await s.type(input, name);
      await s.until(() => s.execute(`return document.querySelector('dialog.palette [role="option"][aria-selected="true"]')?.textContent?.includes(${JSON.stringify(name)}) || null`), { describe: name });
      await s.chord([KEYS.enter]);
      await s.waitGone("dialog.palette");
    };
    // Close every tab, then start from one SSH tab to the lab.
    for (let i = 0; i < 8 && (await s.find(".tabstrip .tab-close")); i += 1) await s.click(await s.find(".tabstrip .tab-close"));
    await s.until(() => s.execute(`return document.querySelectorAll(".pane").length === 0 || null`), { describe: "no panes" });
    await t.connect("Lab");
    await t.type("echo NOT-IN-TEMPLATE-$((3*3))\n");
    await t.waitForText("NOT-IN-TEMPLATE-9");
    await runCommand("Save layout as");
    await s.fill("Layout name", "Lab layout", { within: "dialog" });
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");
    await s.until(() => s.execute(`return document.querySelector(".tab-layout")?.textContent?.includes("Lab layout") || null`), { describe: "layout indicator" });

    await s.click(await s.waitFor(".tabstrip .tab-close"));
    await s.until(() => s.execute(`return document.querySelectorAll(".pane").length === 0 || null`), { describe: "tab closed" });
    await runCommand("Open layout “Lab layout”");
    await s.waitFor(".pane:not([hidden]) .overlay-card");
    // No session exists for the restored pane: no terminal, no xterm, nothing received.
    const restored = await s.execute(`return { xterm: document.querySelectorAll(".pane:not([hidden]) .xterm").length, status: document.querySelector(".statusbar")?.textContent ?? "" }`);
    assert.equal(restored.xterm, 0, "no terminal was started");
    assert.doesNotMatch(restored.status, /Connected/);
    await s.clickButton("Connect", { within: ".pane:not([hidden]) .overlay-card" });
    await s.until(async () => (await s.find("dialog .fingerprint")) !== null, { describe: "trust prompt for the restored pane" });
    await s.clickButton("Trust once", { within: "dialog" });
    await s.waitGone("dialog");
    await s.until(async () => /Connected/.test(await t.statusText()), { describe: "restored pane connected" });
    // A fresh session: the earlier output is not replayed.
    await t.waitForText(/\$/, "a prompt");
    assert.doesNotMatch(await t.terminalText(), /NOT-IN-TEMPLATE-9/);
    await app.screenshot("w04-layout-restored");
  });
});

describe("a tab moved to its own window", { concurrency: false }, () => {
  test("the live SSH session moves with it and keeps delivering output there; the main window lets it go", async () => {
    const app = await App.launch({ prefs: DOM_RENDERER_PREFS });
    try {
      const s = app.session;
      const t = ui(s);
      await t.createVault();
      await t.importKey(lab.keys.ed25519);
      await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
      await t.connect("Lab");
      await t.type("export PS1='tyr$ '; echo BEFORE-$((2+3))\n");
      await t.waitForText("BEFORE-5");
      const main = await s.windowHandle();
      // Started here, printed after the move: the same shell keeps running in the new window.
      await t.type("sleep 4; echo LATE-$((5+6))\n");

      await s.chord(PALETTE);
      const input = await s.waitFor("dialog.palette input");
      await s.type(input, "Move tab to a new window");
      await s.until(() => s.execute(`return document.querySelector('dialog.palette [role="option"][aria-selected="true"]')?.textContent?.includes("Move tab") || null`), {
        describe: "palette match",
      });
      await s.chord([KEYS.enter]);
      // The tab leaves the main window without ending its session.
      await s.until(() => s.execute(`return document.querySelectorAll(".tabstrip .tab:not(.tab-page)").length === 0 || null`), { describe: "tab gone from main" });
      const handles = await s.until(async () => {
        const list = await s.windowHandles();
        return list.length === 2 ? list : null;
      }, { describe: "a second window", timeout: 20_000 });
      await s.switchToWindow(handles.find((h) => h !== main));
      await s.until(() => s.execute(`return document.querySelector(".detached-head")?.textContent?.includes("Lab") || null`), { describe: "detached window shows the tab", timeout: 20_000 });
      await t.waitForText("LATE-11", "output of the moved session arrives in the new window", 20_000);
      // A fresh terminal here: earlier screen contents do not move with the tab.
      assert.doesNotMatch(await t.terminalText(), /BEFORE-5/);
      await app.screenshot("w05-detached");
      // The embedded WebDriver sends keys to the main window only, so typing here is covered by
      // the UI test and the core lab test (only the new window may write after the handoff).
      await s.switchToWindow(main);
      assert.equal(await s.execute(`return document.querySelectorAll(".pane").length`), 0, "the main window holds no pane of the moved tab");
    } finally {
      await app.quit();
    }
  });
});

describe("output highlighting patterns in the real WebView (TRM-07)", { concurrency: false }, () => {
  test("patterns from saved preferences match in a worker; a slow one is switched off and the shell stays usable", async () => {
    const rule = (text, tone, pattern) => ({ text, tone, caseSensitive: false, pattern });
    const app = await App.launch({
      prefs: {
        ...DOM_RENDERER_PREFS,
        workspace: {
          highlight: {
            enabled: true,
            ipAddresses: false,
            keywords: [rule("[a-z]{0,99}[a-z]*[a-z]*[a-z]*!", "warning", true), rule("user=\\w+", "info", true), rule("ok", "danger", false)],
          },
          bindings: [],
          optionAsMeta: false,
          rightClickSelectsWord: false,
        },
      },
    });
    try {
      const s = app.session;
      const t = ui(s);
      await t.createVault();
      // The lab's POSIX shell on every platform (Windows' local shell is not one).
      await t.importKey(lab.keys.ed25519);
      await t.addHost({ label: "Lab", port: lab.servers.a.port, user: lab.user });
      await t.connect("Lab");
      // Lines of letters with no "!": the first pattern backtracks for a long time on them.
      await t.type("printf 'login user=alice ok\\n'; for i in $(seq 1 30); do printf '%0150d\\n' 0 | tr 0 a; done; echo HL-DONE\n");
      await t.waitForText(/^HL-DONE$/m, "output");
      await s
        .until(() => s.execute(`return document.body.textContent.includes("took too long and was switched off") || null`), {
          describe: "slow pattern notice",
          timeout: 15_000,
        })
        .catch(async (error) => {
          const marks = await s.execute(`return [...document.querySelectorAll(".term-highlight")].map((e) => e.dataset.tone).join(",")`).catch(() => "?");
          throw new Error(`${error.message}; decorations: ${marks}`);
        });
      // The other rules are drawn (the pattern by the worker, the word on the page).
      await t.type("clear; printf 'login user=alice ok\\n'\n");
      const tones = await s.until(
        () =>
          s.execute(`const t = [...document.querySelectorAll(".pane:not([hidden]) .term-highlight")].map((e) => e.dataset.tone).sort(); return t.length === 2 ? t : null`),
        { describe: "highlight decorations" },
      ).catch(async (error) => {
        const marks = await s.execute(`return [...document.querySelectorAll(".pane:not([hidden]) .term-highlight")].map((e) => e.dataset.tone).join(",")`).catch(() => "?");
        throw new Error(`${error.message}; decorations: ${marks}; screen: ${(await t.terminalText()).slice(-300)}`);
      });
      assert.deepEqual(tones, ["danger", "info"]);
      await t.type("echo STILL-HERE\n");
      await t.waitForText(/^STILL-HERE$/m, "shell responsive");
    } finally {
      await app.quit();
    }
  });
});

// Minimal W3C WebDriver client for the embedded server in e2e builds (tauri-plugin-wdio-webdriver).
// Plain `fetch` against loopback: no browser driver, no WebdriverIO dependency tree.

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export class WebDriverError extends Error {
  constructor(command, payload) {
    super(`${command}: ${payload?.error ?? "error"} — ${payload?.message ?? JSON.stringify(payload)}`);
    this.name = "WebDriverError";
    this.code = payload?.error;
  }
}

export class Session {
  #base;
  #id;

  constructor(base, id) {
    this.#base = base;
    this.#id = id;
  }

  static async create(port) {
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
    });
    const body = await response.json();
    if (!response.ok || !body.value?.sessionId) throw new WebDriverError("new session", body.value);
    return new Session(base, body.value.sessionId);
  }

  /** Sets the W3C session timeouts (milliseconds). */
  setTimeouts(timeouts) {
    return this.#call("POST", "/timeouts", timeouts);
  }

  /**
   * Waits until the application document has finished loading. On WebKitGTK a script evaluation
   * issued while the first page load is still in progress can be dropped and never answer, so
   * readiness is probed with a short script timeout before the default one is restored.
   */
  async waitForDocument({ timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    await this.setTimeouts({ script: 2_000 });
    try {
      for (;;) {
        try {
          const state = await this.#call("POST", "/execute/sync", { script: "return document.readyState + ':' + !!document.querySelector('#root > *')", args: [] }, 5_000);
          if (state === "complete:true") return;
        } catch (error) {
          if (Date.now() > deadline) throw new Error(`application document did not load: ${error.message}`);
        }
        if (Date.now() > deadline) throw new Error("application document did not load");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await this.setTimeouts({ script: 30_000 });
    }
  }

  async #call(method, path, payload, timeoutMs = 35_000) {
    const response = await fetch(`${this.#base}/session/${this.#id}${path}`, {
      method,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      // A command that never answers must fail the test, not hang the run. Longer than the
      // server's own 30 s script timeout, so its error (not an abort) is what gets reported.
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.value?.error) throw new WebDriverError(`${method} ${path}`, body.value);
    return body.value;
  }

  /** Finds one element by CSS selector, or returns null. */
  async find(selector) {
    try {
      const value = await this.#call("POST", "/element", { using: "css selector", value: selector });
      return value[ELEMENT_KEY];
    } catch (error) {
      if (error.code === "no such element") return null;
      throw error;
    }
  }

  async findAll(selector) {
    const value = await this.#call("POST", "/elements", { using: "css selector", value: selector });
    return value.map((entry) => entry[ELEMENT_KEY]);
  }

  /** Waits for an element, polling on explicit state rather than sleeping blindly. */
  async waitFor(selector, { timeout = 15_000, describe = selector } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const element = await this.find(selector);
      if (element) return element;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async waitGone(selector, { timeout = 15_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (await this.find(selector)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${selector} to disappear`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Waits until `probe()` returns a truthy value and returns it. */
  async until(probe, { timeout = 15_000, describe = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value;
      try {
        value = await probe();
      } catch (error) {
        // The element was replaced by a re-render between lookup and use: look again.
        if (error.code !== "stale element reference") throw error;
      }
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  click(element) {
    return this.#call("POST", `/element/${element}/click`, {});
  }

  type(element, text) {
    return this.#call("POST", `/element/${element}/value`, { text });
  }

  clear(element) {
    return this.#call("POST", `/element/${element}/clear`, {});
  }

  text(element) {
    return this.#call("GET", `/element/${element}/text`);
  }

  attribute(element, name) {
    return this.#call("GET", `/element/${element}/attribute/${name}`);
  }

  /** Runs a script in the page. Used for reading state the DOM API cannot express, never to bypass the UI. */
  execute(script, args = []) {
    return this.#call("POST", "/execute/sync", { script, args });
  }

  /** Runs a script that reports its result by calling the callback passed as its last argument. */
  executeAsync(script, args = []) {
    return this.#call("POST", "/execute/async", { script, args });
  }

  /**
   * Opens a saved host from the keyboard: focuses the button named `label` inside `container` (a
   * host name on Hosts) and presses Enter. Rows, cards and tiles have no Connect
   * button; Enter and double-click connect.
   */
  async openHost(container, label) {
    // Enter only once focus has stayed on the button between two polls: focus from a click that
    // led here (a nav item, say) can still land after an immediate focus() call.
    const focus = `const b = [...document.querySelectorAll(arguments[0] + " button")].find((x) => (x.getAttribute("aria-label") ?? x.textContent.trim()) === arguments[1]);
      if (!b) return false;
      if (document.activeElement === b) return true;
      b.focus();
      return false;`;
    await this.until(() => this.execute(focus, [container, label]), { describe: `${label} in ${container}` });
    await this.chord(["\uE007"]);
  }

  /** W3C actions: real key and pointer input dispatched by the WebDriver server. */
  async performActions(actions) {
    await this.#call("POST", "/actions", { actions });
    await this.#call("DELETE", "/actions");
  }

  /** Presses a chord, e.g. `chord(["\uE009", "c"])` for Ctrl+C (W3C key codes for modifiers). */
  chord(keys) {
    const down = keys.map((value) => ({ type: "keyDown", value }));
    const up = [...keys].reverse().map((value) => ({ type: "keyUp", value }));
    return this.performActions([{ type: "key", id: "keyboard", actions: [...down, ...up] }]);
  }

  /** Clicks at viewport coordinates with a real pointer (mouse down/up at that position). */
  clickAt(x, y, button = 0) {
    return this.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: Math.round(x), y: Math.round(y) },
          { type: "pointerDown", button },
          { type: "pointerUp", button },
        ],
      },
    ]);
  }

  setWindowRect(rect) {
    return this.#call("POST", "/window/rect", rect);
  }

  getWindowRect() {
    return this.#call("GET", "/window/rect");
  }

  // agent C: workspaces — several application windows (a detached tab).
  windowHandles() {
    return this.#call("GET", "/window/handles");
  }

  windowHandle() {
    return this.#call("GET", "/window");
  }

  switchToWindow(handle) {
    return this.#call("POST", "/window", { handle });
  }

  /** PNG screenshot of the WebView contents as a Buffer. */
  async screenshot() {
    return Buffer.from(await this.#call("GET", "/screenshot"), "base64");
  }

  /**
   * Clicks the first button whose visible text is `label`. A leading decorative glyph (as on the
   * navigation buttons) is ignored, so the match is on the words a user reads.
   */
  async clickButton(label, { within = "body", timeout = 15_000 } = {}) {
    const element = await this.until(
      async () => {
        for (const candidate of await this.findAll(`${within} button`)) {
          const text = (await this.text(candidate)).replace(/\s+/g, " ").trim();
          if (text === label || text.replace(/^[^\p{L}\p{N}]+/u, "") === label) return candidate;
        }
        return null;
      },
      { timeout, describe: `button "${label}"` },
    );
    await this.click(element);
  }

  /** Types into the input associated with the label whose text is exactly `label`. */
  async fill(label, text, { within = "body" } = {}) {
    const id = await this.until(
      () =>
        this.execute(
          `const root = document.querySelector(arguments[0]);
           const label = [...(root?.querySelectorAll("label") ?? [])].find((l) => l.textContent.trim() === arguments[1]);
           return label?.htmlFor || null;`,
          [within, label],
        ),
      { describe: `field "${label}"` },
    );
    const element = await this.waitFor(`[id="${id}"]`);
    await this.click(element);
    await this.type(element, text);
    return element;
  }

  async close() {
    await this.#call("DELETE", "", undefined).catch(() => undefined);
  }
}

export async function waitForServer(port, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`embedded WebDriver server did not start on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

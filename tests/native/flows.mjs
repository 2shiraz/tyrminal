// Shared flows for native suites: everything goes through the real UI of the real application.

import { readFileSync } from "node:fs";

export const PASSPHRASE = "native e2e passphrase 42";
export const KEYS = { ctrl: "", shift: "", alt: "", meta: "", enter: "", escape: "", f10: "" };

export function ui(s) {
  const NAV_IDS = { Home: "home", Hosts: "hosts", Snippets: "snippets", Keychain: "keychain", "Known hosts": "knownHosts", Settings: "settings" };
  const api = {
    heading: () => s.until(() => s.execute(`return document.querySelector("h1")?.textContent ?? null`), { describe: "a heading" }),
    nav: async (label) => s.click(await s.waitFor(`nav.sidebar [data-nav="${NAV_IDS[label]}"]`)),
    statusText: async () => s.text(await s.waitFor(".statusbar")),
    /** Visible terminal text (DOM renderer), with non-breaking spaces normalized. */
    terminalText: () =>
      s.execute(`return [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows")].map((e) => e.innerText.replaceAll("\\u00a0", " ")).join("\\n")`),
    async waitForText(pattern, describe = String(pattern), timeout = 15_000) {
      try {
        return await s.until(async () => {
          const text = await api.terminalText();
          return (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)) ? text : null;
        }, { describe, timeout });
      } catch (error) {
        const screen = (await api.terminalText().catch(() => "")).split("\n").slice(-25).join("\n");
        // Row-by-row DOM text (textContent, independent of layout) shows whether rows were
        // updated but not painted, or never updated.
        const rows = await s
          .execute(`const r = [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows > div")]; return r.length + " rows; nonblank: " + JSON.stringify(r.map((e, i) => [i, e.textContent.replaceAll("\\u00a0", " ").trimEnd()]).filter(([, t]) => t).map(([i, t]) => i + ":" + t.slice(0, 40)))`)
          .catch(() => "?");
        const io = await s
          .execute(`const h = document.querySelector(".terminal-pane:not([hidden]) .terminal-host"); return h ? JSON.stringify({ ...h.dataset }) : "no terminal"`)
          .catch(() => "?");
        const status = await api.statusText().catch(() => "?");
        const errors = await s.execute("return JSON.stringify(window.__tyrErrors ?? null)").catch(() => "?");
        throw new Error(`${error.message}\n--- terminal (io ${io}; status ${status.replaceAll("\n", " ")}; page errors ${errors}) ---\n${screen}\n--- rows ${rows}`);
      }
    },
    async type(text) {
      const input = await s.waitFor(".terminal-pane:not([hidden]) .xterm-helper-textarea");
      await s.type(input, text);
    },
    async createVault() {
      await s.until(async () => (await api.heading()) === "Create your local vault", { describe: "onboarding", timeout: 20_000 });
      await s.fill("Vault passphrase", PASSPHRASE);
      await s.fill("Repeat passphrase", PASSPHRASE);
      await s.clickButton("Create vault");
      await s.until(async () => (await api.heading()) === "Save your recovery key", { describe: "recovery key", timeout: 20_000 });
      const key = (await s.text(await s.waitFor(".recovery-key"))).trim().split(/\s+/);
      const prompt = await s.execute(`return [...document.querySelectorAll("label")].map((l) => l.textContent).find((t) => t.includes("type group"))`);
      const group = Number(/group (\d+)/.exec(prompt)[1]);
      await s.fill(prompt, key[group - 1]);
      await s.clickButton("I have saved it");
      await s.until(async () => (await api.heading()) === "Home", { describe: "home" });
      return key.join("-");
    },
    async importKey(path, label = "lab key") {
      await api.nav("Keychain");
      await s.clickButton("Import key");
      await s.fill("Name", label, { within: "dialog" });
      await s.type(await s.waitFor("dialog textarea"), readFileSync(path, "utf8"));
      await s.clickButton("Import key", { within: "dialog" });
      await s.waitGone("dialog");
    },
    async addHost({ label, port, user }) {
      await api.nav("Hosts");
      await s.clickButton("Add host");
      await s.fill("Name", label, { within: "dialog" });
      await s.fill("Address", "127.0.0.1", { within: "dialog" });
      const portField = await s.fill("Port", "", { within: "dialog" });
      await s.clear(portField);
      await s.type(portField, String(port));
      await s.fill("User name", user, { within: "dialog" });
      await s.clickButton("Save", { within: "dialog" });
      await s.waitGone("dialog");
    },
    /** Connects to the host card labelled `label`, trusting the server once. */
    async connect(label) {
      await api.nav("Hosts");
      const button = await s.waitFor(`[data-testid="host-list"] button[aria-label="Connect to ${label}"]`);
      await s.click(button);
      await s.until(async () => (await s.find("dialog .fingerprint")) !== null, { describe: "trust prompt" });
      await s.clickButton("Trust once", { within: "dialog" });
      await s.waitGone("dialog");
      await s.until(async () => /Connected/.test(await api.statusText()), { describe: "connected" });
    },
  };
  return api;
}

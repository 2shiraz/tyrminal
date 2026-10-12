// Native startup-snippet suite (SNP-08 with SNP-11..13): a host's variables and a startup snippet
// are set in the real environment dialog, stored in the real vault, and delivered by the core to
// a real SSH session on the lab server, whose sshd accepts only `TYR_*` names. The connection-log
// lines are checked in crates/core/tests/sessions_lab.rs.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/startup.test.mjs

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ui } from "./flows.mjs";
import { App, DOM_RENDERER_PREFS, loadLab } from "./harness.mjs";

const lab = loadLab();

describe("startup snippets and environment in the real application", { concurrency: false }, () => {
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

  async function menuItem(label) {
    const item = await s.until(
      async () => {
        for (const candidate of await s.findAll('[role="menuitem"]')) {
          if ((await s.text(candidate)).trim() === label) return candidate;
        }
        return null;
      },
      { describe: `menu item "${label}"` },
    );
    await s.click(item);
  }

  test("variables and a startup snippet set in the dialog reach the shell after trust", async () => {
    await t.nav("Snippets");
    await s.clickButton("New snippet");
    await s.waitFor("dialog");
    await s.fill("Name", "Announce", { within: "dialog" });
    await s.type(await s.waitFor("dialog textarea"), "echo startup-$((6*7))-$TYR_APP");
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");

    await t.nav("Hosts");
    await s.click(await s.waitFor('button[aria-label="More actions for Lab"]'));
    await menuItem("Environment…");
    await s.waitFor("dialog");
    await s.clickButton("Add variable", { within: "dialog" });
    await s.type(await s.waitFor('dialog input[aria-label="Name 1"]'), "TYR_APP");
    await s.type(await s.waitFor('dialog input[aria-label="Value 1"]'), "orders desk");
    await s.clickButton("Add variable", { within: "dialog" });
    await s.type(await s.waitFor('dialog input[aria-label="Name 2"]'), "NOT_ACCEPTED_BY_LAB");
    await s.type(await s.waitFor('dialog input[aria-label="Value 2"]'), "x");
    // Startup: "Use the group's list", "Run nothing", "Run these snippets".
    const choices = await s.findAll('dialog input[name="startup-host"]');
    assert.equal(choices.length, 3);
    await s.click(choices[2]);
    const value = await s.until(
      () => s.execute(`return [...document.querySelectorAll('dialog select[aria-label="Add a snippet"] option')].find((o) => o.textContent === "Announce")?.value ?? null`),
      { describe: "snippet option" },
    );
    // WebKitGTK's WebDriver does not fire "change" when an option is clicked; choose it the way
    // the browser does (set the value, then dispatch the event) so the component's handler runs.
    await s.execute(
      `const select = document.querySelector('dialog select[aria-label="Add a snippet"]');
       Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, arguments[0]);
       select.dispatchEvent(new Event("change", { bubbles: true }));`,
      [value],
    );
    await s.waitFor('dialog ol[aria-label="Startup snippets"] li');
    await app.screenshot("startup01-environment-dialog");
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");

    await t.connect("Lab");
    // Typed before the shell's first prompt, so the result may follow an echoed prompt.
    await t.waitForText(/(^|\$ )startup-42-orders desk\s*$/m, "startup snippet output");
    // The refused variable is not set on the server; the accepted one is.
    await t.type("printf '<%s|%s>\\n' \"$TYR_APP\" \"${NOT_ACCEPTED_BY_LAB-unset}\"\n");
    await t.waitForText("<orders desk|unset>", "variables in the remote shell");

    await app.screenshot("startup02-shell");
  });
});

// Native security review suite (P-27): the real core reviews a real vault built in the real UI,
// and fixing a finding through the existing host editor clears it. No server is contacted.
//
//   pnpm build:e2e && node --test tests/native/security-review.test.mjs

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ui } from "./flows.mjs";
import { App } from "./harness.mjs";

const REVIEW = '[data-testid="security-review"]';

describe("security review in the real application", { concurrency: false }, () => {
  /** @type {App} */ let app;
  let s;
  let t;

  before(async () => {
    app = await App.launch();
    s = app.session;
    t = ui(s);
    await t.createVault();
  });

  after(async () => {
    await app?.quit();
  });

  /** Sets a <select> by option text (WebKitGTK's WebDriver cannot drive native select popups). */
  async function chooseOption(selector, text) {
    const chosen = await s.execute(
      `const select = document.querySelector(arguments[0]);
       const option = [...(select?.options ?? [])].find((o) => o.text.startsWith(arguments[1]));
       if (!option) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
       setter.call(select, option.value);
       select.dispatchEvent(new Event("change", { bubbles: true }));
       return true;`,
      [selector, text],
    );
    assert.ok(chosen, `option ${text} in ${selector}`);
  }

  const findings = () =>
    s.execute(
      `return [...document.querySelectorAll(arguments[0] + " li[data-kind]")].map((li) => li.getAttribute("data-kind") + " " + li.querySelector(".row-title").textContent)`,
      [REVIEW],
    );

  async function openReview() {
    await t.settings("Security review");
    await s.waitFor(`${REVIEW} [role="status"]`);
  }

  test("a generated key and a password host are reviewed, and choosing the key clears the host's finding", async () => {
    // A host added while the keychain is empty asks for its password.
    await t.addHost({ label: "review-target", port: 2222, user: "tyr" });

    await t.nav("Keychain");
    await s.clickButton("Generate key");
    await s.waitFor("dialog");
    await s.fill("Name", "Review key", { within: "dialog" });
    await s.clickButton("Generate key", { within: "dialog" });
    await s.waitGone("dialog");

    await openReview();
    await s
      .until(async () => (await findings()).length === 2, {
        describe: "two findings",
      })
      .catch(async (e) => {
        const text = await s.execute(`return document.querySelector(arguments[0])?.innerText ?? "no review section"`, [REVIEW]);
        throw new Error(`${e.message}; the review shows: ${text}`);
      });
    const listed = await findings();
    assert.match(listed[0], /^password_sign_in .*"review-target" signs in with a password/);
    assert.match(listed[1], /^key_without_passphrase .*Key "Review key" has no passphrase of its own/);
    assert.match(await s.text(await s.waitFor(`${REVIEW} li[data-kind="key_without_passphrase"]`)), /No host uses it\./);
    const scope = await s.text(await s.waitFor(`${REVIEW} p.muted`));
    assert.match(scope, /Reviewed 1 key, 1 SSH host, 0 certificates and 0 trusted host keys\./);

    // The fix is the existing host editor; nothing changed until it is saved.
    await s.clickButton("Edit host", { within: REVIEW });
    await s.waitFor("dialog");
    const radios = await s.findAll('dialog input[type="radio"][name="auth"]');
    const keyChoice = await s.execute(
      `return [...document.querySelectorAll('dialog input[type="radio"][name="auth"]')].findIndex((r) => r.closest("label")?.textContent.includes("Use a key from the keychain"))`,
    );
    assert.ok(keyChoice >= 0, "the key sign-in choice");
    await s.click(radios[keyChoice]);
    await s.waitFor('dialog select[aria-label="Choose a key"]');
    await chooseOption('dialog select[aria-label="Choose a key"]', "Review key");
    await s.clickButton("Save", { within: "dialog" });
    await s.waitGone("dialog");

    await s.until(async () => (await findings()).length === 1, {
      describe: "the host's finding is gone",
    });
    const remaining = await findings();
    assert.match(remaining[0], /^key_without_passphrase /);
    // The review counts the host that now uses the key.
    await s.until(async () => /Used by 1 host\./.test(await s.text(await s.waitFor(`${REVIEW} li[data-kind="key_without_passphrase"]`))), {
      describe: "the key is used by the host",
    });
    assert.match(await s.text(await s.waitFor(`${REVIEW} p.muted`)), /1 SSH host/);
  });
});

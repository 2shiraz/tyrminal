// Real macOS/WebView smoke over a disposable vault. No network destination is contacted.
// Build first: pnpm run build:e2e; node --test tests/native/redesign.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { App, root } from "./harness.mjs";
import { ui, PASSPHRASE, saveAndCloseHostPanel } from "./flows.mjs";

test("redesign preserves real local vault, host persistence, theme, focus and native resize", { timeout: 120_000 }, async () => {
  const app = await App.launch({ prefs: { theme: "dark", reduceMotion: true, localShell: "/bin/sh" } });
  const s = app.session;
  const t = ui(s);
  const out = join(root, "docs", "redesign", "native");
  mkdirSync(out, { recursive: true });
  const capture = async (name) => writeFileSync(join(out, `${name}.png`), await s.screenshot());
  try {
    await s.waitFor(".auth-card");
    await capture("dark-onboarding");
    await t.createVault();
    await t.nav("Hosts");
    assert.equal(await s.text(await s.waitFor("h1#hosts-title")), "Hosts");
    await capture("dark-empty-hosts");
    await s.clickButton("New host");
    await s.fill("Address", "dev.example.test", { within: '[data-testid="host-panel"]' });
    await s.fill("Name", "Synthetic design host", { within: '[data-testid="host-panel"]' });
    await saveAndCloseHostPanel(s);
    await s.waitFor('[data-testid="host-list"] .host-open');
    await capture("dark-saved-host");
    const rect = await s.setWindowRect({ width: 820, height: 620 });
    assert.ok(rect.width >= 820, "native minimum width is honored");
    assert.ok(await s.execute("return document.documentElement.scrollWidth <= innerWidth"), "no document overflow at minimum native window");
    await capture("dark-minimum-hosts");
    await s.click(await s.waitFor('button[aria-label="Switch light / dark theme"]'));
    await s.until(() => s.execute('return document.documentElement.dataset.theme === "light"'), { describe: "light theme" });
    await capture("light-minimum-hosts");
    await s.click(await s.waitFor('button[aria-label="Search or run a command"]'));
    await s.waitFor("dialog.palette[open]");
    assert.ok(await s.execute('return document.activeElement?.getAttribute("role") === "combobox"'), "palette query receives focus");
    await capture("light-palette");
    await s.execute('document.querySelector("dialog.palette").dispatchEvent(new Event("cancel", { cancelable: true }))');
    await s.waitGone("dialog.palette");
    await t.nav("Settings");
    await s.waitFor(".settings-section");
    await s.waitFor(".theme-list .theme-card");
    await capture("light-settings");
    // The theme picker fits its group in the real WebView at the minimum window (WebKit sizes grid
    // items differently from Chromium), and the default theme is the blue one.
    const picker = await s.execute(`
      const box = document.querySelector(".theme-picker").closest(".settings-group");
      const group = document.querySelector(".theme-picker");
      const inner = group.getBoundingClientRect();
      const cards = [...document.querySelectorAll(".theme-card")].map((c) => c.getBoundingClientRect());
      return { count: cards.length, fits: group.offsetWidth <= box.clientWidth && group.scrollWidth <= group.clientWidth && box.scrollLeft === 0,
        inside: cards.every((c) => c.left >= inner.left + 8 && c.right <= inner.right - 8), palette: document.documentElement.dataset.palette ?? null,
        checked: document.querySelector('.theme-card[aria-checked="true"]')?.dataset.themeId };`);
    assert.ok(picker.fits, "the theme picker is no wider than its group and the group is not scrolled sideways");
    assert.equal(picker.count, 5, "five themes are offered");
    assert.ok(picker.inside, "every theme card is inside its group, with its padding");
    assert.equal(picker.palette, null, "the default theme needs no palette attribute");
    assert.equal(picker.checked, "cobalt", "Cobalt is the default theme");
    // Choosing another theme applies it in the real WebView and survives a lock (checked below).
    await s.click(await s.waitFor('.theme-card[data-theme-id="graphite"]'));
    await s.until(() => s.execute('return document.documentElement.dataset.palette === "graphite"'), { describe: "Graphite theme" });
    await capture("light-settings-graphite");
    await s.clickButton("Lock vault", { within: 'nav[aria-label="Primary"]' });
    await s.waitFor(".auth-card");
    assert.equal(await s.execute('return document.querySelectorAll("[data-exit-ghost]").length'), 0, "lock removes all old visual content");
    await s.fill("Passphrase", PASSPHRASE);
    await s.clickButton("Unlock");
    await s.waitFor('nav[aria-label="Primary"]');
    await t.nav("Hosts");
    assert.ok((await s.text(await s.waitFor('[data-testid="host-list"]'))).includes("Synthetic design host"), "encrypted saved host survives lock/unlock");
    assert.equal(await s.execute("return document.documentElement.dataset.theme"), "light", "theme setting remains persisted");
    assert.equal(await s.execute("return document.documentElement.dataset.palette"), "graphite", "the chosen color theme is stored by the real backend and applied after unlock");
  } finally {
    await app.quit();
  }
});

// First-impression captures for docs/design/overhaul.md: onboarding, recovery key, unlock and quick
// unlock, every connecting step, trust prompts (with a jump-host hop), a changed host key, the three
// auth prompts, a dropped connection with reconnect backoff, a failure, and first-run empty states.
// Not part of the test suite. Run with design-capture.config.ts (see design-capture.ts).
//
// The mock backend has no auth prompts and runs connection steps 15 ms apart, so this file pauses
// the page clock to hold each step and delivers the real SessionEvent shapes (packages/contracts)
// on the session's own channel.
import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";

const OUT = process.env.AUDIT_OUT ?? new URL("../../docs/design/before", import.meta.url).pathname;
const PREFIX = process.env.AUDIT_PREFIX ?? "";

async function shot(page: Page, name: string) {
  await page.mouse.move(1, 859);
  await page.screenshot({ path: `${OUT}/${PREFIX}${name}.png` });
}

/** Records channel callbacks and can enable quick unlock before the app first asks. */
async function instrument(page: Page, opts: { quickUnlock?: boolean } = {}) {
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown>;
    let internals: { transformCallback: (cb: (p: unknown) => unknown, once?: boolean) => number } | undefined;
    const recorded = new Map<number, (p: unknown) => unknown>();
    w.__capCallbacks = recorded;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set: (v) => {
        const original = v.transformCallback.bind(v);
        v.transformCallback = (cb: (p: unknown) => unknown, once = false) => {
          const id = original(cb, once);
          recorded.set(id, cb);
          return id;
        };
        internals = v;
      },
    });
    let mockState: Record<string, unknown> | undefined;
    Object.defineProperty(window, "__mockState", {
      configurable: true,
      get: () => mockState,
      set: (v) => {
        if (o.quickUnlock) v.quickUnlock = true;
        mockState = v;
      },
    });
  }, opts);
}

/** Delivers a SessionEvent on the newest session's event channel. */
const emit = (page: Page, event: Record<string, unknown>) =>
  page.evaluate((e) => {
    const w = window as unknown as { __mockState: { sessions: Map<string, { events: { id: number; index?: number } }> }; __capCallbacks: Map<number, (p: unknown) => void> };
    const s = [...w.__mockState.sessions.values()].at(-1);
    if (!s) throw new Error("no session");
    const cb = w.__capCallbacks.get(s.events.id);
    if (!cb) throw new Error("no channel");
    s.events.index = (s.events.index ?? 0) + 1;
    cb({ index: s.events.index - 1, message: e });
  }, event);

const nav = (page: Page, name: RegExp | string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name }).first().click();

for (const theme of ["dark", "light"] as const) {
  test(`first impressions ${theme}`, async ({ page }) => {
    test.setTimeout(240_000);
    const t = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        await page.waitForTimeout(120);
        await shot(page, `${theme}-${name}`);
      } catch (e) {
        console.log(`skip ${name}: ${String(e).slice(0, 200)}`);
      }
    };

    // Onboarding and recovery key.
    await openApp(page, { scenario: "onboarding", theme });
    await t("onboarding-filled", async () => {
      await page.getByLabel("Vault passphrase", { exact: true }).fill("correct horse battery");
      await page.getByLabel("Repeat passphrase").fill("correct horse battery");
    });
    await t("recovery-key", async () => {
      await page.getByRole("button", { name: "Create vault" }).click();
      await expect(page.getByRole("heading", { name: "Save your recovery key" })).toBeVisible();
    });
    await t("recovery-confirm-wrong", async () => {
      const box = page.getByRole("textbox").last();
      await box.fill("ZZZZZ");
      await page.getByRole("button", { name: "I have saved it" }).click();
    });

    // Unlock, wrong passphrase, quick unlock.
    await openApp(page, { scenario: "locked", theme });
    await t("unlock-wrong", async () => {
      await page.getByLabel(/passphrase/i).first().fill("wrong horse");
      await page.keyboard.press("Enter");
      await expect(page.getByText("That did not unlock the vault")).toBeVisible();
    });
    await instrument(page, { quickUnlock: true });
    await openApp(page, { scenario: "locked", theme });
    await t("unlock-quick", async () => {});

    // Connecting steps, held with a paused clock.
    await instrument(page);
    await openApp(page, { theme });
    await page.clock.pauseAt(new Date("2026-10-11T12:00:05Z"));
    await nav(page, /^Hosts/);
    await connectHost(page, "api-gateway");
    // Advance until the session is open; its steps are then due 10, 25, 40 and 55 ms later.
    for (let k = 0; k < 400; k += 1) {
      if (await page.evaluate(() => (window as unknown as { __mockState: { sessions: Map<string, unknown> } }).__mockState.sessions.size > 0)) break;
      await page.clock.runFor(2);
    }
    for (const [step, ms] of [["connecting", 12], ["verifying-host", 15], ["authenticating", 15], ["opening-channel", 15]] as const) {
      await t(`connect-${step}`, async () => {
        await page.clock.runFor(ms);
        await page.waitForTimeout(50);
      });
    }
    // Auth prompts on the held session (it is in "opening_channel"; prompts arrive while signing in).
    await emit(page, { type: "state", state: "authenticating" });
    const prompts = [
      ["auth-password", { kind: "password", attempt: 1, message: null, echo: false, hop: null }],
      ["auth-password-retry", { kind: "password", attempt: 2, message: null, echo: false, hop: null }],
      ["auth-key-passphrase", { kind: "key_passphrase", attempt: 1, message: null, echo: false, hop: null }],
      ["auth-keyboard-interactive", { kind: "keyboard_interactive", attempt: 1, message: "Verification code from your authenticator app:", echo: false, hop: null }],
      ["auth-jump-hop", { kind: "password", attempt: 1, message: null, echo: false, hop: { index: 1, total: 2, label: "bastion" } }],
    ] as const;
    let n = 0;
    for (const [name, p] of prompts) {
      n += 1;
      await t(name, async () => {
        await emit(page, { type: "auth_prompt", promptId: `cap${n}`, username: "deploy", maxAttempts: 3, ...p });
        await page.waitForTimeout(80);
      });
    }
    await page.clock.resume();

    // Failure with a plain cause, and a dropped link with reconnect backoff.
    await openApp(page, { theme });
    await t("connect-failed", async () => {
      await nav(page, /^Hosts/);
      await connectHost(page, "edge-cache");
      await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
      await emit(page, { type: "state", state: "failed" });
      await emit(page, { type: "closed", error: { code: "AUTH_FAILED", message: "The server did not accept the password for ops." }, exitStatus: null });
    }).catch(() => undefined);
    await instrument(page);
    await openApp(page, { theme });
    await t("connect-reconnecting", async () => {
      await nav(page, /^Hosts/);
      await connectHost(page, "api-gateway");
      await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
      await page.evaluate(() => (window as unknown as { __mockDrop: () => void }).__mockDrop());
      await expect(page.getByTestId("auto-reconnect")).toBeVisible();
    });

    // Trust prompts: direct and through a jump host; changed host key.
    await openApp(page, { theme, trustPromptFor: "staging-web", trustPromptHop: { index: 1, total: 2, label: "bastion" } });
    await t("trust-prompt-hop", async () => {
      await nav(page, /^Hosts/);
      await connectHost(page, "staging-web");
      await expect(page.getByRole("alertdialog")).toBeVisible();
    });
    await openApp(page, { theme, hostKeyChangedFor: "staging-web" });
    await t("host-key-changed", async () => {
      await nav(page, /^Hosts/);
      await connectHost(page, "staging-web");
      await expect(page.getByRole("alert")).toBeVisible();
    });

    // First run: empty hosts (the first page), keychain, snippets.
    await openApp(page, { scenario: "empty", theme });
    await t("first-run-hosts", async () => {});
    await t("empty-keychain", () => nav(page, "Keychain"));
    await t("empty-snippets", () => nav(page, /^Snippets/));
    await t("empty-known-hosts", () => nav(page, "Known hosts"));
  });
}

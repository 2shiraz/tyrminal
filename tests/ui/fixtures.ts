import type { Page } from "@playwright/test";

import { installMockBackend } from "./mock-backend.js";

/** Match the explicitly emulated app convention, rather than Playwright's host OS. */
export const uiModifier: "Control" | "Meta" = process.env.TYR_UI_PLATFORM === "linux" ? "Control" : process.env.TYR_UI_PLATFORM === "macos" || process.platform === "darwin" ? "Meta" : "Control";

export interface MockOptions {
  /** The application color theme (Settings → Appearance); default "cobalt". */
  palette?: string;
  /** The production tag preference (P-26); default "prod". */
  productionTag?: string;
  /** The saved Hosts layout. The app's default is list; specs written for cards ask for "grid",
   *  which is the mock's default. `null` leaves it unset, so the app's own default applies. */
  hostsLayout?: "grid" | "list" | null;
  scenario?: "unlocked" | "empty" | "onboarding" | "locked";
  theme?: "dark" | "light";
  scheme?: string;
  renderer?: "auto" | "compatibility";
  trustPromptFor?: string;
  /** quick connect: identities in the mock vault ({ id, label, username, password, keyId }). */
  identities?: { id: string; label: string; username: string; password: string | null; keyId: string | null }[];
  /** Ask for a password when connecting to this host (answered with session_auth_answer). */
  passwordPromptFor?: string;
  // agent B: tunnels and history
  /** Name the jump-chain hop in that trust prompt. */
  trustPromptHop?: { index: number; total: number; label: string };
  /** Seed sample session recordings. */
  recordings?: boolean;
  hostKeyChangedFor?: string;
  /** The server refuses this host's key until it is installed (key_deploy). */
  keyRejectedFor?: string;
  /** Simulate a WebView without WebGL (the GPU renderer must fall back). */
  noWebgl?: boolean;
  /** Deliver a vault status event before the first status request returns. */
  statusEventFirst?: boolean;
  /** Terminal scrollback lines (default 5000). */
  scrollback?: number;
  /** Add a trusted server that no saved host points at. */
  orphanKnownHost?: boolean;
  /** P-30: notes by host label or group name ("host:api-gateway", "group:Production"). */
  notes?: Record<string, { text: string; format?: "plain" | "markdown" }>;
  // compromised-password check (SEC-11)
  /** Pretend the build can make range requests (the real build cannot yet). */
  passwordCheckAvailable?: boolean;
  // security review (P-27)
  /** Adds a DSA key, a 2048-bit RSA key and an RSA-only trusted key for a retired host. */
  reviewFixtures?: boolean;
  /** LAN discovery: the networks the mock offers (default: one, `en0`). */
  discoveryNetworks?: { id: string; addresses: string[] }[];
  /** Add this many synthetic hosts in no group (bulk-host-001, …) for the windowed Hosts list. */
  extraHosts?: number;
  /** Add this many synthetic trusted servers (bulk-001.example, …) for the windowed Known hosts list. */
  extraKnownHosts?: number;
  /** Serve IPC calls one at a time, each taking this long (perf specs: a vault behind one lock). */
  ipcSerialMs?: number;
  /** Keep the browser's real clock (perf.spec.ts: the fixed clock replaces performance.now and requestAnimationFrame). */
  realClock?: boolean;
}

export async function openApp(page: Page, options: MockOptions = {}) {
  // Explicit browser-only convention emulation for the existing Linux-keyboard UI suite.
  // Default remains the actual browser platform; this never changes native security behavior.
  const platform = process.env.TYR_UI_PLATFORM;
  if (platform && platform !== "linux" && platform !== "macos") throw new Error("TYR_UI_PLATFORM must be linux or macos");
  if (platform) await page.addInitScript((value) => Object.defineProperty(navigator, "platform", { configurable: true, value }), platform === "macos" ? "MacIntel" : "Linux x86_64");
  await page.emulateMedia({ colorScheme: options.theme === "light" ? "light" : "dark", reducedMotion: "reduce" });
  if (options.noWebgl) {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      // biome-ignore lint: test stub
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === "webgl2" || type === "webgl") return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    });
  }
  // A fixed clock so relative times ("2 h ago") are stable in screenshots; timers still run.
  if (!options.realClock) await page.clock.setFixedTime(new Date("2026-10-11T12:00:00Z"));
  await page.addInitScript(installMockBackend, options);
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  // Wait for the explicit ready state of the scenario rather than for time to pass.
  const scenario = options.scenario ?? "unlocked";
  if (scenario === "unlocked" || scenario === "empty") {
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    await page.getByRole("heading", { level: 1 }).waitFor();
  } else {
    await page.getByRole("heading", { level: 1 }).waitFor();
  }
}

/** Visible terminal text. Requires the DOM renderer (the GPU renderer draws to a canvas). */
/** Opens Settings, and with `section` that section (Settings shows one section at a time). */
export async function openSettings(page: Page, section?: string) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Settings/ }).click();
  if (section) await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: section, exact: true }).click();
}

export function terminalText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows")].map((e) => (e as HTMLElement).innerText.replaceAll("\u00a0", " ")).join("\n"),
  );
}

export async function waitForTerminalText(page: Page, text: string) {
  await page.waitForFunction(
    (needle) => [...document.querySelectorAll(".terminal-pane:not([hidden]) .xterm-rows")].some((e) => (e as HTMLElement).innerText.replaceAll("\u00a0", " ").includes(needle)),
    text,
  );
}

/**
 * Connects to a saved host the way a user does: double-click its row on Home or its row or card on
 * Hosts (there is no Connect button on them).
 */
export async function connectHost(page: Page, label: string) {
  await page
    .locator('[data-testid="host-list"], table.home-hosts')
    .getByRole("button", { name: label, exact: true })
    .first()
    .dblclick();
}

/** Hosts: choose List or Cards (icon-only toggle; the names are for assistive technology). */
export async function chooseLayout(page: Page, name: "List" | "Cards") {
  await page.getByRole("radiogroup", { name: "Layout" }).locator("label", { hasText: name }).click();
}

/** Hosts: the sort order, from the Sort menu. */
export async function sortHosts(page: Page, name: "Name" | "Recently used" | "Address" | "Group") {
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name }).click();
}

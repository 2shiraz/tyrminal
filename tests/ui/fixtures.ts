import type { Page } from "@playwright/test";

import { installMockBackend } from "./mock-backend.js";

export interface MockOptions {
  scenario?: "unlocked" | "empty" | "onboarding" | "locked";
  theme?: "dark" | "light";
  scheme?: string;
  renderer?: "auto" | "compatibility";
  trustPromptFor?: string;
  /** Ask for a password when connecting to this host (answered with session_auth_answer). */
  passwordPromptFor?: string;
  // agent B: tunnels and history
  /** Name the jump-chain hop in that trust prompt. */
  trustPromptHop?: { index: number; total: number; label: string };
  hostKeyChangedFor?: string;
  /** The server refuses this host's key until it is installed (key_deploy). */
  keyRejectedFor?: string;
  /** Simulate a WebView without WebGL (the GPU renderer must fall back). */
  noWebgl?: boolean;
  /** Deliver a vault status event before the first status request returns. */
  statusEventFirst?: boolean;
  /** Add a trusted server that no saved host points at. */
  orphanKnownHost?: boolean;
  /** LAN discovery: the networks the mock offers (default: one, `en0`). */
  discoveryNetworks?: { id: string; addresses: string[] }[];
}

export async function openApp(page: Page, options: MockOptions = {}) {
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
  await page.clock.setFixedTime(new Date("2026-10-11T12:00:00Z"));
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

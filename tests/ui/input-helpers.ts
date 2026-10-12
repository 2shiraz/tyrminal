// Helpers for terminal input tests: what each mock session received, per session, in order.

import { type Page, expect } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

export type Inputs = Record<string, string>;

export async function inputs(page: Page): Promise<Inputs> {
  return page.evaluate(() => {
    const w = window as unknown as { __mockInputBySession?: Inputs; __mockState: { sessions: Map<string, unknown> } };
    // Every session opened so far, including those that have not received anything yet.
    const all: Inputs = Object.fromEntries([...w.__mockState.sessions.keys()].map((id) => [id, ""]));
    return { ...all, ...(w.__mockInputBySession ?? {}) };
  });
}

/**
 * Everything sent since `before`, one string per session that received anything so far (in
 * session creation order), without terminal query replies.
 */
export async function sentSince(page: Page, before: Inputs): Promise<string[]> {
  const now = await inputs(page);
  return Object.keys(now)
    .sort()
    .map((id) => (now[id] ?? "").slice((before[id] ?? "").length).replace(/\u001b\[\d+;\d+R/g, ""));
}

export async function openLocal(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.keyboard.press("Control+Shift+T");
  await waitForTerminalText(page, "$");
  await expect(page.locator(".pane[data-focused=true] .xterm-helper-textarea")).toBeFocused();
}

export async function paletteRun(page: Page, text: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(text);
  await expect(page.getByRole("option").first()).toContainText(text);
  await page.keyboard.press("Enter");
}

/**
 * A clipboard private to this page. The browser's clipboard is shared by every test running in
 * parallel, so a test that writes and later reads it can see another test's text.
 */
export async function privateClipboard(page: Page, initial = "") {
  await page.evaluate((text) => {
    let value = text;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => value,
        writeText: async (t: string) => {
          value = t;
        },
      },
    });
  }, initial);
}

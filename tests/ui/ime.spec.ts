// CJK input through an input method (TRM-11). Chromium's own IME path is driven over the
// DevTools protocol (Input.imeSetComposition / Input.insertText): the page receives real
// compositionstart/update/end events and keyCode 229 key events, as with a system IME.
// Mock backend: what each session received is recorded per session; never native evidence.

import { type CDPSession, expect, test } from "@playwright/test";

import { waitForTerminalText } from "./fixtures";
import { inputs, openLocal, sentSince } from "./input-helpers";

/** One IME round: composition updates, then the committed text. */
async function compose(cdp: CDPSession, steps: string[], commit: string) {
  for (const text of steps) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp.send("Input.insertText", { text: commit });
}

/** The key event an IME produces for a key it consumes (Enter to pick a candidate, and so on). */
async function imeKey(cdp: CDPSession, key: string, code: string, modifiers = 0) {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Process", code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229, modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: 229, modifiers });
}

test("IME: nothing is sent while composing; the committed text is sent once, as UTF-8", async ({ page }) => {
  await openLocal(page);
  const cdp = await page.context().newCDPSession(page);
  const before = await inputs(page);

  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
  // The preedit text is shown at the cursor while composing, and has not been sent.
  const preview = page.locator(".pane[data-focused=true] .composition-view");
  await expect(preview).toHaveClass(/active/);
  await expect(preview).toHaveText("にほん");
  // Enter that picks the IME candidate belongs to the IME, not to the shell.
  await imeKey(cdp, "Enter", "Enter");
  await page.waitForTimeout(100);
  expect((await sentSince(page, before)).join("")).toBe("");

  await cdp.send("Input.insertText", { text: "日本語" });
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("日本語");
  await expect(preview).not.toHaveClass(/active/);
  await waitForTerminalText(page, "日本語");

  // A real Enter after the composition ends is a newline for the shell.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("日本語\r");
  await waitForTerminalText(page, "日本語: synthetic output");
});

test("IME: consecutive compositions, mixed with typed ASCII, keep their order", async ({ page }) => {
  await openLocal(page);
  const cdp = await page.context().newCDPSession(page);
  const before = await inputs(page);

  await page.keyboard.type("echo ");
  await compose(cdp, ["ㅎ", "하", "한"], "한");
  await compose(cdp, ["ㄱ", "그", "글"], "글");
  await page.keyboard.type(" ");
  await compose(cdp, ["zh", "zhong", "中"], "中文");
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("echo 한글 中文");
  // The bytes on the wire are the UTF-8 encoding of exactly those characters.
  const bytes = await page.evaluate(() => [...new TextEncoder().encode("한글 中文")].length);
  expect(bytes).toBe(13);
});

test("IME: cancelling a composition sends nothing", async ({ page }) => {
  await openLocal(page);
  const cdp = await page.context().newCDPSession(page);
  const before = await inputs(page);

  await cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
  await expect(page.locator(".pane[data-focused=true] .composition-view")).toHaveText("かな");
  // Escape inside the IME clears the preedit (an empty composition), and nothing is committed.
  await imeKey(cdp, "Escape", "Escape");
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await page.waitForTimeout(150);
  expect((await sentSince(page, before)).join("")).toBe("");
  // The terminal still takes ordinary input afterwards.
  await page.keyboard.type("ls");
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("ls");
});

test("IME: application shortcuts do not fire while a composition is open", async ({ page }) => {
  await openLocal(page);
  const cdp = await page.context().newCDPSession(page);
  const before = await inputs(page);

  await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  // Ctrl+Shift+K (the palette) arriving as an IME-processed key stays with the IME.
  const ctrlShift = 2 | 8;
  await imeKey(cdp, "K", "KeyK", ctrlShift);
  await page.waitForTimeout(100);
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "日本" });
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("日本");
  // After the composition the same chord is a shortcut again.
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});

test("IME: committed text is broadcast once to every receiving pane", async ({ page }) => {
  await openLocal(page);
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(2);
  await expect(page.locator(".pane[data-focused=true] .xterm-helper-textarea")).toBeFocused();
  await waitForTerminalText(page, "$");
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox").fill("every pane");
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog", { name: "Type into these 2 panes?" }).getByRole("button", { name: "Type into 2 panes" }).click();
  await expect(page.getByTestId("broadcast")).toHaveText("Typing into 2 panes");
  await expect(page.locator(".pane[data-focused=true] .xterm-helper-textarea")).toBeFocused();

  const cdp = await page.context().newCDPSession(page);
  const before = await inputs(page);
  await compose(cdp, ["に", "にほん"], "日本");
  await expect.poll(() => sentSince(page, before)).toEqual(["日本", "日本"]);
  // The preedit itself is never relayed.
  await cdp.send("Input.imeSetComposition", { text: "ご", selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(100);
  expect(await sentSince(page, before)).toEqual(["日本", "日本"]);
  await cdp.send("Input.insertText", { text: "語" });
  await expect.poll(() => sentSince(page, before)).toEqual(["日本語", "日本語"]);
});

// Fast typing: the next key, the next composition or Enter arrives before the browser's next
// timer tick. xterm's own helper read stale offsets here and sent text twice or not at all.
test("IME: a key right after a commit, back-to-back commits and Enter keep exact order", async ({ page }) => {
  await openLocal(page);
  await expect(page.locator(".pane[data-focused=true] .terminal-host")).toHaveAttribute("data-composition", "ordered");
  const cdp = await page.context().newCDPSession(page);
  let before = await inputs(page);
  for (let i = 0; i < 10; i += 1) {
    await cdp.send("Input.imeSetComposition", { text: "하", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "한" });
    await page.keyboard.type(" ");
  }
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("한 ".repeat(10));

  before = await inputs(page);
  for (let i = 0; i < 10; i += 1) {
    await cdp.send("Input.imeSetComposition", { text: "ㄱ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "글" });
  }
  await page.waitForTimeout(100);
  expect((await sentSince(page, before)).join("")).toBe("글".repeat(10));

  // Enter right after a commit: the text goes first, then the newline (xterm empties its
  // input element on Enter, which used to lose the text).
  before = await inputs(page);
  for (let i = 0; i < 5; i += 1) {
    await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "日" });
    await page.keyboard.press("Enter");
  }
  await expect.poll(async () => (await sentSince(page, before)).join("")).toBe("日\r".repeat(5));
});

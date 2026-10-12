// P-28 performance: searching 10 sessions of 10,000 lines each never blocks the page. The search
// runs in steps on the page's timers; this measures the longest stretch the page could not
// respond while it runs (a heartbeat) and how long the whole search takes. Browser build, UI mock.
import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const SESSIONS = 10;
const LINES = 10_000;

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);

test("search: 10 sessions × 10,000 lines stay responsive and finish quickly", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page, { renderer: "compatibility", scrollback: 20_000 });
  const before = await page.getByRole("tab").count();
  for (let s = 0; s < SESSIONS; s++) {
    // A new local terminal each time: a tab per session.
    await page.keyboard.press("Control+Shift+T");
    await expect(page.getByRole("tab")).toHaveCount(before + s + 1);
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    // Every 1,000th line holds the rare word; the rest is ordinary output.
    for (let start = 0; start < LINES; start += 2_000) {
      const chunk = Array.from({ length: 2_000 }, (_, i) => {
        const n = start + i;
        return n % 1_000 === 999 ? `\r\nsession ${s} line ${n} rarefind marker` : `\r\nsession ${s} line ${n} ordinary output text for the scrollback`;
      }).join("");
      await output(page, chunk);
    }
    await waitForTerminalText(page, `session ${s} line ${LINES - 1}`);
  }

  // A heartbeat: a message posted to itself again and again (not a timer, so the test's fixed
  // clock does not drive it). The longest gap between beats is the longest time the page could
  // not respond, to a key press for instance.
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number; __beat: boolean };
    w.__longest = 0;
    w.__beat = true;
    const channel = new MessageChannel();
    let last = performance.now();
    channel.port1.onmessage = () => {
      const now = performance.now();
      w.__longest = Math.max(w.__longest, now - last);
      last = now;
      if (w.__beat) channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
  });
  await page.keyboard.press("Alt+Shift+F");
  const dialog = page.getByRole("dialog", { name: "Search all sessions" });
  const started = Date.now();
  await dialog.getByLabel("Text to find in every open session").fill("rarefind");
  await expect(dialog.getByRole("status")).toHaveText(`${SESSIONS * 10} matches in ${SESSIONS} tabs`, { timeout: 30_000 });
  const elapsed = Date.now() - started;
  const longest = await page.evaluate(() => (window as unknown as { __longest: number }).__longest);
  console.log(`search over ${SESSIONS}×${LINES} lines: ${elapsed} ms to complete, longest blocked ${Math.round(longest)} ms`);
  // A common word hits the cap in the first terminal and stops there.
  await dialog.getByLabel("Text to find in every open session").fill("ordinary");
  await expect(dialog.getByText("Showing the first 500 matches.")).toBeVisible({ timeout: 10_000 });
  expect(longest, "no single step blocks the page for long").toBeLessThan(150);
  // The measurement itself works: a deliberate 120 ms block is seen.
  await page.evaluate(() => {
    const end = performance.now() + 120;
    while (performance.now() < end) {
      // busy
    }
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __longest: number }).__longest)).toBeGreaterThanOrEqual(100);
  expect(elapsed).toBeLessThan(10_000);
});

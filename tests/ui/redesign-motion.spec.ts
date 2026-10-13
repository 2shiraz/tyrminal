// Synthetic UI-only checks of interrupted motion. They verify the actual production React/CSS
// surface, not SSH transport. Pausing WAAPI avoids timing-dependent tests of 100ms transitions.
import { expect, type Page, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";
import { connectHeld, emitSessionEvent } from "./session-events";

test.use({ video: "on" });

async function allowMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
}

const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" });
const sort = (page: Page) => page.getByRole("button", { name: "Sort", exact: true });

async function pausedGlide(page: Page) {
  await primary(page).getByRole("button", { name: /^Settings/ }).click();
  await settingsNav(page).getByRole("button", { name: "Terminal", exact: true }).click();
  const marker = settingsNav(page).locator(".nav-glide");
  await marker.evaluate((el) => {
    const animation = el.getAnimations()[0];
    if (!animation) throw new Error("no pointer glide to interrupt");
    animation.pause();
    animation.currentTime = 40;
  });
  return marker;
}

test("keyboard navigation interrupts a pointer glide immediately and preserves focus", async ({ page }) => {
  await openApp(page);
  await allowMotion(page);
  const marker = await pausedGlide(page);
  const hosts = settingsNav(page).getByRole("button", { name: "Appearance", exact: true });
  await hosts.focus();
  await page.keyboard.press("Enter");
  await expect(hosts).toHaveAttribute("aria-current", "page");
  await expect(hosts).toBeFocused();
  await expect(marker).toHaveCount(0);
  await expect(settingsNav(page)).not.toHaveAttribute("data-gliding", /.*/);
});

for (const preference of ["system", "application"] as const) {
  test(`${preference} reduced motion interrupts an active pointer glide without navigation`, async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    const marker = await pausedGlide(page);
    if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" });
    else await page.evaluate(() => { document.documentElement.dataset.reduceMotion = "true"; });
    await expect(marker).toHaveCount(0);
    await expect(settingsNav(page)).not.toHaveAttribute("data-gliding", /.*/);
    await expect(settingsNav(page).getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-current", "page");
  });
}

test("reopening during an exit removes the older inert copy and uses the current menu", async ({ page }) => {
  await openApp(page);
  await allowMotion(page);
  await sort(page).click();
  await expect(page.getByRole("menu", { name: "Sort" })).toBeVisible();
  // Close by pointer and immediately hold its visual exit to exercise genuine overlap.
  await page.mouse.click(5, 400);
  const ghost = page.locator("[data-exit-ghost]");
  await ghost.evaluate((el) => {
    const animation = el.getAnimations()[0];
    if (!animation) throw new Error("no exit to interrupt");
    animation.pause();
    animation.currentTime = 30;
  });
  await expect(ghost).toHaveAttribute("inert", "");
  await sort(page).click();
  await expect(ghost).toHaveCount(0);
  const menu = page.getByRole("menu", { name: "Sort" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sort(page)).toBeFocused();
  await expect(menu).toHaveCount(0);
  await expect(ghost).toHaveCount(0);
});

test("connection feedback uses one truthful loop and errors stay spatially stable", async ({ page }) => {
  await openApp(page);
  await allowMotion(page);
  await connectHeld(page, () => connectHost(page, "edge-cache"));
  await page.clock.runFor(42);
  const track = page.getByTestId("connect-track");
  const loops = await track.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => (animation.effect as KeyframeEffect).getTiming().iterations === Number.POSITIVE_INFINITY).map((animation) => (animation as CSSAnimation).animationName));
  // One loop: the light on the segment in progress.
  expect(loops).toEqual(["track-pass"]);
  await emitSessionEvent(page, { type: "state", state: "failed" });
  await emitSessionEvent(page, { type: "closed", error: { code: "AUTH_FAILED", message: "Synthetic authentication rejected." }, exitStatus: null });
  await expect(page.getByRole("alert").filter({ hasText: "The server did not accept the sign-in" })).toBeVisible();
  const failure = track.locator('.track-stop[data-state="fail"]');
  await expect(failure).toBeVisible();
  expect(await failure.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  expect(await track.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => (animation.effect as KeyframeEffect).getTiming().iterations === Number.POSITIVE_INFINITY).length)).toBe(0);
  await page.clock.resume();
});

test("keyboard palette and tab traversal stay instant without moving terminal glyphs", async ({ page }) => {
  await openApp(page);
  await allowMotion(page);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+T" : "Control+Shift+T");
  await expect(page.locator(".terminal-host").first()).toBeVisible();
  await page.keyboard.press(mac ? "Meta+K" : "Control+Shift+K");
  await page.keyboard.type("api");
  await expect(page.getByRole("combobox", { name: /Type a command/ })).toHaveValue("api");
  expect(await page.locator("dialog.palette").evaluate((el) => el.getAnimations().length)).toBe(0);
  await page.keyboard.press("Escape");
  const report = await page.locator(".terminal-host").first().evaluate((el) => ({
    transform: getComputedStyle(el).transform,
    transitions: el.getAnimations({ subtree: true }).filter((a) => a.constructor.name === "CSSTransition").length,
  }));
  expect(report).toEqual({ transform: "none", transitions: 0 });
});

test("records menu presentation frames and a real-clock interaction frame timeline", async ({ page }, testInfo) => {
  await openApp(page, { realClock: true });
  await allowMotion(page);
  await page.evaluate(() => {
    const frames: number[] = [];
    const end = performance.now() + 1400;
    const sample = (time: number) => {
      frames.push(time);
      if (time < end) requestAnimationFrame(sample);
    };
    (window as unknown as { __motionFrames: number[] }).__motionFrames = frames;
    requestAnimationFrame(sample);
  });
  await sort(page).click();
  const menu = page.getByRole("menu", { name: "Sort" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await sort(page).click();
  // Pause at exact presentation points; this also inspects a close during partial entry.
  await menu.evaluate((el) => {
    for (const animation of el.getAnimations()) animation.pause();
  });
  for (const fraction of [0, 0.5, 1]) {
    await menu.evaluate((el, progress) => {
      for (const animation of el.getAnimations()) {
        const duration = Number((animation.effect as KeyframeEffect).getTiming().duration);
        animation.currentTime = duration * progress;
      }
    }, fraction);
    await testInfo.attach(`menu-${fraction}-presentation`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.mouse.click(5, 400);
  await expect(menu).toHaveCount(0);
  await sort(page).click();
  await expect(menu).toBeVisible();
  await expect(page.locator("[data-exit-ghost]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __motionFrames: number[] }).__motionFrames.length)).toBeGreaterThan(30);
  const frames = await page.evaluate(() => (window as unknown as { __motionFrames: number[] }).__motionFrames);
  const intervals = frames.slice(1).map((time, i) => time - frames[i]);
  expect(intervals.every((interval) => Number.isFinite(interval) && interval > 0)).toBe(true);
  const sorted = [...intervals].sort((a, b) => a - b);
  await testInfo.attach("frame-timeline", {
    body: JSON.stringify({ driver: "requestAnimationFrame", syntheticTransport: true, frames, intervals, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)], maximumMs: sorted.at(-1), caveat: "Browser callbacks under software rendering; not GPU presented frames or native-device FPS." }, null, 2),
    contentType: "application/json",
  });
});

import { expect, type Page, test } from "@playwright/test";

import { openApp } from "./fixtures";

// The motion rules (docs/design/interaction-polish.md §4): transform and opacity only, 100 to
// 220 ms, and nothing at all under reduced motion.

/** Every animation that is running or about to, with its timing and the properties it moves. */
function liveAnimations(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running" || a.playState === "pending")
      .map((a) => {
        const effect = a.effect as KeyframeEffect;
        const props = new Set<string>();
        for (const frame of effect.getKeyframes()) {
          for (const key of Object.keys(frame)) if (!["offset", "easing", "composite", "computedOffset"].includes(key)) props.add(key);
        }
        return { duration: Number(effect.getTiming().duration), props: [...props] };
      }),
  );
}

test("motion: nothing animates under reduced motion", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "New tab" }).click();
  const menu = page.getByRole("menu", { name: "New tab" });
  await expect(menu).toBeVisible();
  expect(await liveAnimations(page)).toEqual([]);
  expect(await menu.evaluate((el) => getComputedStyle(el).animationDuration)).toBe("0s");
});

test("motion: the in-app switch turns motion off even when the system allows it", async ({ page }) => {
  await openApp(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "true";
  });
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(page.getByRole("menu", { name: "New tab" })).toBeVisible();
  expect(await liveAnimations(page)).toEqual([]);
});

test("motion: a menu scales in briefly, using transform and opacity only", async ({ page }) => {
  await openApp(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "New tab" }).click();
  const menu = page.getByRole("menu", { name: "New tab" });
  await expect(menu).toBeVisible();
  const own = await menu.evaluate((el) => el.getAnimations().map((a) => Number((a.effect as KeyframeEffect).getTiming().duration)));
  const all = await liveAnimations(page);
  // The menu's own entrance, if it has not already finished, and anything else running with it.
  for (const duration of own) expect(duration).toBeLessThanOrEqual(220);
  for (const animation of all) {
    expect(animation.duration).toBeGreaterThan(0);
    expect(animation.duration).toBeLessThanOrEqual(220);
    for (const prop of animation.props) expect(["opacity", "transform"]).toContain(prop);
  }
  expect(await menu.evaluate((el) => getComputedStyle(el).animationDuration)).toBe("0.12s");
});

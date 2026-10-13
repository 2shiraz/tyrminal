// Afterglow toast deck and ignition (experimental UI, branch only; plan §6 moments 1 and 5).
// UI-only mock backend; checks the interface, never counts as native verification.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function allowMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
}

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const scales = (page: Page) =>
  page.locator(".toasts > .toast").evaluateAll((els) => els.map((e) => new DOMMatrixReadOnly((e as HTMLElement).style.transform).a).reverse());

test.describe("toast deck", () => {
  test("toasts stack as a deck, newest in front, and fan out while hovered", async ({ page }) => {
    await openApp(page);
    await connect(page, "api-gateway");
    await page.keyboard.press("Control+Shift+S");
    const run = page.getByRole("button", { name: "Run Disk usage in the terminal" });
    for (let i = 0; i < 3; i += 1) await run.click();
    await expect(page.locator(".toasts > .toast")).toHaveCount(3);
    // Front at full size, the two behind a little smaller each.
    expect((await scales(page)).map((s) => Math.round(s * 100) / 100)).toEqual([1, 0.95, 0.9]);
    const collapsed = (await page.locator(".toasts").boundingBox())!.height;

    // Hovered (the stack is click-through, so the pointer is placed by position): a list.
    const front = page.locator(".toasts > .toast").last();
    await front.hover({ force: true });
    await expect(page.locator(".toasts")).toHaveAttribute("data-expanded", "true");
    expect(await scales(page)).toEqual([1, 1, 1]);
    expect((await page.locator(".toasts").boundingBox())!.height).toBeGreaterThan(collapsed * 2);
    // Timers wait while it is hovered.
    await page.waitForTimeout(5000);
    await expect(page.locator(".toasts > .toast")).toHaveCount(3);

    await page.mouse.move(5, 400);
    await expect(page.locator(".toasts")).not.toHaveAttribute("data-expanded", /.*/);
  });

  test("a new toast moves the deck with Web Animations on transform and opacity only", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await connect(page, "api-gateway");
    await page.keyboard.press("Control+Shift+S");
    const run = page.getByRole("button", { name: "Run Disk usage in the terminal" });
    await run.click();
    await page.waitForTimeout(400);
    await run.click();
    const props = await page.locator(".toasts > .toast").evaluateAll((els) =>
      els.flatMap((e) => e.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k).filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key))))),
    );
    expect(props.length).toBeGreaterThan(0);
    expect(new Set(props)).toEqual(new Set(["transform", "opacity"]));
  });
});

test.describe("ignition", () => {
  test("the connection track carries the phosphor glow, and the shell's end glows once on arrival", async ({ page }) => {
    await openApp(page, { renderer: "compatibility", trustPromptFor: "staging-web" });
    await allowMotion(page);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await page.getByTestId("host-list").getByRole("button", { name: "staging-web", exact: true }).dblclick();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    // Waiting on the server identity: the travelled rail glows (a static shadow, not an animation).
    expect(await page.locator(".track-fill").first().evaluate((el) => getComputedStyle(el).boxShadow)).toContain("rgba(247, 164, 64");
    await page.getByRole("button", { name: "Trust once" }).click();
    // Arrived: one 900 ms fade on the shell's end, then nothing.
    const glow = await page
      .locator('.track-to[data-state="done"]')
      .first()
      .evaluate((el) => el.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName));
    expect(glow).toContain("ag-afterglow");
  });
});

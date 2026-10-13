// Afterglow host sheet physics (experimental UI, branch only; plan §6 moment 4). UI-only mock
// backend; checks the gesture, never counts as native verification.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function allowMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
}

async function openPanel(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByTestId("host-list").getByRole("button", { name: "staging-web", exact: true }).click();
  const panel = page.getByTestId("host-panel");
  await expect(panel).toBeVisible();
  await page.waitForTimeout(300);
  return panel;
}

/** A point on the header that is not a button: the title area. */
async function grip(page: Page) {
  const box = (await page.locator(".host-panel-heading").boundingBox())!;
  return { x: box.x + 20, y: box.y + box.height / 2 };
}

const translateX = (page: Page) => page.getByTestId("host-panel").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);

test.describe("host sheet", () => {
  test("it follows the pointer 1:1 from where it was grabbed", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await openPanel(page);
    const { x, y } = await grip(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 3 });
    await page.mouse.move(x + 60, y, { steps: 3 });
    expect(await translateX(page)).toBeCloseTo(60, 0);
    await page.mouse.up();
  });

  test("a flick throws it away; the panel closes", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await openPanel(page);
    const { x, y } = await grip(page);
    // About 80 px in one stroke dispatched within a single task, so the browser's timestamps are
    // those of a real flick whatever the load on this machine: far less than half the width.
    await page.evaluate(({ x, y }) => {
      const head = document.querySelector(".host-panel-heading") as HTMLElement;
      const fire = (type: string, clientX: number) =>
        head.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerId: 7, isPrimary: true, button: 0, clientX, clientY: y }));
      fire("pointerdown", x);
      for (let i = 1; i <= 8; i += 1) fire("pointermove", x + i * 10);
      fire("pointerup", x + 80);
    }, { x, y });
    await expect(page.getByTestId("host-panel")).toHaveCount(0);
  });

  test("a slow, short drag springs back home", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await openPanel(page);
    const { x, y } = await grip(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 8 });
    // Hold still, so the release carries no velocity.
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(page.getByTestId("host-panel")).toBeVisible();
    await expect.poll(() => translateX(page)).toBe(0);
  });

  test("dragged left past home it rubber-bands", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await openPanel(page);
    const { x, y } = await grip(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y, { steps: 10 });
    const offset = await translateX(page);
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-120 * 0.55);
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect.poll(() => translateX(page)).toBe(0);
  });

  test("buttons in the header are never a handle", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await openPanel(page);
    const close = page.getByTestId("host-panel").getByRole("button", { name: "Close host details" });
    const box = (await close.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 4 });
    expect(await translateX(page)).toBe(0);
    await page.mouse.up();
  });

  test("under reduced motion the drag still follows and the release simply lands", async ({ page }) => {
    await openApp(page);
    await openPanel(page);
    const { x, y } = await grip(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 6 });
    expect(await translateX(page)).toBeCloseTo(40, 0);
    await page.waitForTimeout(150);
    await page.mouse.up();
    expect(await translateX(page)).toBe(0);
    expect(await page.getByTestId("host-panel").evaluate((el) => el.getAnimations().length)).toBe(0);
  });
});

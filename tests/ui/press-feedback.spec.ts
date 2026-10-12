// Instant feedback (docs/design/interaction-polish.md, section 1): pressed state on pointer down
// with no transition, hover in at once and out over 120 ms (none under reduced motion), and
// skeletons that only show once a wait passes 150 ms. Mock backend; UI evidence only.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const nav = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name });

async function pressOn(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

test("press: buttons, rows and menu items show a pressed state on pointer down, with no transition", async ({ page }) => {
  await openApp(page);
  await nav(page, /^Hosts/).click();
  const add = page.getByRole("button", { name: "Add host" });
  await pressOn(page, add);
  // Marked in the pointerdown itself, before any click handler ran.
  await expect(add).toHaveAttribute("data-pressed", "true");
  expect(await add.evaluate((el) => getComputedStyle(el).transitionDuration.split(",").every((d) => d.trim() === "0s"))).toBe(true);
  expect(await add.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("gradient");
  // Still nothing opened: the press is shown before the action.
  await expect(page.getByTestId("host-panel")).toHaveCount(0);
  await page.mouse.up();
  await expect(add).not.toHaveAttribute("data-pressed", /.*/);

  // A host card (a row-like surface) and a sidebar item.
  const card = page.getByTestId("host-list").getByRole("article", { name: "edge-cache" });
  await pressOn(page, card.locator(".host-card-dest"));
  await expect(card).toHaveAttribute("data-pressed", "true");
  await page.mouse.up();
  await expect(card).not.toHaveAttribute("data-pressed", /.*/);

  // A menu item.
  await page.getByTestId("host-list").getByRole("button", { name: "More actions for edge-cache" }).click();
  const item = page.getByRole("menuitem", { name: "Duplicate" });
  await pressOn(page, item);
  await expect(item).toHaveAttribute("data-pressed", "true");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.keyboard.press("Escape");

  // A disabled button is not pressed (the snippets page has no terminal to send to).
  await nav(page, /^Snippets/).click();
  const run = page.getByRole("button", { name: "Run Disk usage in the terminal" });
  await expect(run).toBeDisabled();
  await pressOn(page, run);
  await expect(run).not.toHaveAttribute("data-pressed", /.*/);
  await page.mouse.up();
});

test("hover: appears at once, fades out over 120 ms, and does not fade under reduced motion", async ({ page }) => {
  await openApp(page);
  const settings = nav(page, /^Settings/);
  const duration = () => settings.evaluate((el) => getComputedStyle(el).transitionDuration.split(",")[0]?.trim());
  // The test default emulates reduced motion: no fade at all.
  expect(await duration()).toBe("0s");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await settings.click();
  // This vault has the in-app switch on: still no fade.
  const reduce = page.getByRole("switch", { name: "Reduce motion" });
  await expect(reduce).toBeChecked();
  await page.mouse.move(0, 0);
  expect(await duration()).toBe("0s");
  await reduce.uncheck();
  await page.mouse.move(0, 0);
  // Not hovered: leaving fades over 120 ms.
  expect(await duration()).toBe("0.12s");
  await settings.hover();
  // Hovered: the hover colour applies at once.
  expect(await duration()).toBe("0s");
  await page.mouse.move(0, 0);

  // The in-app switch turns the fade off too.
  await reduce.check();
  expect(await duration()).toBe("0s");
});

test("skeleton: a slow list holds its space at once and shows placeholders only after 150 ms", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    (window as unknown as { __mockDelay: Record<string, number> }).__mockDelay = { known_host_list: 700 };
  });
  const started = Date.now();
  await nav(page, /^Known hosts/).click();
  const space = page.locator(".skeleton-rows");
  await expect(space).toBeVisible();
  expect((await space.boundingBox())?.height ?? 0).toBeGreaterThan(50);
  await expect(page.locator(".skeleton").first()).toBeVisible();
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  // The rows replace the placeholders.
  await expect(page.getByText("10.20.0.11", { exact: true })).toBeVisible();
  await expect(page.locator(".skeleton-rows")).toHaveCount(0);
});

test("skeleton: a fast load never flashes placeholders", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    (window as unknown as { __mockDelay: Record<string, number> }).__mockDelay = { known_host_list: 60 };
    const w = window as unknown as { __sawSkeleton: boolean };
    w.__sawSkeleton = false;
    new MutationObserver(() => {
      if (document.querySelector(".skeleton")) w.__sawSkeleton = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  });
  await nav(page, /^Known hosts/).click();
  await expect(page.getByText("10.20.0.11", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sawSkeleton: boolean }).__sawSkeleton)).toBe(false);
});

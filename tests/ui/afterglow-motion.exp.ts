// Afterglow motion (experimental UI, branch only; plan §10.2). Runs only with
// playwright.exp.config.ts. UI-only mock backend: these check the interface's motion rules and
// never count as native verification.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function allowMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
}

/** Running or pending animations: what they animate, how long, and on what. */
function live(page: Page) {
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
        if (a instanceof CSSTransition) props.add(a.transitionProperty);
        for (const p of [...props]) if (/[A-Z]/.test(p)) { props.delete(p); props.add(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)); }
        const target = effect.target as Element | null;
        return {
          props: [...props],
          duration: Number(effect.getTiming().duration),
          name: String((a as CSSAnimation).animationName ?? ""),
          inTerminal: !!target?.closest(".terminal-host"),
          on: target ? `${target.tagName.toLowerCase()}.${[...target.classList].join(".")}` : "",
        };
      })
      .filter((a) => a.duration > 0 && !/spin|pulse|breathe|blink|progress/.test(a.name)),
  );
}

const ALLOWED = new Set(["transform", "opacity", "background-color", "border-color", "color", "box-shadow", "stroke-dashoffset", "width", "min-width"]);

test.describe("Afterglow motion", () => {
  test("a pressed button springs back: a 200 ms linear() transition on transform", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    const button = page.getByRole("button", { name: "New host" }).first();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(button).toHaveAttribute("data-pressed", "true");
    // Pressed: scaled to 0.97 after its 90 ms ease.
    await page.waitForTimeout(150);
    expect(await button.evaluate((el) => getComputedStyle(el).transform)).toBe("matrix(0.97, 0, 0, 0.97, 0, 0)");
    const release = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { properties: cs.transitionProperty, durations: cs.transitionDuration, easings: cs.transitionTimingFunction };
    });
    expect(release.properties.split(", ").at(-1)).toBe("transform");
    await page.mouse.up();
    // Released (after main's 100 ms minimum press): the spring runs, no longer than 220 ms.
    await expect(button).not.toHaveAttribute("data-pressed", /.*/);
    const spring = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      const names = cs.transitionProperty.split(", ");
      const i = names.indexOf("transform");
      return { duration: cs.transitionDuration.split(", ")[i], easing: cs.transitionTimingFunction.split(/,\s*(?![^()]*\))/)[i] };
    });
    expect(spring.duration).toBe("0.2s");
    expect(spring.easing?.startsWith("linear(")).toBe(true);
  });

  test("every running animation stays inside the budget: composite properties, 220 ms, never the terminal", async ({ page }) => {
    await openApp(page, { renderer: "compatibility" });
    await allowMotion(page);
    const primary = page.getByRole("navigation", { name: "Primary" });
    const check = async () => {
      for (const a of await live(page)) {
        expect(a.inTerminal, JSON.stringify(a)).toBe(false);
        expect(a.duration, JSON.stringify(a)).toBeLessThanOrEqual(220);
        for (const p of a.props) expect(ALLOWED.has(p), JSON.stringify(a)).toBe(true);
      }
    };
    await primary.getByRole("button", { name: /^Hosts/ }).click();
    await check();
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await check();
    await page.keyboard.press("Escape");
    await primary.getByRole("button", { name: /^Snippets/ }).click();
    await check();
    await primary.getByRole("button", { name: "Local terminal" }).click();
    await expect(page.locator(".terminal-host").first()).toBeVisible();
    await check();
  });

  test("a menu opened by the pointer springs from its trigger; from the keyboard it is simply there", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    const sort = page.getByRole("button", { name: "Sort", exact: true });
    await sort.click();
    const menu = page.getByRole("menu", { name: "Sort" });
    await expect(menu).toBeVisible();
    const pointer = await menu.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { durations: cs.transitionDuration, easing: cs.transitionTimingFunction };
    });
    expect(pointer.durations).toBe("0.14s, 0.18s");
    expect(pointer.easing).toContain("linear(");
    await page.keyboard.press("Escape");
    await sort.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  });

  test("reduced motion: the springs collapse to zero and nothing moves", async ({ page }) => {
    await openApp(page);
    for (const name of ["--spring-release-duration", "--spring-popover-duration", "--spring-sheet-duration"]) {
      expect(Number.parseFloat(await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n), name))).toBe(0);
    }
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    expect(await live(page)).toEqual([]);
  });

  test("icons are Phosphor, drawn inline", async ({ page }) => {
    await openApp(page);
    const viewBoxes = await page.getByRole("navigation", { name: "Primary" }).locator("svg:not(.brand-mark)").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("viewBox")))]);
    expect(viewBoxes).toEqual(["0 0 256 256"]);
  });
});

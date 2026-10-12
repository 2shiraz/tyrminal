import { expect, type Page, test } from "@playwright/test";

import { openApp } from "./fixtures";

// The motion rules (docs/design/motion.md): motion answers the pointer and never the keyboard;
// transform and opacity only, 100 to 220 ms; nothing at all under reduced motion; the terminal
// canvas never animates.

/** Every animation or transition running or about to and taking time, with what it moves. */
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
        // Loops that show a state (connecting, a spinner, the terminal cursor) are not interface motion.
        const name = String((a as CSSAnimation).animationName ?? "");
        // A CSS transition is a state change (a hover colour, say); the movement rules are for the rest.
        const transition = a.constructor.name === "CSSTransition";
        return { duration: Number(effect.getTiming().duration), props: [...props], transition, name };
      })
      .filter((a) => a.duration > 0 && !/spin|pulse|breathe|blink|progress/.test(a.name)),
  );
}

/** Allows motion: the system setting and the in-app switch (which the mock vault saves on). */
async function allowMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
}

const newTabMenu = (page: Page) => page.getByRole("menu", { name: "New tab" });

test.describe("motion allowed", () => {
  test("a menu opened by the pointer grows from its trigger's corner, briefly", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.getByRole("button", { name: "New tab" }).click();
    const menu = newTabMenu(page);
    await expect(menu).toBeVisible();
    const style = await menu.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { duration: cs.transitionDuration, origin: cs.transformOrigin, width: el.getBoundingClientRect().width, openedBy: (el as HTMLElement).dataset.openedBy };
    });
    expect(style.openedBy).toBe("pointer");
    expect(style.duration).toContain("0.14s");
    // Anchored under the button and aligned to its right edge: it grows from the top right.
    const [x, y] = style.origin.split(" ").map((v) => Number.parseFloat(v));
    expect(x).toBeGreaterThan(style.width / 2);
    expect(y).toBe(0);
    for (const animation of await liveAnimations(page)) {
      expect(animation.duration).toBeLessThanOrEqual(220);
      if (!animation.transition) for (const prop of animation.props) expect(["opacity", "transform"]).toContain(prop);
    }
  });

  test("a menu opened from the keyboard is simply there, with focus on its first item", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.getByRole("button", { name: "New tab" }).focus();
    await page.keyboard.press("Enter");
    const menu = newTabMenu(page);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-opened-by", "keyboard");
    expect(await menu.evaluate((el) => el.getAnimations().length)).toBe(0);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
  });

  test("the palette from the keyboard does not animate and takes typing at once", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.keyboard.press("Control+Shift+K");
    await page.keyboard.type("api");
    const input = page.getByRole("combobox", { name: /Type a command/ });
    await expect(input).toHaveValue("api");
    const palette = page.locator("dialog.palette");
    await expect(palette).toHaveAttribute("data-opened-by", "keyboard");
    expect(await palette.evaluate((el) => el.getAnimations().length)).toBe(0);
  });

  test("a transfer bar glides between progress ticks", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    const duration = await page.evaluate(() => {
      const bar = document.createElement("span");
      bar.className = "xfer-bar";
      const fill = document.createElement("span");
      bar.append(fill);
      document.body.append(bar);
      const value = getComputedStyle(fill).transitionDuration;
      bar.remove();
      return value;
    });
    expect(duration).toBe("0.2s");
  });
});

for (const mode of ["system setting", "in-app switch"] as const) {
  test(`reduced motion (${mode}): nothing moves`, async ({ page }) => {
    await openApp(page);
    if (mode === "in-app switch") {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => {
        document.documentElement.dataset.reduceMotion = "true";
      });
    }
    // Zero in whatever unit the build writes it ("0ms" or "0s").
    expect(Number.parseFloat(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--duration-glide")))).toBe(0);

    const still = async () => expect(await liveAnimations(page)).toEqual([]);
    const primary = page.getByRole("navigation", { name: "Primary" });

    await page.getByRole("button", { name: "New tab" }).click();
    await expect(newTabMenu(page)).toBeVisible();
    await still();
    await page.keyboard.press("Escape");

    await primary.getByRole("button", { name: /^Hosts/ }).click();
    await page.getByRole("button", { name: "Add host" }).first().click();
    await expect(page.getByTestId("host-panel")).toBeVisible();
    await still();

    await primary.getByRole("button", { name: "Settings" }).click();
    await still();

    await page.keyboard.press("Control+Shift+T");
    await expect(page.getByRole("tab", { name: /Local terminal/ })).toBeVisible();
    await still();
    await page.getByRole("button", { name: "Search or run a command" }).click();
    await expect(page.locator("dialog.palette")).toBeVisible();
    await still();
  });
}

test("the terminal canvas never animates", async ({ page }) => {
  await openApp(page);
  await allowMotion(page);
  await page.keyboard.press("Control+Shift+T");
  const host = page.locator(".terminal-host").first();
  await expect(host).toBeVisible();
  const report = await host.evaluate((el) => {
    const cs = getComputedStyle(el);
    const transitions = el.getAnimations({ subtree: true }).filter((a) => a.constructor.name === "CSSTransition").length;
    return { duration: cs.transitionDuration, transitions };
  });
  expect(report.transitions).toBe(0);
  expect(report.duration.split(",").every((d) => d.trim() === "0s")).toBe(true);
});

// Moments (motion.md PR 4).
test.describe("moments", () => {
  test("a wrong passphrase shakes the card once and puts focus back in the field", async ({ page }) => {
    await openApp(page, { scenario: "locked" });
    await allowMotion(page);
    const field = page.getByLabel("Passphrase");
    await field.fill("not it");
    await page.keyboard.press("Enter");
    await expect(page.getByText("That did not unlock the vault.")).toBeVisible();
    await expect(field).toBeFocused();
    const card = page.locator("form.auth-card");
    const shakes = await card.evaluate((el) => el.getAnimations().map((a) => Number((a.effect as KeyframeEffect).getTiming().duration)));
    expect(shakes).toEqual([220]);
    // The right one still opens the vault, and the window fades in.
    await field.fill("correct horse");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("under reduced motion a wrong passphrase only refocuses", async ({ page }) => {
    await openApp(page, { scenario: "locked" });
    const field = page.getByLabel("Passphrase");
    await field.fill("not it");
    await page.keyboard.press("Enter");
    await expect(page.getByText("That did not unlock the vault.")).toBeVisible();
    await expect(field).toBeFocused();
    expect(await page.locator("form.auth-card").evaluate((el) => el.getAnimations().length)).toBe(0);
  });

  test("a finished transfer flashes once, and status dots change colour gently", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    const style = await page.evaluate(() => {
      const row = document.createElement("li");
      row.className = "xfer-row";
      row.dataset.state = "done";
      const dot = document.createElement("span");
      dot.className = "status-dot";
      document.body.append(row, dot);
      const result = { flash: getComputedStyle(row).animationName, dot: getComputedStyle(dot).transitionProperty };
      row.remove();
      dot.remove();
      return result;
    });
    expect(style).toEqual({ flash: "m-flash", dot: "background-color" });
  });
});

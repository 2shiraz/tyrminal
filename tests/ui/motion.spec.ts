import { expect, type Page, test } from "@playwright/test";

import { connectHost, editHost, openApp } from "./fixtures";

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

// A menu to open and close: Sort on Hosts ("+" in the tab strip opens the new tab page now).
const menuButton = (page: Page) => page.getByRole("button", { name: "Sort", exact: true });
const newTabMenu = (page: Page) => page.getByRole("menu", { name: "Sort" });

test.describe("motion allowed", () => {
  test("a menu opened by the pointer grows from its trigger's corner, briefly", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await menuButton(page).click();
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
    await menuButton(page).focus();
    await page.keyboard.press("Enter");
    const menu = newTabMenu(page);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-opened-by", "keyboard");
    expect(await menu.evaluate((el) => el.getAnimations().length)).toBe(0);
    await expect(menu.getByRole("menuitemcheckbox").first()).toBeFocused();
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
    // File-management CSS is lazy-loaded: open the Files panel of an SSH session (a local terminal
    // has no files) before inspecting its bar.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await connectHost(page, "api-gateway");
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Files" }).getByRole("grid")).toBeVisible();
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

    await menuButton(page).click();
    await expect(newTabMenu(page)).toBeVisible();
    await still();
    await page.keyboard.press("Escape");

    await primary.getByRole("button", { name: /^Hosts/ }).click();
    await page.getByRole("button", { name: "New host" }).first().click();
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

// Exits (motion.md PR 2): a static, inert copy fades in place of what closed; the real element is
// gone at once.
const ghosts = (page: Page) => page.locator("[data-exit-ghost]");

test.describe("exits", () => {
  test("a menu closed with the pointer fades out as an inert copy; the menu itself is gone at once", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await menuButton(page).click();
    await expect(newTabMenu(page)).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(newTabMenu(page)).toHaveCount(0);
    const ghost = ghosts(page).first();
    await expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(await ghost.evaluate((el) => ({ inert: el.hasAttribute("inert"), roles: el.querySelectorAll("[role]").length + (el.hasAttribute("role") ? 1 : 0) }))).toEqual({
      inert: true,
      roles: 0,
    });
    await expect(ghosts(page)).toHaveCount(0);
  });

  test("closed from the keyboard, or under reduced motion, nothing lingers", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await menuButton(page).click();
    await expect(newTabMenu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(newTabMenu(page)).toHaveCount(0);
    expect(await ghosts(page).count()).toBe(0);

    await page.evaluate(() => {
      document.documentElement.dataset.reduceMotion = "true";
    });
    await menuButton(page).click();
    await page.mouse.click(5, 400);
    await expect(newTabMenu(page)).toHaveCount(0);
    expect(await ghosts(page).count()).toBe(0);
  });

  test("locking leaves no copy of a panel or toast behind", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.keyboard.press("Control+Shift+K");
    await page.keyboard.type("api-gateway");
    await page.keyboard.press("Enter");
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    await page.keyboard.press("Control+Shift+S");
    await page.getByRole("button", { name: "Run Disk usage in the terminal" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent “Disk usage”" })).toBeVisible();
    // Lock with the pointer, so the exits would otherwise play.
    await page.getByRole("button", { name: "Lock vault" }).click();
    await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
    expect(await ghosts(page).count()).toBe(0);
    const text = await page.evaluate(() => document.body.innerText);
    for (const leaked of ["Disk usage", "api-gateway", "df -h"]) expect(text).not.toContain(leaked);
  });

  test("a new toast pushes the stack up with a glide, not a jump", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.keyboard.press("Control+Shift+K");
    await page.keyboard.type("api-gateway");
    await page.keyboard.press("Enter");
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    await page.keyboard.press("Control+Shift+S");
    const run = page.getByRole("button", { name: "Run Disk usage in the terminal" });
    await run.click();
    const toasts = page.locator(".toasts .toast");
    await expect(toasts).toHaveCount(1);
    await page.waitForTimeout(400);
    await run.click();
    await expect(toasts).toHaveCount(2);
    // The stack sits on the status bar: the older toast moves up, gliding from where it was.
    const glides = await toasts.first().evaluate((el) =>
      el.getAnimations().filter((a) => String((a.effect as KeyframeEffect).getKeyframes()[0]?.transform ?? "").startsWith("translate(")).length,
    );
    expect(glides).toBe(1);
  });

  test("a hovered toast stays until the pointer leaves", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await page.keyboard.press("Control+Shift+K");
    await page.keyboard.type("api-gateway");
    await page.keyboard.press("Enter");
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    await page.keyboard.press("Control+Shift+S");
    await page.getByRole("button", { name: "Run Disk usage in the terminal" }).click();
    const toast = page.locator(".toast").filter({ hasText: "Sent “Disk usage”" });
    await expect(toast).toBeVisible();
    // The stack is click-through (a toast never covers a control), so the pointer is placed on it
    // without the "receives pointer events" check; the hover is found by hit-testing.
    await toast.hover({ force: true });
    await page.waitForTimeout(5000);
    await expect(toast).toBeVisible();
    await page.mouse.move(5, 400);
    await expect(toast).toHaveCount(0, { timeout: 6000 });
  });
});

// Moments (motion.md PR 4).
test.describe("moments", () => {
  test("a wrong passphrase keeps the error stable and puts focus back in the field", async ({ page }) => {
    await openApp(page, { scenario: "locked" });
    await allowMotion(page);
    const field = page.getByLabel("Passphrase");
    await field.fill("not it");
    await page.keyboard.press("Enter");
    await expect(page.getByText("That did not unlock the vault.")).toBeVisible();
    await expect(field).toBeFocused();
    const card = page.locator("form.auth-card");
    const transforms = await card.evaluate((el) => el.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes()).filter((frame) => frame.transform && frame.transform !== "none"));
    expect(transforms).toEqual([]);
    expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
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

// Glides and lists (motion.md PR 3).
test.describe("glides and lists", () => {
  const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

  test("the current page marker glides to a clicked nav item, and rests as the item's own", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await primary(page).getByRole("button", { name: /^Snippets/ }).click();
    const glide = primary(page).locator(".nav-glide");
    await expect(glide).toHaveCount(1);
    expect(await glide.evaluate((el) => el.getAnimations().map((a) => Number((a.effect as KeyframeEffect).getTiming().duration)))).toEqual([140]);
    await expect(primary(page)).toHaveAttribute("data-gliding", "");
    // Settled: no copy left, and the item carries its own marker again.
    await expect(glide).toHaveCount(0);
    await expect(primary(page)).not.toHaveAttribute("data-gliding", /.*/);
    await expect(primary(page).getByRole("button", { name: /^Snippets/ })).toHaveAttribute("aria-current", "page");
  });

  test("from the keyboard, or under reduced motion, the marker simply moves", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await primary(page).getByRole("button", { name: /^Snippets/ }).focus();
    await page.keyboard.press("Enter");
    await expect(primary(page).getByRole("button", { name: /^Snippets/ })).toHaveAttribute("aria-current", "page");
    expect(await primary(page).locator(".nav-glide").count()).toBe(0);

    await page.evaluate(() => {
      document.documentElement.dataset.reduceMotion = "true";
    });
    await primary(page).getByRole("button", { name: /^Hosts/ }).click();
    await expect(primary(page).getByRole("button", { name: /^Hosts/ })).toHaveAttribute("aria-current", "page");
    expect(await primary(page).locator(".nav-glide").count()).toBe(0);
  });

  test("arriving by click, the first rows come in one after another and stay usable; typing never moves rows", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await primary(page).getByRole("button", { name: /^Snippets/ }).click();
    const rows = page.locator('[data-testid="snippet-list"] [data-flip-key]');
    await expect(rows.first()).toBeVisible();
    const arrival = await rows.evaluateAll((els) =>
      els.map((el) => {
        const [animation] = el.getAnimations();
        const effect = animation?.effect as KeyframeEffect | undefined;
        return effect ? { delay: effect.getTiming().delay, duration: effect.getTiming().duration, props: Object.keys(effect.getKeyframes()[0] ?? {}).filter((k) => ["opacity", "transform"].includes(k)).sort() } : null;
      }),
    );
    expect(arrival.length).toBeGreaterThan(1);
    // 30 ms apart, the sixth row's delay is the longest, 180 ms each: opacity and transform only.
    arrival.forEach((row, index) => expect(row).toEqual({ delay: Math.min(index, 5) * 30, duration: 180, props: ["opacity", "transform"] }));
    // A row is not blocked while it arrives.
    expect(await rows.first().evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");
    // Once the arrival has settled every row is fully there, and filtering from the keyboard re-orders at once.
    await expect.poll(() => rows.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length)).toBe(0);
    expect(await rows.evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === "1"))).toBe(true);
    await page.getByRole("searchbox").first().click();
    await page.keyboard.type("di");
    expect(await rows.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length)).toBe(0);
  });

  test("arriving from the keyboard or with reduced motion, rows are there at once", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    const rows = page.locator('[data-testid="snippet-list"] [data-flip-key]');
    await primary(page).getByRole("button", { name: /^Snippets/ }).focus();
    await page.keyboard.press("Enter");
    await expect(rows.first()).toBeVisible();
    expect(await rows.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length)).toBe(0);
    await primary(page).getByRole("button", { name: /^Hosts/ }).click();
    await page.evaluate(() => {
      document.documentElement.dataset.reduceMotion = "true";
    });
    await primary(page).getByRole("button", { name: /^Snippets/ }).click();
    await expect(rows.first()).toBeVisible();
    expect(await rows.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length)).toBe(0);
  });
});

// Host details (owner request): opened by a click, the content slides in while the cards glide to
// the narrower list; switching hosts only crossfades; keyboard and reduced motion are instant.
test.describe("host details", () => {
  const panelContent = (page: Page) =>
    page.getByTestId("host-panel").evaluate((el) =>
      [...el.children]
        .filter((c) => !c.classList.contains("resize-handle"))
        .flatMap((c) => c.getAnimations().map((a) => Object.keys((a.effect as KeyframeEffect).getKeyframes()[0] ?? {}).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).sort().join("+"))),
    );
  async function toHosts(page: Page) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
  }

  test("Edit slides content in; switching hosts crossfades; closing removes credential forms immediately", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await toHosts(page);
    const list = page.getByTestId("host-list");
    await editHost(page, "staging-web");
    await expect(page.getByTestId("host-panel")).toBeVisible();
    expect(new Set(await panelContent(page))).toEqual(new Set(["opacity+transform"]));
    await expect.poll(() => panelContent(page)).toEqual([]);

    await list.getByRole("button", { name: "edge-cache", exact: true }).click();
    await expect(page.getByTestId("host-panel-location")).toBeVisible();
    await expect.poll(async () => new Set(await panelContent(page))).toEqual(new Set(["opacity"]));

    await page.getByTestId("host-panel").getByRole("button", { name: "Close host details" }).click();
    await expect(page.getByTestId("host-panel")).toHaveCount(0);
    // Host details contain editable credentials: no copy may extend their lifetime for motion.
    expect(await page.locator("[data-exit-ghost]").count()).toBe(0);
    await expect(list.getByRole("button", { name: "edge-cache", exact: true })).toBeFocused();
  });

  test("opened from the keyboard, or under reduced motion, the panel is simply there", async ({ page }) => {
    await openApp(page);
    await allowMotion(page);
    await toHosts(page);
    await page.getByRole("button", { name: "New host", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("host-panel")).toBeVisible();
    expect(await panelContent(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("host-panel")).toHaveCount(0);
    expect(await page.locator("[data-exit-ghost]").count()).toBe(0);

    await page.evaluate(() => {
      document.documentElement.dataset.reduceMotion = "true";
    });
    await page.getByRole("button", { name: "New host", exact: true }).click();
    await expect(page.getByTestId("host-panel")).toBeVisible();
    expect(await panelContent(page)).toEqual([]);
  });
});

// The connection side panel (TRM-14): snippets, connection history and appearance beside the
// terminal. Mock backend; never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";
import { paletteRun } from "./input-helpers";

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const panel = (page: Page) => page.locator("aside.side-panel");

test("side panel: snippets, history and appearance are sections of one panel; keyboard moves between them", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+S");
  await expect(page.getByRole("complementary", { name: "Snippets" })).toBeVisible();
  const tabs = panel(page).getByRole("tablist", { name: "Panel sections" }).getByRole("tab");
  await expect(tabs).toHaveText(["Snippets", "History", "Appearance"]);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("complementary", { name: "History" })).toBeVisible();
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("complementary", { name: "Appearance" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("complementary", { name: "Snippets" })).toBeVisible();

  // From another section the snippets shortcut shows snippets; pressed again it closes the panel.
  await tabs.nth(2).click();
  await page.keyboard.press("Control+Shift+S");
  await expect(page.getByRole("complementary", { name: "Snippets" })).toBeVisible();
  await page.keyboard.press("Control+Shift+S");
  await expect(panel(page)).toHaveCount(0);

  // The palette opens a section directly; Escape closes the panel.
  await paletteRun(page, "Show connection history");
  await expect(page.getByRole("complementary", { name: "History" })).toBeVisible();
  await panel(page).getByRole("tab", { name: "History" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("side panel history: recent connections with the current one marked; reopening starts a new tab", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await paletteRun(page, "Show connection history");
  const list = page.getByRole("list", { name: "Recent connections" });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const current = list.locator("li[data-current]");
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("api-gateway");
  await expect(current).toContainText("This tab");
  await expect(list.getByRole("listitem").first()).toContainText(/Last connected|Not connected yet/);
  await expect(panel(page)).toContainText("Tyrminal does not record what you type.");

  const other = list.locator("li:not([data-current])").first();
  const label = (await other.locator(".row-main .truncate").first().textContent())?.trim() ?? "";
  await other.getByRole("button", { name: `Open ${label} in a new tab` }).click();
  await expect(page.locator(".tabstrip .tab:not(.tab-page)")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: new RegExp(label) })).toHaveAttribute("aria-selected", "true");
});

test("side panel appearance: scheme, font and cursor apply live and persist; zoom is this pane only", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  await paletteRun(page, "Show terminal appearance");
  const side = page.getByRole("complementary", { name: "Appearance" });
  await expect(side).toBeVisible();

  const prefs = () => page.evaluate(() => (window as unknown as { __mockState: { prefs: { terminal: Record<string, unknown> } } }).__mockState.prefs.terminal);
  const scheme = side.getByLabel("Color scheme");
  const options = await scheme.locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  const current = (await prefs()).scheme;
  const other = options.find((v) => v !== current) as string;
  await scheme.selectOption(other);
  await expect.poll(async () => (await prefs()).scheme).toBe(other);
  await side.locator("label").filter({ hasText: /^Bar$/ }).click();
  await expect.poll(async () => (await prefs()).cursorStyle).toBe("bar");

  const fontSizes = () => page.locator(".pane .xterm-rows").evaluateAll((els) => els.map((e) => getComputedStyle(e).fontSize));
  const before = await fontSizes();
  expect(before[0]).toBe(before[1]);
  // The focused pane is the second one; zoom changes it alone and is not saved.
  const savedSize = (await prefs()).fontSize;
  await side.getByRole("button", { name: "Zoom in" }).click();
  await side.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(fontSizes).not.toEqual(before);
  const after = await fontSizes();
  expect(after[0]).toBe(before[0]);
  expect(parseFloat(after[1] as string)).toBeGreaterThan(parseFloat(before[1] as string));
  expect((await prefs()).fontSize).toBe(savedSize);
  await side.getByRole("button", { name: "Reset zoom" }).click();
  await expect.poll(fontSizes).toEqual(before);
});

test("side panel appearance: rows sit at the top, each label above its full-width control", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await paletteRun(page, "Show terminal appearance");
  const side = page.getByRole("complementary", { name: "Appearance" });
  const rows = side.locator(".setting-row");
  await expect(rows.first()).toBeVisible();
  const boxes = await rows.evaluateAll((els) =>
    els.map((el) => {
      const label = el.querySelector(".setting-label")?.getBoundingClientRect();
      const control = el.querySelector(".setting-control")?.getBoundingClientRect();
      return { top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, labelBottom: label?.bottom ?? 0, labelWidth: label?.width ?? 0, controlTop: control?.top ?? 0 };
    }),
  );
  for (const [i, b] of boxes.entries()) {
    // The label is above the control and has room for its words.
    expect(b.labelBottom).toBeLessThanOrEqual(b.controlTop + 1);
    expect(b.labelWidth).toBeGreaterThan(120);
    // Rows are packed, not stretched over the panel's height.
    expect(b.height).toBeLessThan(90);
    if (i > 0) expect(b.top - (boxes[i - 1]?.top ?? 0)).toBeLessThan(100);
  }
});

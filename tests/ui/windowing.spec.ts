// Large lists: lists are windowed above 200 rows.
// Only rows near the visible part are in the DOM, the list still reports its full size to
// assistive technology, and keyboard navigation reaches the end. Mock backend.
import { expect, test } from "@playwright/test";

import { chooseLayout, openApp } from "./fixtures";

test("windowing: a folder of 500 files keeps a window of rows; keys and type-ahead reach any row", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await page.evaluate(() => {
    const add = (window as unknown as { __mockAddFile: (p: string) => void }).__mockAddFile;
    for (let n = 1; n <= 500; n++) add(`/home/deploy/zz-${String(n).padStart(3, "0")}.log`);
  });
  await page.keyboard.press("Control+Shift+O");
  const panel = page.getByRole("complementary", { name: "Files" });
  const grid = panel.getByRole("grid", { name: /^Contents of \// });
  await expect(grid).toBeVisible();
  // 505 entries and the header row; spacer rows are hidden from assistive technology.
  await expect(grid).toHaveAttribute("aria-rowcount", "506");
  expect(await grid.getByRole("row").count()).toBeLessThan(150);
  await expect(grid.getByRole("row").nth(1)).toHaveAttribute("aria-rowindex", "2");

  await grid.getByRole("button", { name: "Open app" }).click();
  await page.keyboard.press("End");
  const lastRow = grid.getByRole("row", { name: /zz-500\.log/ });
  await expect(lastRow).toHaveAttribute("aria-selected", "true");
  await expect(lastRow).toHaveAttribute("aria-rowindex", "506");
  await expect(lastRow.getByRole("button", { name: "Select zz-500.log" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(grid.getByRole("row", { name: /zz-499\.log/ })).toHaveAttribute("aria-selected", "true");
  await expect(grid.getByRole("button", { name: "Select zz-499.log" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(grid.getByRole("row", { name: /app/ }).first()).toHaveAttribute("aria-selected", "true");
  await expect(grid.getByRole("button", { name: "Open app" })).toBeFocused();
  expect(await grid.getByRole("row").count()).toBeLessThan(150);

  // Type-ahead jumps to a row far below the window and scrolls it in.
  await page.keyboard.type("zz-3");
  const typed = grid.getByRole("row", { name: /zz-300\.log/ });
  await expect(typed).toHaveAttribute("aria-selected", "true");
  await expect(typed).toHaveAttribute("aria-rowindex", "306");
  await expect(typed.getByRole("button", { name: "Select zz-300.log" })).toBeFocused();
  expect(await grid.getByRole("row").count()).toBeLessThan(150);

  // Rename in place works on a row of the window; Escape puts the keyboard back on it.
  await page.keyboard.press("F2");
  const field = grid.getByRole("textbox", { name: "New name for zz-300.log" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(typed.getByRole("button", { name: "Select zz-300.log" })).toBeFocused();

  // Scrolling (not the keyboard) brings the last rows in; the selection stays.
  await grid.evaluate((el) => {
    let s: HTMLElement | null = el.parentElement;
    while (s && !["auto", "scroll"].includes(getComputedStyle(s).overflowY)) s = s.parentElement;
    s?.scrollTo(0, 1e7);
  });
  await expect(grid.getByRole("row", { name: /zz-500\.log/ })).toBeVisible();
  await expect(grid.getByRole("row", { name: /zz-500\.log/ })).toHaveAttribute("aria-selected", "false");
  expect(await grid.getByRole("row").count()).toBeLessThan(150);
  // zz-300 left the window (out of the DOM) but is still the cursor: Tab finds a rendered row.
  await expect(grid.getByRole("button", { name: "Select zz-300.log" })).toHaveCount(0);
  await expect(grid.locator(".ft-name[tabindex='0']")).toHaveCount(1);
});

test("windowing: 500 trusted servers render a window; scrolling to the bottom shows the last one", async ({ page }) => {
  await openApp(page, { extraKnownHosts: 500 });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Known hosts/ }).click();
  const list = page.locator("main ul.list");
  const rows = list.locator(":scope > li[data-window-item]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeLessThan(150);
  // The mock's own trusted servers plus the 500 added ones.
  const total = await page.evaluate(() => (window as unknown as { __mockState: { knownHosts: unknown[] } }).__mockState.knownHosts.length);
  expect(total).toBeGreaterThan(500);
  await expect(rows.first()).toHaveAttribute("aria-setsize", String(total));
  await list.evaluate((el) => {
    let s: HTMLElement | null = el.parentElement;
    while (s && !["auto", "scroll"].includes(getComputedStyle(s).overflowY)) s = s.parentElement;
    (s ?? document.scrollingElement)?.scrollTo(0, 1e7);
  });
  await expect(page.getByText("bulk-500.example", { exact: true })).toBeVisible();
  expect(await rows.count()).toBeLessThan(150);
});

for (const layout of ["List", "Cards"] as const) {
  test(`windowing: 500 more hosts (${layout}) render a window; Home/End and arrows reach both ends`, async ({ page }) => {
    await openApp(page, { extraHosts: 500 });
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
    await chooseLayout(page, layout);
    const list = page.getByTestId("host-list");
    const rows = list.locator(":scope > li[data-window-item]");
    await expect(rows.first()).toBeVisible();
    // Only a window of the hosts is in the DOM, and screen readers still get the full count.
    expect(await rows.count()).toBeLessThan(150);
    const total = await rows.first().getAttribute("aria-setsize");
    expect(Number(total)).toBeGreaterThan(500);
    // While windowed, rows carry no FLIP key (nothing animates in while scrolling).
    await expect(list.locator(":scope > li[data-flip-key]")).toHaveCount(0);

    // The position of the host whose name has focus, from its row's aria-posinset.
    const focusedAt = () =>
      page.evaluate(() => Number(document.activeElement?.closest("[data-window-item]")?.getAttribute("aria-posinset") ?? 0));
    await list.locator(".host-open").first().focus();
    await page.keyboard.press("End");
    await expect.poll(focusedAt).toBe(Number(total));
    expect(await rows.count()).toBeLessThan(150);
    await page.keyboard.press(layout === "List" ? "ArrowUp" : "ArrowLeft");
    await expect.poll(focusedAt).toBe(Number(total) - 1);
    await page.keyboard.press("Home");
    await expect.poll(focusedAt).toBe(1);
  });
}

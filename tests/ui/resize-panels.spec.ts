// Resizable panels: the terminal side panel, the host details panel and the sidebar are resized by
// dragging their inner edge or with the keyboard; the width is clamped, saved in preferences
// (clamped again natively: crates/core/src/preferences.rs) and kept after a restart. Mock backend;
// never native evidence.

import { type Locator, type Page, expect, test } from "@playwright/test";

import { editHost, openApp } from "./fixtures";

type Call = { cmd: string; args: unknown };
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __mockCalls: Call[] }).__mockCalls.filter((x) => x.cmd === c).length, cmd);

const savedWidth = (page: Page, id: string) =>
  page.evaluate((key) => {
    const saved = sessionStorage.getItem("tyrminal-mock-prefs");
    return saved ? (JSON.parse(saved).panelWidths?.[key] ?? null) : null;
  }, id);

const width = async (locator: Locator) => Math.round((await locator.boundingBox())?.width ?? 0);

/** Presses on the handle's centre, moves by `dx` in steps, and releases. */
async function drag(page: Page, handle: Locator, dx: number, { release = true } = {}) {
  const box = await handle.boundingBox();
  if (!box) throw new Error("handle not visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  if (release) await page.mouse.up();
}

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

async function openSidePanel(page: Page) {
  await connect(page, "api-gateway");
  await page.keyboard.press("Control+Shift+S");
  await expect(page.getByRole("complementary", { name: "Snippets" })).toBeVisible();
}

async function openHostPanel(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await editHost(page, "staging-web");
  await expect(page.getByTestId("host-panel")).toBeVisible();
}

test("terminal side panel: a drag resizes it, the terminal fits once on release, and the width stays after a restart", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSidePanel(page);
  const panel = page.locator("aside.side-panel");
  const handle = page.getByRole("separator", { name: "Resize side panel" });
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await expect(handle).toHaveAttribute("aria-valuemin", "260");
  // 1360 px window: 1136 px beside the sidebar, less 320 px kept for the terminals, capped at 640.
  await expect(handle).toHaveAttribute("aria-valuemax", "640");
  expect(await width(panel)).toBe(320);
  await expect.poll(() => calls(page, "session_resize")).toBeGreaterThan(0);
  const resizes = await calls(page, "session_resize");

  // Mid-drag the panel follows the pointer but the terminal is not refitted.
  await drag(page, handle, -100, { release: false });
  await expect(page.locator("html")).toHaveAttribute("data-resizing", "");
  await expect.poll(() => width(panel)).toBe(420);
  await page.waitForTimeout(400);
  expect(await calls(page, "session_resize")).toBe(resizes);
  await page.mouse.up();
  await expect(page.locator("html")).not.toHaveAttribute("data-resizing");
  await expect(handle).toHaveAttribute("aria-valuenow", "420");
  // One fit after the drag: the narrower terminal sends its new size.
  await expect.poll(() => calls(page, "session_resize")).toBe(resizes + 1);

  await expect.poll(() => savedWidth(page, "sidePanel")).toBe(420);
  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await openSidePanel(page);
  await expect(page.getByRole("separator", { name: "Resize side panel" })).toHaveAttribute("aria-valuenow", "420");
  expect(await width(page.locator("aside.side-panel"))).toBe(420);
});

test("terminal side panel: min and max clamp, double-click resets, arrow keys step 16 px", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSidePanel(page);
  const panel = page.locator("aside.side-panel");
  const handle = page.getByRole("separator", { name: "Resize side panel" });

  await drag(page, handle, -2000);
  await expect(handle).toHaveAttribute("aria-valuenow", "640");
  expect(await width(panel)).toBe(640);
  await drag(page, handle, 2000);
  await expect(handle).toHaveAttribute("aria-valuenow", "260");
  expect(await width(panel)).toBe(260);

  await handle.dblclick();
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  expect(await width(panel)).toBe(320);
  await expect.poll(() => savedWidth(page, "sidePanel")).toBe(null);

  // The edge is on the panel's left: Left moves it left, widening the panel.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "336");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "304");
  expect(await width(panel)).toBe(304);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "260");
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "640");
  await expect.poll(() => savedWidth(page, "sidePanel")).toBe(640);
});

test("the side panel width is clamped again when the window gets smaller", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSidePanel(page);
  const handle = page.getByRole("separator", { name: "Resize side panel" });
  await handle.focus();
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "640");
  // 900 px window: 676 px beside the sidebar, 320 kept for the terminals.
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(handle).toHaveAttribute("aria-valuemax", "356");
  await expect(handle).toHaveAttribute("aria-valuenow", "356");
  expect(await width(page.locator("aside.side-panel"))).toBe(356);
  // The saved choice is kept: a wider window shows it again.
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(handle).toHaveAttribute("aria-valuenow", "640");
});

test("host details panel: drag, clamp, reset, keyboard, and the width stays after a restart", async ({ page }) => {
  await openApp(page);
  await openHostPanel(page);
  const panel = page.getByTestId("host-panel");
  const handle = page.getByRole("separator", { name: "Resize host details" });
  await expect(handle).toHaveAttribute("aria-valuenow", "400");
  await expect(handle).toHaveAttribute("aria-valuemin", "340");
  await expect(handle).toHaveAttribute("aria-valuemax", "720");
  expect(await width(panel)).toBe(400);

  await drag(page, handle, -2000);
  await expect(handle).toHaveAttribute("aria-valuenow", "720");
  await drag(page, handle, 2000);
  await expect(handle).toHaveAttribute("aria-valuenow", "340");
  expect(await width(panel)).toBe(340);
  await handle.dblclick();
  await expect(handle).toHaveAttribute("aria-valuenow", "400");

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "416");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "384");

  await drag(page, handle, -116);
  await expect(handle).toHaveAttribute("aria-valuenow", "500");
  expect(await width(panel)).toBe(500);
  await expect.poll(() => savedWidth(page, "hostPanel")).toBe(500);
  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await openHostPanel(page);
  await expect(page.getByRole("separator", { name: "Resize host details" })).toHaveAttribute("aria-valuenow", "500");
  expect(await width(page.getByTestId("host-panel"))).toBe(500);
});

test("sidebar: drag widens it, the width stays after a restart, double-click resets", async ({ page }) => {
  await openApp(page);
  const sidebar = page.getByRole("navigation", { name: "Primary" });
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(handle).toHaveAttribute("aria-valuenow", "224");
  expect(await width(sidebar)).toBe(224);

  // The edge is on the sidebar's right: dragging right widens it.
  await drag(page, handle, 60);
  await expect(handle).toHaveAttribute("aria-valuenow", "284");
  expect(await width(sidebar)).toBe(284);
  await drag(page, handle, 1000);
  await expect(handle).toHaveAttribute("aria-valuenow", "360");
  await drag(page, handle, -1000);
  await expect(handle).toHaveAttribute("aria-valuenow", "180");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "196");

  await expect.poll(() => savedWidth(page, "sidebar")).toBe(196);
  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "196");
  expect(await width(page.getByRole("navigation", { name: "Primary" }))).toBe(196);
  await page.getByRole("separator", { name: "Resize sidebar" }).dblclick();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "224");
});

test("SFTP view: the split between the panes is dragged, kept after a restart, and reset by double-click", async ({ page }) => {
  await openApp(page);
  const openSftp = async () => {
    await page.keyboard.press("Control+Shift+K");
    await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "SFTP file manager" })).toBeVisible();
  };
  await openSftp(page);
  const left = page.getByRole("region", { name: "SFTP file manager" }).getByRole("region", { name: "Left pane", exact: true });
  const handle = page.getByRole("separator", { name: "Resize file panes" });
  const half = Number(await handle.getAttribute("aria-valuenow"));
  expect(Math.abs(half - (await width(left)))).toBeLessThanOrEqual(1);

  await drag(page, handle, 100);
  await expect(handle).toHaveAttribute("aria-valuenow", String(half + 100));
  expect(await width(left)).toBe(half + 100);
  await drag(page, handle, -2000);
  await expect(handle).toHaveAttribute("aria-valuenow", "280");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "296");
  await expect.poll(() => savedWidth(page, "sftpSplit")).toBe(296);

  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await openSftp(page);
  await expect(page.getByRole("separator", { name: "Resize file panes" })).toHaveAttribute("aria-valuenow", "296");
  await page.getByRole("separator", { name: "Resize file panes" }).dblclick();
  await expect(page.getByRole("separator", { name: "Resize file panes" })).toHaveAttribute("aria-valuenow", String(half));
});

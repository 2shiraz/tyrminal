// Workspaces: tab status indicators, duplicate and reorder, against the test-only mock backend.
// UI evidence only; it never moves a feature to VERIFIED.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const drop = (page: Page) => page.evaluate(() => (window as unknown as { __mockDrop: () => void }).__mockDrop());

async function connectFromPalette(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  const input = page.getByRole("combobox", { name: /Type a command/ });
  await expect(input).toBeFocused();
  await input.fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const terminalTabs = (page: Page) => page.getByRole("tablist", { name: "Open sessions" }).locator(".tab:not(.tab-page)");

test("status: output in a background tab is marked unread until the tab is shown", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  await expect(terminalTabs(page)).toHaveCount(2);
  const local = page.getByRole("tab", { name: /Local terminal/ });
  await expect(local).toHaveAttribute("data-status", "ok");
  // Output in the tab in front is seen: no marker.
  await output(page, "visible line\r\n");
  await expect(local).not.toHaveAttribute("data-unread", /.*/);

  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await output(page, "background line\r\n");
  await expect(local).toHaveAttribute("data-unread", "true");
  await expect(local).toHaveAccessibleName(/new output/);
  // The sidebar's session list says the same.
  await expect(page.getByRole("list", { name: "Open sessions" }).getByRole("button", { name: /Local terminal.*new output/ })).toBeVisible();

  await local.click();
  await expect(local).not.toHaveAttribute("data-unread", /.*/);
  await expect(local).not.toHaveAccessibleName(/new output/);
});

test("status: a waiting prompt and a dropped connection show on the tab", async ({ page }) => {
  await openApp(page, { trustPromptFor: "db-primary" });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog", { name: /Verify this server/ })).toBeVisible();
  const db = page.getByRole("tab", { name: /db-primary/ });
  await expect(db).toHaveAttribute("data-status", "attention");
  await expect(db).toHaveAccessibleName(/needs your input/);
  await page.getByRole("button", { name: "Do not connect" }).click();

  await connectFromPalette(page, "api-gateway");
  const api = page.getByRole("tab", { name: /api-gateway/ });
  await expect(api).toHaveAttribute("data-status", "ok");
  await drop(page);
  await expect(api).toHaveAttribute("data-status", "bad");
  await expect(api).toHaveAccessibleName(/disconnected/);
});

test("status: a split tab shows its most urgent pane, not only the focused one", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  const tab = page.getByRole("tab", { name: /api-gateway/ });
  await expect(tab).toHaveAttribute("data-status", "ok");
  // The newest session is the second pane, which has focus. Move focus to the first, drop the second.
  await page.keyboard.press("Alt+ArrowLeft");
  await drop(page);
  await expect(tab).toHaveAttribute("data-status", "bad");
});

test("duplicate: copies the arrangement after the source with new sessions, within 16 panes", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane:not([hidden])")).toHaveCount(2);
  await page.keyboard.press("Control+Shift+R");
  await page.getByRole("textbox", { name: "Rename tab" }).fill("gateway pair");
  await page.keyboard.press("Enter");
  // The original tab's two sessions are open before the copy is made.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);

  await page.getByRole("tab", { name: /gateway pair/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate tab" }).click();
  // Inserted right after the source (before the local terminal), in front, same layout and name.
  await expect(terminalTabs(page)).toHaveCount(3);
  await expect(terminalTabs(page).nth(1)).toHaveText(/gateway pair/);
  await expect(terminalTabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(terminalTabs(page).nth(2)).toHaveText(/Local terminal/);
  await expect(page.locator(".pane:not([hidden])")).toHaveCount(2);
  // Each copied pane opens a session of its own; nothing typed in the original is replayed.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(4);

  // 5 panes open; grow the copy to 8 (11 open), then a second copy would need 19: refused.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(11);
  await terminalTabs(page).nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate tab" }).click();
  await expect(page.getByText(/Not enough room: a copy needs 8 more panes/)).toBeVisible();
  await expect(terminalTabs(page)).toHaveCount(3);
  await expect(page.locator(".pane")).toHaveCount(11);
});

test("reorder: tabs move by drag and drop", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  await expect(terminalTabs(page)).toHaveCount(2);
  await page.getByRole("tab", { name: /Local terminal/ }).dragTo(page.getByRole("tab", { name: /api-gateway/ }), { targetPosition: { x: 4, y: 8 } });
  await expect(terminalTabs(page).nth(0)).toHaveText(/Local terminal/);
  await expect(terminalTabs(page).nth(1)).toHaveText(/api-gateway/);
});

const visiblePanes = (page: Page) => page.locator(".pane:not([hidden])");
const paneBox = async (page: Page, label: string) => page.locator(`.pane:not([hidden])[aria-label="${label}"]`).boundingBox();

test("multi-host workspace: a split can open a different host or a local shell", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Split right with");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("combobox", { name: /Open in a new pane to the right/ });
  await expect(picker).toBeFocused();
  // Only destinations are offered while picking.
  await picker.fill("Lock");
  await expect(page.getByRole("option")).toHaveCount(0);
  await picker.fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(visiblePanes(page)).toHaveCount(2);
  await expect(page.locator('.pane[data-focused="true"]')).toHaveAttribute("aria-label", "db-primary");
  const left = await paneBox(page, "api-gateway");
  const right = await paneBox(page, "db-primary");
  expect(left!.x).toBeLessThan(right!.x);
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
  const opened = await calls(page, "session_open_ssh");
  expect(new Set(opened.map((c) => (c.args as { hostId: string }).hostId)).size).toBe(2);

  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Split down with");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: /Open in a new pane below/ }).fill("Local terminal");
  await page.keyboard.press("Enter");
  await expect(visiblePanes(page)).toHaveCount(3);
  await expect(page.locator('.pane[data-focused="true"]')).toHaveAttribute("aria-label", "Local terminal");
  await expect.poll(async () => (await calls(page, "session_open_local")).length).toBe(1);
});

test("16 panes: the limit holds, a grid arrangement tiles them evenly, sessions survive", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  for (let i = 1; i < 16; i += 1) await page.keyboard.press(i % 2 ? "Alt+Shift+Equal" : "Alt+Shift+Minus");
  await expect(page.locator(".pane")).toHaveCount(16);
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.getByText("At most 16 panes can be open. Close one first.")).toBeVisible();
  await expect(page.locator(".pane")).toHaveCount(16);
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(16);

  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Arrange panes in a grid");
  await page.keyboard.press("Enter");
  const boxes = await page.locator(".pane").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
  const xs = new Set(boxes.map((b) => Math.round(b.x)));
  const ys = new Set(boxes.map((b) => Math.round(b.y)));
  expect(xs.size).toBe(4);
  expect(ys.size).toBe(4);
  const widths = boxes.map((b) => b.w);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
  // Every pane still runs its own session: nothing was closed or reopened by rearranging.
  expect(await calls(page, "session_close")).toHaveLength(0);
  expect(await calls(page, "session_open_ssh")).toHaveLength(16);
  // Each pane's terminal is sized to its tile.
  await expect(page.locator(".pane .xterm")).toHaveCount(16);
});

test("focus layout: one pane fills the tab, the others are listed with their state", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await page.keyboard.press("Alt+Shift+Minus");
  await expect(visiblePanes(page)).toHaveCount(3);
  await page.keyboard.press("Control+Shift+Enter");
  await expect(visiblePanes(page)).toHaveCount(1);
  const list = page.getByRole("navigation", { name: "Panes in this tab" });
  const items = list.locator(".focus-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(2)).toHaveAttribute("aria-current", "true");
  // The focused pane fills the whole pane area.
  const area = await page.locator(".panes").boundingBox();
  const shown = await visiblePanes(page).boundingBox();
  expect(Math.abs(shown!.width - area!.width)).toBeLessThan(2);

  // Output in a listed (hidden) pane is marked there. The newest session is the third pane (shown),
  // so show the first and write to the third.
  await items.nth(0).click();
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await output(page, "hidden pane output\r\n");
  await expect(items.nth(2)).toHaveAccessibleName(/new output/);
  await items.nth(2).click();
  await expect(items.nth(2)).not.toHaveAccessibleName(/new output/);

  await page.keyboard.press("Control+Shift+Enter");
  await expect(visiblePanes(page)).toHaveCount(3);
  await expect(list).toHaveCount(0);
  expect(await calls(page, "session_close")).toHaveLength(0);
});

test("reorder panes: swap with a neighbour by keyboard or by dragging the header", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("Split right with");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: /Open in a new pane/ }).fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(visiblePanes(page)).toHaveCount(2);
  // db-primary (focused) is on the right; move it left.
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(async () => (await paneBox(page, "db-primary"))!.x < (await paneBox(page, "api-gateway"))!.x).toBe(true);
  await expect(page.locator('.pane[data-focused="true"]')).toHaveAttribute("aria-label", "db-primary");
  // Drag api-gateway's header grip onto db-primary: they swap back.
  await page.locator('.pane[aria-label="api-gateway"] .pane-grip').dragTo(page.locator('.pane[aria-label="db-primary"] .terminal-host'));
  await expect.poll(async () => (await paneBox(page, "api-gateway"))!.x < (await paneBox(page, "db-primary"))!.x).toBe(true);
  expect(await calls(page, "session_close")).toHaveLength(0);
});

test("move a pane to its own tab: the session keeps running", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(visiblePanes(page)).toHaveCount(2);
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(2);
  await expect(page.locator(".pane:not([hidden])").nth(1).locator(".xterm-rows")).toContainText("deploy@api-gateway");
  await page.keyboard.type("echo moved");
  await expect(page.locator('.pane[data-focused="true"] .xterm-rows')).toContainText("echo moved");
  await page.locator('.pane[data-focused="true"]').getByRole("button", { name: "Move pane to a new tab" }).click();
  await expect(terminalTabs(page)).toHaveCount(2);
  await expect(terminalTabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(visiblePanes(page)).toHaveCount(1);
  // Same session: the typed line is still on its screen, and nothing was reopened or closed.
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText("echo moved");
  expect(await calls(page, "session_open_ssh")).toHaveLength(2);
  expect(await calls(page, "session_close")).toHaveLength(0);
  await terminalTabs(page).nth(0).click();
  await expect(visiblePanes(page)).toHaveCount(1);
});

async function paletteRun(page: Page, text: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(text);
  await expect(page.getByRole("option").first()).toContainText(text);
  await page.keyboard.press("Enter");
}

async function twoHostTab(page: Page) {
  await connectFromPalette(page, "api-gateway");
  await paletteRun(page, "Split right with");
  await page.getByRole("combobox", { name: /Open in a new pane/ }).fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(visiblePanes(page)).toHaveCount(2);
  await page.keyboard.press("Control+Shift+R");
  await page.getByRole("textbox", { name: "Rename tab" }).fill("prod");
  await page.keyboard.press("Enter");
}

test("templates: explicit save stores the arrangement and destinations only; changes show as unsaved", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await twoHostTab(page);
  await page.locator(".pane:not([hidden])").first().click();
  await page.keyboard.type("echo TYPED-CANARY");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane:not([hidden])").first().locator(".xterm-rows")).toContainText("TYPED-CANARY: synthetic output");
  // Nothing is saved by itself.
  expect(await calls(page, "layout_save")).toHaveLength(0);
  await expect(page.locator(".tab-layout")).toHaveCount(0);

  await paletteRun(page, "Save layout as");
  const dialog = page.getByRole("dialog", { name: "Save the open tabs as a layout" });
  await expect(dialog).toContainText("1 tab, 2 panes");
  await dialog.getByLabel("Layout name").fill("Ops");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved layout “Ops”.")).toBeVisible();
  const indicator = page.getByRole("button", { name: /^Layout: Ops$/ });
  await expect(indicator).toBeVisible();

  const [first] = await calls(page, "layout_save");
  const sent = JSON.stringify(first!.args);
  expect(sent).not.toContain("TYPED-CANARY");
  expect(sent).not.toMatch(/synthetic output|deploy@/);
  expect((first!.args as { layout: { tabs: unknown[] } }).layout.tabs).toEqual([
    {
      title: "prod",
      panes: [
        { kind: "ssh", hostId: expect.any(String) },
        { kind: "ssh", hostId: expect.any(String) },
      ],
      layout: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", pane: 0 }, b: { kind: "leaf", pane: 1 } },
      focused: 0,
      focusMode: false,
    },
  ]);

  // Resizing changes the arrangement: shown as unsaved until saved again, into the same template.
  const splitter = page.getByRole("separator").first();
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Layout: Ops (Unsaved changes)" })).toBeVisible();
  await page.getByRole("button", { name: /Layout: Ops/ }).click();
  await page.getByRole("menuitem", { name: "Save layout “Ops”" }).click();
  await expect(page.getByRole("button", { name: /^Layout: Ops$/ })).toBeVisible();
  const saves = await calls(page, "layout_save");
  expect(saves).toHaveLength(2);
  expect((saves[1]!.args as { layout: { id: string } }).layout.id).toBe((await page.evaluate(() => (window as unknown as { __mockState: { layouts: { id: string }[] } }).__mockState.layouts[0]!.id)));
});

test("templates: restore opens every pane disconnected; only Connect opens a session", async ({ page }) => {
  await openApp(page);
  await twoHostTab(page);
  await paletteRun(page, "Save layout as");
  await page.getByRole("dialog").getByLabel("Layout name").fill("Ops");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /^Layout: Ops$/ })).toBeVisible();
  await page.getByRole("button", { name: "Close prod" }).click();
  await expect(terminalTabs(page)).toHaveCount(0);
  await expect.poll(async () => (await calls(page, "session_close")).length).toBe(2);
  const opened = (await calls(page, "session_open_ssh")).length;

  await paletteRun(page, "Open layout “Ops”");
  await expect(terminalTabs(page)).toHaveCount(1);
  await expect(terminalTabs(page).first()).toHaveText(/prod/);
  await expect(visiblePanes(page)).toHaveCount(2);
  const waiting = page.getByRole("group", { name: /not connected$/ });
  await expect(waiting).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Layout: Ops$/ })).toBeVisible();
  // Nothing connected on its own, even after a while.
  await page.waitForTimeout(300);
  expect(await calls(page, "session_open_ssh")).toHaveLength(opened);
  // Broadcast is not offered while panes are not connected.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("every pane");
  await expect(page.getByRole("option", { name: /Type into every pane/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator('.pane[aria-label="db-primary"]').getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(opened + 1);
  await expect(waiting).toHaveCount(1);
  // With one pane left waiting, "Connect all" is no longer offered; Connect is.
  await expect(page.getByRole("button", { name: "Connect all in this tab" })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(opened + 2);
  await expect(waiting).toHaveCount(0);
});

test("templates: Connect all, and a restore that would pass 16 panes is refused", async ({ page }) => {
  await openApp(page);
  await twoHostTab(page);
  await paletteRun(page, "Save layout as");
  await page.getByRole("dialog").getByLabel("Layout name").fill("Pair");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /^Layout: Pair$/ })).toBeVisible();
  const opened = (await calls(page, "session_open_ssh")).length;
  await paletteRun(page, "Open layout “Pair”");
  await expect(terminalTabs(page)).toHaveCount(2);
  // Two tabs open now, so the workspace differs from the template.
  await expect(page.getByRole("button", { name: "Layout: Pair (Unsaved changes)" })).toBeVisible();
  await page.getByRole("button", { name: "Connect all in this tab" }).first().click();
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(opened + 2);

  for (let i = 0; i < 12; i += 1) await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(16);
  await page.keyboard.press("Control+Shift+W");
  await expect(page.locator(".pane")).toHaveCount(15);
  await paletteRun(page, "Open layout “Pair”");
  await expect(page.getByText("Not enough room: this layout has 2 panes and at most 16 can be open.")).toBeVisible();
  await expect(page.locator(".pane")).toHaveCount(15);
});

test("broadcast target review: the exact receiving panes are listed and confirmed first", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await paletteRun(page, "Split right with");
  await page.getByRole("combobox", { name: /Open in a new pane/ }).fill("db-primary");
  await page.keyboard.press("Enter");
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(2);

  await paletteRun(page, "Type into every pane");
  const review = page.getByRole("alertdialog", { name: "Type into these 2 panes?" });
  const list = review.getByRole("list", { name: "Panes that will receive typed input" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("api-gateway");
  await expect(list).toContainText("db-primary");
  await expect(list).toContainText("deploy@");
  // The safe choice has focus; Escape cancels and nothing is enabled.
  await expect(review.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId("broadcast")).toHaveCount(0);
  await expect(page.locator(".pane[data-broadcast]")).toHaveCount(0);

  await paletteRun(page, "Type into every pane");
  await review.getByRole("button", { name: "Type into 2 panes" }).click();
  await expect(page.getByTestId("broadcast")).toHaveText("Typing into 2 panes");
  await expect(page.locator(".pane[data-broadcast]")).toHaveCount(2);
});

test("broadcast target review: a pane that changes during the review blocks the start", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator('.pane .status-dot[data-tone="ok"]')).toHaveCount(2);
  await paletteRun(page, "Type into every pane");
  const review = page.getByRole("alertdialog", { name: "Type into these 2 panes?" });
  await expect(review).toBeVisible();
  // The newest session drops while the list is on screen.
  await drop(page);
  await expect(page.locator('.pane .status-dot[data-tone="bad"]')).toHaveCount(1);
  await review.getByRole("button", { name: "Type into 2 panes" }).click();
  await expect(page.getByText("The panes changed while you were reviewing them. Review the list again.")).toBeVisible();
  await expect(page.getByTestId("broadcast")).toHaveCount(0);
  await expect(page.locator(".pane[data-broadcast]")).toHaveCount(0);
});

async function openSettings(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Shortcuts and input" })).toBeVisible();
}

test("keyboard customization: rebinding, terminal keys refused, conflicts refused, reset", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const list = page.getByRole("list", { name: "Application shortcuts" });
  const row = (action: string) => list.locator(`li[data-action="${action}"]`);

  // Ctrl with a single key belongs to the terminal.
  await page.getByRole("button", { name: "Change shortcut for Command palette" }).click();
  await expect(row("palette")).toContainText("Press the new shortcut");
  await page.keyboard.press("Control+KeyC");
  await expect(row("palette").getByRole("alert")).toHaveText(/belongs to the terminal/);
  // A plain key is refused too.
  await page.keyboard.press("KeyP");
  await expect(row("palette").getByRole("alert")).toHaveText(/belongs to the terminal/);
  // A shortcut another action uses is refused.
  await page.keyboard.press("Control+Shift+KeyF");
  await expect(row("palette").getByRole("alert")).toHaveText("That shortcut is already used for Find in terminal.");
  // While recording, shortcuts do not run (Ctrl+Shift+K did not open the palette).
  await expect(page.getByRole("dialog", { name: /Command palette|Type a command/ })).toHaveCount(0);
  await page.keyboard.press("Alt+KeyP");
  await expect(row("palette")).toContainText("Alt");
  await expect(row("palette")).toContainText("P");
  // Stored with the preferences (validated again natively).
  await expect
    .poll(async () => JSON.stringify((await calls(page, "prefs_set")).at(-1)?.args ?? null))
    .toContain('"action":"palette","key":"p","ctrl":false,"alt":true,"shift":false,"meta":false');

  // The new shortcut works, the old one no longer does.
  await page.keyboard.press("Alt+KeyP");
  await expect(page.getByRole("combobox", { name: /Type a command/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+KeyK");
  await expect(page.getByRole("combobox", { name: /Type a command/ })).toHaveCount(0);

  // Removing a shortcut leaves the action without one; reset restores the default.
  await page.getByRole("button", { name: "Remove shortcut for Rename tab" }).click();
  await expect(row("renameTab")).toContainText("No shortcut");
  await page.getByRole("button", { name: "Reset all shortcuts" }).click();
  await expect(row("palette")).toContainText("Ctrl");
  await page.keyboard.press("Control+Shift+KeyK");
  await expect(page.getByRole("combobox", { name: /Type a command/ })).toBeFocused();
});

test("highlighting: words and IP addresses are colored on screen; the text and input are unchanged", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSettings(page);
  await page.getByRole("switch", { name: "Highlight output" }).or(page.getByLabel("Highlight output")).first().check();
  await page.getByLabel("Word to highlight").fill("error");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".highlight-words")).toContainText("error");

  await connectFromPalette(page, "api-gateway");
  const writesBefore = (await calls(page, "session_write")).length;
  const line = "build ERROR at 10.0.0.12 from fe80::1 at 12:30:45, mac aa:bb:cc:dd:ee:ff, errors=0";
  await output(page, `\r\n${line}\r\n`);
  const marks = page.locator(".term-highlight");
  await expect(marks).toHaveCount(3);
  await expect(page.locator('.term-highlight[data-tone="danger"]')).toHaveCount(1);
  await expect(page.locator('.term-highlight[data-tone="info"]')).toHaveCount(2);
  // The screen text is exactly what arrived, and highlighting sent nothing.
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText(line);
  expect(await calls(page, "session_write")).toHaveLength(writesBefore);

  // Turned off: the decorations go away.
  await openSettings(page);
  await page.getByLabel("Highlight output").first().uncheck();
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await expect(marks).toHaveCount(0);
});

test("character encoding: a legacy encoding decodes output and encodes input; what it cannot write is not sent", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  const rows = page.locator(".pane:not([hidden]) .xterm-rows");
  const bytes = (b: number[]) => page.evaluate((x) => (window as unknown as { __mockOutputBytes: (b: number[]) => void }).__mockOutputBytes(x), b);
  // UTF-8 (the default): a lone Latin-1 byte is not valid UTF-8 and xterm drops it.
  await bytes([0x0d, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x31, 0x0d, 0x0a]);
  await expect(rows).toContainText("caf1");

  await paletteRun(page, "Change character encoding");
  const dialog = page.getByRole("dialog", { name: "Character encoding for this session" });
  await dialog.getByLabel("Encoding").selectOption("windows-1252");
  await dialog.getByRole("button", { name: "Use this encoding" }).click();
  await expect(page.locator(".term-encoding")).toHaveText("Western (Windows-1252 / ISO-8859-1)");
  await bytes([0x63, 0x61, 0x66, 0xe9, 0x32, 0x0d, 0x0a]);
  await expect(rows).toContainText("café2");

  // Typed text is encoded as Windows-1252: the mock decodes input as UTF-8, so the single byte 0xE9
  // comes back as U+FFFD, which (UTF-8 EF BF BD) reads as "ï¿½" in Windows-1252.
  await expect(page.locator('.pane[data-focused="true"] .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type("xé");
  await expect(rows).toContainText("xï¿½");
  // A character Windows-1252 does not have is not sent, and the user is told.
  const before = (await calls(page, "session_write")).length;
  await page.keyboard.type("日");
  await expect(page.getByText("Not sent: 日 cannot be written in Western (Windows-1252 / ISO-8859-1).")).toBeVisible();
  expect(await calls(page, "session_write")).toHaveLength(before);
});

// Actions on addresses and paths in terminal output: hover underlines, a click opens a menu
// (copy; for addresses, a prefilled new host that never connects by itself). Mock backend.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";
import { pointOf } from "./highlight-helpers";
import { privateClipboard } from "./input-helpers";

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (t: string) => void }).__mockOutput(t), text);
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string }[] }).__mockCalls.filter((x) => x.cmd === c).length, cmd);

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

async function click(page: Page, row: string, token: string) {
  await expect.poll(() => pointOf(page, row, token)).not.toBeNull();
  const p = (await pointOf(page, row, token)) as { x: number; y: number };
  // Hover first (from elsewhere), as a pointer does: the terminal detects the token on movement.
  await page.mouse.move(p.x, p.y - 40);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.click(p.x, p.y);
}

test("an address opens a menu: copy it, or start a new host for it without connecting", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await connect(page);
  await output(page, "\r\nbackend at 10.0.0.12:2222 is up\r\n");
  await click(page, "backend at", "10.0.0.12:2222");
  const menu = page.getByRole("menu", { name: "Actions for 10.0.0.12:2222" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy" }).click();
  await expect(page.getByText("Copied 10.0.0.12:2222")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("10.0.0.12:2222");

  const opened = await calls(page, "session_open_ssh");
  await click(page, "backend at", "10.0.0.12:2222");
  await page.getByRole("menuitem", { name: "New host for 10.0.0.12…" }).click();
  const editor = page.getByRole("dialog", { name: "Add host" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Address")).toHaveValue("10.0.0.12");
  await expect(editor.getByLabel("Port")).toHaveValue("2222");
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveCount(0);
  expect(await calls(page, "session_open_ssh")).toBe(opened);
});

test("IPv6 in brackets keeps its port; a MAC address can only be copied", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await connect(page);
  await output(page, "\r\nnode [fe80::1]:2200 mac aa:bb:cc:00:11:22\r\n");
  await click(page, "node [fe80", "[fe80::1]:2200");
  await page.getByRole("menuitem", { name: "New host for fe80::1…" }).click();
  const editor = page.getByRole("dialog", { name: "Add host" });
  await expect(editor.getByLabel("Address")).toHaveValue("fe80::1");
  await expect(editor.getByLabel("Port")).toHaveValue("2200");
  await editor.getByRole("button", { name: "Cancel" }).click();

  await click(page, "node [fe80", "aa:bb:cc:00:11:22");
  const menu = page.getByRole("menu", { name: "Actions for aa:bb:cc:00:11:22" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Copy"]);
  await page.keyboard.press("Escape");
});

test("paths are actions in local terminals only; links keep their confirmation", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await privateClipboard(page);
  await connect(page);
  await output(page, "\r\nremote file /etc/hosts and https://example.com/a\r\n");
  // In an SSH session a path is the server's, not this computer's: no action.
  await click(page, "remote file", "/etc/hosts");
  await page.waitForTimeout(150);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // A link opens the existing confirmation, not the token menu.
  await click(page, "remote file", "https://example.com/a");
  await expect(page.getByRole("dialog", { name: /Open this link/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
  await output(page, "\r\nlocal file ~/src/tyrminal/README.md\r\n");
  await click(page, "local file", "~/src/tyrminal/README.md");
  await page.getByRole("menu", { name: "Actions for ~/src/tyrminal/README.md" }).getByRole("menuitem", { name: "Copy path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("~/src/tyrminal/README.md");
});

test("no token actions in full-screen applications; dragging still selects", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await output(page, "\r\nselect 10.0.0.77 here\r\n");
  // A drag across the address selects instead of opening the menu.
  const a = (await pointOf(page, "select 10.0.0.77", "select")) as { x: number; y: number };
  const b = (await pointOf(page, "select 10.0.0.77", "here")) as { x: number; y: number };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("menu")).toHaveCount(0);

  await output(page, "\u001b[?1049h\u001b[H\u001b[2JFULL 10.0.0.88\r\n");
  await click(page, "FULL 10.0.0.88", "10.0.0.88");
  await page.waitForTimeout(150);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

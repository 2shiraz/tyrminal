// Built-in output highlighting (TRM-07): on by default, plain output only, never on the
// alternate screen, each kind can be turned off. Mock backend; never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp, openSettings } from "./fixtures";
import { marksOnRow } from "./highlight-helpers";
import { inputs, sentSince } from "./input-helpers";
import { MOTD_ADDRESSES, MOTD_LINES } from "./motd-fixture";

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (t: string) => void }).__mockOutput(t), text);

async function settings(page: Page) {
  await openSettings(page, "Highlighting");
  await expect(page.getByRole("heading", { name: "Highlighting" })).toBeVisible();
}

test("on by default: addresses, numbers, links, dates, quotes, paths, hashes and status words in plain output", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  const before = await inputs(page);
  const lines = [
    "2026-10-12 14:03:22 info GET /api/v1/hosts from 10.0.0.12 took 12ms: ok",
    "warn disk /dev/sda1 is 91% full (3.4GiB left); see https://example.com/runbook",
    "error deploy a1f3c2e failed: \"permission denied\" on aa:bb:cc:00:11:22 via fe80::1",
  ];
  await output(page, `\r\n${lines.join("\r\n")}\r\n`);

  await expect.poll(() => marksOnRow(page, "took 12ms")).toEqual([
    ["date", "2026-10-12 14:03:22"],
    ["dim", "info"],
    ["path", "/api/v1/hosts"],
    ["address", "10.0.0.12"],
    ["number", "12ms"],
    ["success", "ok"],
  ]);
  await expect.poll(() => marksOnRow(page, "is 91% full")).toEqual([
    ["warning", "warn"],
    ["path", "/dev/sda1"],
    ["number", "91%"],
    ["number", "3.4GiB"],
    ["url", "https://example.com/runbook"],
  ]);
  await expect.poll(() => marksOnRow(page, "deploy a1f3c2e")).toEqual([
    ["danger", "error"],
    ["hex", "a1f3c2e"],
    ["danger", "failed"],
    ["string", '"permission denied"'],
    ["address", "aa:bb:cc:00:11:22"],
    ["address", "fe80::1"],
  ]);
  // Display only: the text on screen is what arrived, and nothing was sent.
  for (const line of lines) await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText(line);
  expect((await sentSince(page, before)).join("").replace(/\u001b\[[\d;]*R/g, "")).toBe("");
});

test("an Ubuntu login message: every IPv4 and IPv6 address is highlighted and the links are links", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  const before = await inputs(page);
  const found: string[] = [];
  const links: string[] = [];
  // Half a message per screen, so every line is in view (only visible rows are highlighted).
  const half = Math.ceil(MOTD_LINES.length / 2);
  for (const part of [MOTD_LINES.slice(0, half), MOTD_LINES.slice(half)]) {
    await output(page, `\u001b[2J\u001b[H${part.join("\r\n")}\r\n`);
    const shown = part.filter((l) => l.trim() !== "");
    // Each half ends in an address; the whole screen is decorated in one pass.
    await expect.poll(async () => ((await marksOnRow(page, (shown.at(-1) as string).trim())) ?? []).some(([kind]) => kind === "address")).toBe(true);
    for (const line of shown) {
      // Display only: the text on screen is what arrived.
      await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText(line.trim());
      const marks = (await marksOnRow(page, line.trim())) ?? [];
      found.push(...marks.filter(([kind]) => kind === "address").map(([, text]) => text));
      links.push(...marks.filter(([kind]) => kind === "url").map(([, text]) => text));
    }
  }
  expect(found).toEqual(MOTD_ADDRESSES);
  expect(links).toEqual(["https://help.ubuntu.com", "https://landscape.example.com"]);
  // Links are underlined.
  await output(page, `\u001b[2J\u001b[H${MOTD_LINES.slice(0, 4).join("\r\n")}\r\n`);
  await expect(page.locator('.pane:not([hidden]) .term-highlight[data-tone="url"]').first()).toHaveCSS("box-shadow", /inset/);
  // Nothing was sent.
  expect((await sentSince(page, before)).join("").replace(/\u001b\[[\d;]*R/g, "")).toBe("");
});

test("text the program colored is left alone; plain text beside it is still highlighted", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await output(page, "\r\n\u001b[32mgreen 10.0.0.1 error 42\u001b[0m plain 10.0.0.2\r\n\u001b[1;31mbold red 10.0.0.3\u001b[0m\r\n\u001b[7mreverse 10.0.0.4\u001b[0m\r\n");
  await expect.poll(() => marksOnRow(page, "green 10.0.0.1")).toEqual([["address", "10.0.0.2"]]);
  await expect.poll(() => marksOnRow(page, "bold red")).toEqual([]);
  await expect.poll(() => marksOnRow(page, "reverse 10.0.0.4")).toEqual([]);
});

test("full-screen applications (alternate screen) are never highlighted", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page);
  await output(page, "\r\nbefore 10.0.0.9\r\n");
  await expect.poll(() => marksOnRow(page, "before 10.0.0.9")).toEqual([["address", "10.0.0.9"]]);
  // Enter the alternate screen and draw plain text there.
  await output(page, "\u001b[?1049h\u001b[H\u001b[2JTOP 10.0.0.7 error 99%\r\n");
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText("TOP 10.0.0.7");
  await page.waitForTimeout(200);
  await expect(page.locator(".pane:not([hidden]) .term-highlight")).toHaveCount(0);
  // Back on the normal screen, highlighting returns.
  await output(page, "\u001b[?1049l");
  await expect.poll(() => marksOnRow(page, "before 10.0.0.9")).toEqual([["address", "10.0.0.9"]]);
});

test("each kind can be turned off, and the whole feature too", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await settings(page);
  // The preview uses the same matching as the terminal.
  const preview = page.getByRole("figure", { name: "Preview with the current color scheme" });
  await expect(preview.locator('[data-tone="address"]').first()).toHaveText("10.0.0.12");
  await page.getByLabel("Numbers and sizes").uncheck();
  await expect(preview.locator('[data-tone="number"]')).toHaveCount(0);

  await connect(page);
  await output(page, "\r\nhost 10.0.0.5 has 42 cores and is ok\r\n");
  await expect.poll(() => marksOnRow(page, "has 42 cores")).toEqual([
    ["address", "10.0.0.5"],
    ["success", "ok"],
  ]);

  await settings(page);
  await page.getByLabel("Highlight output").first().uncheck();
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await expect.poll(() => marksOnRow(page, "has 42 cores")).toEqual([]);
  // Saved natively as off (with the kinds kept as chosen).
  const saved = () => page.evaluate(() => (window as unknown as { __mockState: { prefs: { workspace?: { highlight: { enabled: boolean; numbers: boolean } } } } }).__mockState.prefs.workspace?.highlight);
  await expect.poll(saved).toMatchObject({ enabled: false, numbers: false });
});

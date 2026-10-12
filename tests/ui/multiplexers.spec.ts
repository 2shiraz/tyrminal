// tmux and screen session awareness (P-31) against the UI test mock. Listing, parsing and name
// validation are tested in Rust (crates/core/src/multiplexers.rs) and against the lab server
// (crates/core/tests/sessions_lab.rs). Here: sessions are listed when the panel opens, names are
// plain text, attach is offered only where the core built a command and is typed only on a
// click, and after a reconnect the session is offered again, never reattached by itself.

import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const input = (page: Page) =>
  page.evaluate(() => Object.values((window as unknown as { __mockInputBySession?: Record<string, string> }).__mockInputBySession ?? {}).join(""));
const listCalls = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __mockMultiplexerCalls?: string[] }).__mockMultiplexerCalls ?? []).length);

async function connected(page: Page, host = "api-gateway", prompt = "deploy@api-gateway") {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: `Connect to ${host}` }).click();
  await waitForTerminalText(page, prompt);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Server" });
const section = (page: Page) => panel(page).getByTestId("multiplexers");

test("sessions are listed when the panel opens; server names are plain text and attach needs a click", async ({ page }) => {
  await connected(page);
  expect(await listCalls(page)).toBe(0);
  await page.locator('.statusbar [data-panel="server"]').click();
  const list = section(page).getByRole("list", { name: "tmux and screen" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  expect(await listCalls(page)).toBe(1);

  const names = await list.getByTestId("mux-name").allTextContents();
  expect(names).toEqual(["work", "<img src=x onerror=alert(1)>; rm -rf ~", "4242.build"]);
  // The hostile name is text, not markup, and has no Attach button.
  await expect(section(page).locator("img")).toHaveCount(0);
  const hostile = list.getByRole("listitem").nth(1);
  await expect(hostile.getByRole("button")).toHaveCount(0);
  await expect(hostile).toContainText("Attach to it yourself");
  await expect(list.getByRole("listitem").nth(0)).toContainText("tmux · 3 windows");
  await expect(hostile).toContainText("attached");

  // Listing typed nothing; attaching types the core's command once, with Enter.
  const before = await input(page);
  expect(before).not.toContain("tmux");
  await list.getByRole("button", { name: "Attach to tmux session work" }).click();
  await expect.poll(async () => (await input(page)).slice(before.length)).toBe("tmux attach-session -t '=work'\r");
  await list.getByRole("button", { name: "Attach to screen session 4242.build" }).click();
  await expect.poll(async () => (await input(page)).endsWith("screen -r '4242.build'\r")).toBe(true);

  // Refresh lists again; nothing is read on a timer.
  await page.waitForTimeout(1_500);
  expect(await listCalls(page)).toBe(1);
  await section(page).getByRole("button", { name: "Refresh sessions" }).click();
  await expect.poll(() => listCalls(page)).toBe(2);
});

test("not installed, nothing running and an unreadable answer are each said plainly", async ({ page }) => {
  await connected(page);
  const set = (value: unknown) => page.evaluate((v) => ((window as unknown as { __mockMultiplexers: unknown }).__mockMultiplexers = v), value);
  await set({ state: "listed", tmuxInstalled: false, screenInstalled: false, sessions: [], truncated: false });
  await page.locator('.statusbar [data-panel="server"]').click();
  await expect(section(page)).toContainText("Neither tmux nor screen is installed on this server.");

  await set({ state: "listed", tmuxInstalled: true, screenInstalled: false, sessions: [], truncated: false });
  await section(page).getByRole("button", { name: "Refresh sessions" }).click();
  await expect(section(page)).toContainText("No tmux or screen sessions are running.");

  await set({ state: "not_available", reason: "malformed" });
  await section(page).getByRole("button", { name: "Refresh sessions" }).click();
  await expect(section(page)).toContainText("The server's answer could not be read.");
});

test("after a reconnect the attached session is offered again, and only a click reattaches", async ({ page }) => {
  await connected(page);
  await page.locator('.statusbar [data-panel="server"]').click();
  await section(page).getByRole("button", { name: "Attach to tmux session work" }).click();
  await expect.poll(async () => (await input(page)).includes("tmux attach-session -t '=work'\r")).toBe(true);
  // No offer while the first connection is up.
  await expect(page.getByRole("group", { name: "Reattach after reconnecting" })).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { __mockDrop: () => void }).__mockDrop());
  await expect(page.getByTestId("auto-reconnect")).toBeVisible();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/, { timeout: 5_000 });

  const offer = page.getByRole("group", { name: "Reattach after reconnecting" });
  await expect(offer).toContainText("Before the connection dropped you were in tmux session work.");
  await expect(offer.getByTestId("reattach-command")).toHaveText("tmux attach-session -t '=work'");
  // Offered, not typed: the new session has received nothing yet.
  await page.waitForTimeout(300);
  const typed = async () => (await input(page)).split("tmux attach-session -t '=work'\r").length - 1;
  expect(await typed()).toBe(1);
  await offer.getByRole("button", { name: "Reattach" }).click();
  await expect(offer).toHaveCount(0);
  await expect.poll(typed).toBe(2);
});

test("dismissing the offer types nothing, and it is not shown again for that reconnect", async ({ page }) => {
  await connected(page);
  await page.locator('.statusbar [data-panel="server"]').click();
  await section(page).getByRole("button", { name: "Attach to tmux session work" }).click();
  await page.evaluate(() => (window as unknown as { __mockDrop: () => void }).__mockDrop());
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/, { timeout: 5_000 });
  const offer = page.getByRole("group", { name: "Reattach after reconnecting" });
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(offer).toHaveCount(0);
  expect((await input(page)).split("tmux attach-session").length - 1).toBe(1);
});

// The connection track in the connection sheet (features/terminal/ConnectTrack.tsx) against the
// mock backend: each stop lights only when its step's event arrives, a prompt holds the travel at
// its stop, a failure marks the stop it happened at, the settle on success never holds back the
// shell, and reduced motion keeps every state with nothing running. Functional checks only: the
// visual baselines are recorded under reduced motion and do not change.
import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";
import { connectHeld, emitSessionEvent } from "./session-events";

const hosts = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
const track = (page: Page) => page.getByTestId("connect-track");
const stops = (page: Page) => track(page).locator(".track-stop").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-stage")}:${e.getAttribute("data-state")}`));
const running = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector(".connect-track");
    return el ? el.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length : -1;
  });

test("the stops light in the order the session reports its steps, never ahead of them", async ({ page }) => {
  await openApp(page);
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "api-gateway"));
  // Nothing reported yet: the first stop is current and nothing is done.
  await expect.poll(() => stops(page)).toEqual(["resolve:now", "connect:pending", "verify:pending", "auth:pending", "shell:pending"]);
  await page.clock.runFor(12); // connecting
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:now", "verify:pending", "auth:pending", "shell:pending"]);
  await page.clock.runFor(15); // verifying_host
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:now", "auth:pending", "shell:pending"]);
  await page.clock.runFor(15); // authenticating
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:done", "auth:now", "shell:pending"]);
  // Late key-exchange details (sent once connected) do not move the track back.
  await emitSessionEvent(page, { type: "negotiated", kex: "mlkem768x25519-sha256", hostKey: "ssh-ed25519", cipher: "chacha20-poly1305@openssh.com", mac: "", strictKex: true });
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:done", "auth:now", "shell:pending"]);
  // The host tile names the destination and offers the log; Cancel stays the way out.
  const sheet = page.getByRole("dialog", { name: "Connecting to api-gateway" });
  await expect(sheet.locator(".connect-head")).toContainText("SSH deploy@");
  await expect(sheet.locator(".connect-head").getByRole("button", { name: /connection log/i })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.clock.resume();
});

test("a prompt holds the travel at its stop", async ({ page }) => {
  await openApp(page, { trustPromptFor: "staging-web" });
  await hosts(page);
  await connectHost(page, "staging-web");
  await expect(page.getByRole("alertdialog", { name: "Verify this server before connecting" })).toBeVisible();
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:waiting", "auth:pending", "shell:pending"]);
  await expect(track(page)).toHaveAttribute("data-state", "waiting");
  await expect(track(page).locator(".track-travel")).toHaveCount(0);
});

test("a failure marks the stop it happened at, and Close tab closes the tab", async ({ page }) => {
  await openApp(page);
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "edge-cache"));
  await page.clock.runFor(42); // authenticating
  await emitSessionEvent(page, { type: "state", state: "failed" });
  await emitSessionEvent(page, { type: "closed", error: { code: "AUTH_FAILED", message: "The server did not accept the password for ops." }, exitStatus: null });
  await expect(page.getByRole("alert").filter({ hasText: "The server did not accept the sign-in" })).toBeVisible();
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:done", "auth:fail", "shell:pending"]);
  await expect(track(page).locator(".track-failseg")).toHaveCount(1);
  await page.clock.resume();
  await page.getByRole("button", { name: "Close tab" }).click();
  await expect(track(page)).toHaveCount(0);
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
});

test("a changed host key marks the identity stop", async ({ page }) => {
  await openApp(page, { hostKeyChangedFor: "staging-web" });
  await hosts(page);
  await connectHost(page, "staging-web");
  await expect(page.getByRole("alert").filter({ hasText: "This server's identity has changed" })).toBeVisible();
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:fail", "auth:pending", "shell:pending"]);
});

test("reduced motion: every state is shown and nothing on the track runs", async ({ page }) => {
  // The fixtures emulate reduced motion, as the visual baselines do.
  await openApp(page);
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "api-gateway"));
  await page.clock.runFor(27); // verifying_host
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:now", "auth:pending", "shell:pending"]);
  expect(await running(page)).toBe(0);
  await expect(track(page).locator(".track-travel")).toBeHidden();
  await page.clock.resume();
});

test("with motion: the track moves while connecting, then settles over a shell that already takes input", async ({ page }) => {
  await openApp(page);
  // Motion allowed: the OS setting and the in-app switch (the mock's preferences turn it on).
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = "false";
  });
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "api-gateway"));
  await page.clock.runFor(27); // verifying_host
  expect(await running(page)).toBeGreaterThan(0);
  const layer = page.locator(".connect-layer");
  // opening_channel, then connected: advance in small steps until the sheet starts to settle.
  for (let i = 0; i < 40 && (await layer.getAttribute("data-leaving")) !== "true"; i += 1) await page.clock.runFor(5);
  await expect(layer).toHaveAttribute("data-leaving", "true");
  await expect(layer).toHaveAttribute("inert", "");
  await expect.poll(() => stops(page)).toEqual(["resolve:done", "connect:done", "verify:done", "auth:done", "shell:done"]);
  // The sheet is out of the way at once: no dialog for assistive technology, and typing reaches the shell.
  await expect(page.getByRole("dialog", { name: /Connecting to|Connected/ })).toHaveCount(0);
  await page.locator(".terminal-pane:not([hidden]) .xterm-helper-textarea").focus();
  await page.keyboard.type("echo live");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockReceived?: string }).__mockReceived ?? "")).toContain("echo live");
  await page.clock.runFor(400);
  await expect(layer).toHaveCount(0);
  await page.clock.resume();
});

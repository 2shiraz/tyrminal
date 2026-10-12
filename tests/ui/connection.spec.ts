// The connection sheet (features/terminal/ConnectionSheet.tsx) against the mock backend: real
// steps only, prompts inline in the pane, Cancel always available, and outcomes named by cause.
// The real connection paths are covered by the native and lab tests.
import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";
import { calls, connectHeld, emitSessionEvent } from "./session-events";

const hosts = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
const steps = (page: Page) => page.getByRole("list", { name: "Connection steps" });

test("connecting shows the steps that happened, the current one, and Cancel stops it", async ({ page }) => {
  await openApp(page);
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "api-gateway"));
  await page.clock.runFor(12); // connecting
  await page.clock.runFor(15); // verifying_host
  const sheet = page.getByRole("dialog", { name: "Connecting to api-gateway" });
  await expect(sheet).toBeVisible();
  await expect(steps(page).getByRole("listitem")).toHaveText([/Connected/, /Checking server identity/, /Signing in/, /Opening the shell/]);
  await expect(steps(page).locator('[aria-current="step"]')).toHaveText(/Checking server identity/);
  // No progress bar or spinner: the pending steps are just listed.
  await expect(sheet.locator(".spinner, progress")).toHaveCount(0);

  await sheet.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "session_close")).toHaveLength(1);
  await expect(page.getByRole("status").filter({ hasText: "Connection cancelled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeFocused();
  await page.clock.resume();
});

test("a new server: the fingerprint has focus, Enter trusts nothing, Escape answers no", async ({ page }) => {
  await openApp(page, { trustPromptFor: "staging-web" });
  await hosts(page);
  await connectHost(page, "staging-web");
  const sheet = page.getByRole("alertdialog", { name: "Verify this server before connecting" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("connect-fingerprint")).toBeFocused();
  await expect(sheet.getByTestId("connect-fingerprint")).toHaveAttribute("aria-label", "SHA256:k3J9vT0yQ2uX5rB8nM1cP4sD7fG0hL3wZ6qE9tY2iA8");
  await expect(steps(page).locator('[aria-current="step"]')).toHaveText(/Checking server identity.*new server/);
  await page.keyboard.press("Enter");
  expect(await calls(page, "session_trust_answer")).toHaveLength(0);
  await page.keyboard.press("Escape");
  expect(await calls(page, "session_trust_answer")).toEqual([{ cmd: "session_trust_answer", args: expect.objectContaining({ decision: "cancel" }) }]);
});

test("sign-in prompts appear inline under Signing in, and the answer goes to the session", async ({ page }) => {
  await openApp(page);
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "api-gateway"));
  await page.clock.runFor(42); // authenticating
  await emitSessionEvent(page, { type: "auth_prompt", promptId: "p2", kind: "password", username: "deploy", attempt: 2, maxAttempts: 3, message: null, echo: false, hop: null });
  const sheet = page.getByRole("dialog", { name: "Connecting to api-gateway" });
  const form = sheet.getByRole("form", { name: "Password for deploy" });
  await expect(form).toBeVisible();
  await expect(form).toContainText("The previous attempt was not accepted. Attempt 2 of 3.");
  await expect(form.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.type("hunter22");
  await page.keyboard.press("Enter");
  expect(await calls(page, "session_auth_answer")).toEqual([{ cmd: "session_auth_answer", args: expect.objectContaining({ promptId: "p2", secret: "hunter22" }) }]);
  await expect(form).toHaveCount(0);

  // A server question is shown as plain text, labelled as coming from the server.
  await emitSessionEvent(page, {
    type: "auth_prompt", promptId: "p3", kind: "keyboard_interactive", username: "deploy", attempt: 1, maxAttempts: 3,
    message: "<b>Verification code</b>", echo: false, hop: { index: 1, total: 2, label: "bastion" },
  });
  await expect(sheet.getByTestId("kbd-question")).toHaveText("<b>Verification code</b>");
  await expect(sheet.getByTestId("hop-notice")).toBeVisible();
  await page.clock.resume();
});

test("a changed host key blocks the connection: full fingerprints, the failed step, Close tab first", async ({ page }) => {
  await openApp(page, { hostKeyChangedFor: "staging-web" });
  await hosts(page);
  await connectHost(page, "staging-web");
  const sheet = page.getByRole("alert").filter({ hasText: "This server's identity has changed" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("connect-fingerprint")).toHaveCount(2);
  await expect(sheet.getByTestId("connect-fingerprint").first()).toHaveAttribute("aria-label", "SHA256:kyaNXVx1Uds2NONuEOTWsUwOsEBQnhhSOOg1h8P/Eng");
  await expect(steps(page).locator('[data-kind="fail"]')).toHaveText(/Checking server identity/);
  await expect(steps(page).locator('[data-kind="pending"]')).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Close tab" })).toBeFocused();
});

test("a failure is named by its cause and marks the step it happened at", async ({ page }) => {
  await openApp(page);
  await hosts(page);
  await connectHeld(page, () => connectHost(page, "edge-cache"));
  await page.clock.runFor(42); // authenticating
  await emitSessionEvent(page, { type: "state", state: "failed" });
  await emitSessionEvent(page, { type: "closed", error: { code: "AUTH_FAILED", message: "The server did not accept the password for ops." }, exitStatus: null });
  const sheet = page.getByRole("alert").filter({ hasText: "The server did not accept the sign-in" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("The server did not accept the password for ops.");
  await expect(steps(page).locator('[data-kind="fail"]')).toHaveText(/Signing in/);
  await expect(sheet.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await page.clock.resume();
});

// A changed server key is resolved where it is reported, never silently (INV-03): the warning
// offers to replace the key, which removes only the keys this server was refused against and
// connects again to a first-time trust prompt that shows the new key for checking. Nothing is trusted without the user's answer. Production frontend, mock backend.
import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp } from "./fixtures";

type Call = { cmd: string; args: Record<string, unknown> };
const calls = async (page: Page, cmd: string) =>
  (await page.evaluate(() => (window as unknown as { __mockCalls: Call[] }).__mockCalls)).filter((c) => c.cmd === cmd);
const trusted = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mockState: { knownHosts: { host: string; fingerprint: string }[] } }).__mockState.knownHosts.map((k) => `${k.host} ${k.fingerprint}`));

test("a changed key is replaced from its warning: only the refused key removed, then the new key checked before trust", async ({ page }) => {
  await openApp(page, { hostKeyChangedFor: "staging-web" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await connectHost(page, "staging-web");
  const sheet = page.getByRole("alert").filter({ hasText: "This server's identity has changed" });
  await expect(sheet).toBeVisible();
  // The safe choice keeps the focus; replacing is offered, not preselected.
  await expect(sheet.getByRole("button", { name: "Close tab" })).toBeFocused();
  // All three actions fit on one line of the sheet.
  const tops = await sheet.locator(".connect-actions .btn").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(tops).toHaveLength(3);
  expect(new Set(tops).size).toBe(1);
  // "Open Known hosts" begins where the text above it begins.
  const lefts = await sheet.evaluate((el) => {
    const hint = el.querySelector(".connect-hint") as HTMLElement;
    const button = el.querySelector(".connect-actions .btn-ghost") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(button);
    return [Math.round(hint.getBoundingClientRect().left), Math.round(range.getBoundingClientRect().left)];
  });
  expect(Math.abs((lefts[0] ?? 0) - (lefts[1] ?? 0))).toBeLessThanOrEqual(1);
  const before = await trusted(page);
  expect(before).toContain("stg.example.net SHA256:71J6v69vG05S8WYY7SBu9DjPz+twOC7FCitOMa8XCzM");

  // One press: that one key goes (its history notes where), and a new connection starts.
  const opens = (await calls(page, "session_open_ssh")).length;
  await sheet.getByRole("button", { name: "Replace key", exact: true }).click();
  await expect.poll(async () => (await calls(page, "known_host_remove")).length).toBe(1);
  expect((await calls(page, "known_host_remove"))[0]?.args.reason).toBe("Replaced from the changed-key warning");
  expect(await trusted(page)).toEqual(before.filter((k) => !k.startsWith("stg.example.net ")));
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(opens + 1);

  // The new key is shown for checking; nothing has trusted it yet.
  const prompt = page.getByRole("alertdialog", { name: "Verify this server before connecting" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId("connect-fingerprint")).toHaveCount(1);
  expect(await calls(page, "session_trust_answer")).toHaveLength(0);
  await prompt.getByRole("button", { name: "Trust and remember" }).click();
  await expect.poll(async () => (await calls(page, "session_trust_answer")).at(-1)?.args.decision).toBe("always");
});

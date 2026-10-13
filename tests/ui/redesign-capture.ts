// Synthetic browser evidence only. Never connects a native transport or reads user data.
// REDESIGN_STAGE=before|after pnpm exec playwright test -c tests/ui/redesign-capture.config.ts
import { mkdirSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import { connectHost, openApp, openSettings } from "./fixtures";
import { connectHeld, emitSessionEvent } from "./session-events";

const stage = process.env.REDESIGN_STAGE ?? "before";
if (!/^(before|after)$/.test(stage)) throw new Error("REDESIGN_STAGE must be before or after");
const output = new URL(`../../docs/redesign/${stage}/`, import.meta.url).pathname;
mkdirSync(output, { recursive: true });
const hosts = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
async function shot(page: Page, name: string) {
  const size = page.viewportSize();
  if (!size) throw new Error("capture needs a known viewport");
  await page.mouse.move(1, size.height - 1);
  // Let the existing mock's delayed banner finish before replacing its demo content.
  await page.waitForTimeout(100);
  // The existing mock's demo banner includes sample shell commands. Replace it with a
  // command-free synthetic glyph sample before evidence capture, including scrollback.
  await page.evaluate(() => {
    const fixture = window as unknown as {
      __mockState: { sessions: Map<string, { files: boolean }> };
      __mockOutputAt: (index: number, text: string) => void;
    };
    [...fixture.__mockState.sessions.values()].forEach((session, index) => {
      if (!session.files) fixture.__mockOutputAt(index, "\u001b[3J\u001b[2J\u001b[HSynthetic UI session — no commands executed\r\n\r\nTerminal glyph sample: 0 O 1 l I | [] {}\r\nUnicode: café 日本語 Ελληνικά\r\n\u001b[32mConnected test session\u001b[0m\r\n");
    });
  });
  // xterm processes output asynchronously; allow the command-free frame to render.
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${output}${size.width}x${size.height}-${name}.png`, animations: "disabled", caret: "hide" });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: first run and empty library`, async ({ page }) => {
    await openApp(page, { scenario: "onboarding", theme });
    await expect(page.getByRole("heading", { name: "Create your local vault" })).toBeVisible();
    await shot(page, `${theme}-onboarding`);
    await openApp(page, { scenario: "locked", theme });
    await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
    await shot(page, `${theme}-unlock`);
    await openApp(page, { scenario: "empty", theme, hostsLayout: "list" });
    await hosts(page);
    await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
    await shot(page, `${theme}-hosts-empty`);
  });

  for (const count of [1, 20, 500]) {
    test(`${theme}: library ${count}, search and editor`, async ({ page }) => {
      await openApp(page, { theme, hostsLayout: "list", extraHosts: Math.max(0, count - 6) });
      // Only the in-memory UI fixture changes. Refresh the view through actual navigation.
      if (count === 1) {
        await page.evaluate(() => {
          const state = (window as unknown as { __mockState: { hosts: unknown[] } }).__mockState;
          state.hosts = state.hosts.slice(0, 1);
        });
        await openSettings(page);
      }
      await hosts(page);
      await expect(page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __mockState: { hosts: unknown[] } }).__mockState.hosts.length)).toBe(count);
      await shot(page, `${theme}-hosts-${count}`);
      if (count !== 20) return;
      const search = page.getByRole("searchbox", { name: "Search hosts" });
      await search.fill("api-gateway");
      await expect(page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true })).toBeVisible();
      await shot(page, `${theme}-search-results`);
      await search.fill("no-such-synthetic-host");
      await expect(page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true })).toHaveCount(0);
      await shot(page, `${theme}-search-empty`);
      await search.fill("");
      await page.getByRole("button", { name: "New host" }).click();
      await expect(page.getByRole("complementary", { name: "New host" })).toBeVisible();
      await shot(page, `${theme}-host-editor`);
    });
  }

  test(`${theme}: terminal, split, palette, files and settings`, async ({ page }) => {
    await openApp(page, { theme, hostsLayout: "list" });
    await hosts(page);
    await connectHost(page, "api-gateway");
    await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
    await shot(page, `${theme}-terminal`);
    await page.getByRole("tab", { name: /api-gateway/ }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Split pane right" }).click();
    await expect(page.locator(".pane")).toHaveCount(2);
    await expect(page.getByRole("dialog", { name: "Connecting to api-gateway" })).toHaveCount(0);
    await shot(page, `${theme}-split`);
    await page.getByRole("button", { name: "Search or run a command" }).click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.getByRole("combobox", { name: /Type a command/ }).fill("api");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("combobox", { name: /Type a command/ })).toBeFocused();
    await shot(page, `${theme}-palette`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const files = page.getByRole("complementary", { name: "Files" });
    await expect(files).toBeVisible();
    await expect(files.getByRole("grid")).toBeVisible();
    await shot(page, `${theme}-files`);
    await openSettings(page);
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await shot(page, `${theme}-settings-appearance`);
    await openSettings(page, "Terminal");
    await shot(page, `${theme}-settings-terminal`);
  });

  test(`${theme}: connection and authentication states`, async ({ page }) => {
    await openApp(page, { theme, hostsLayout: "list" });
    await hosts(page);
    await connectHeld(page, () => connectHost(page, "api-gateway"));
    await page.clock.runFor(27);
    await expect(page.getByRole("dialog", { name: "Connecting to api-gateway" })).toBeVisible();
    await shot(page, `${theme}-connecting`);
    await page.clock.runFor(15);
    await emitSessionEvent(page, { type: "auth_prompt", promptId: "capture-auth", kind: "password", username: "deploy", attempt: 1, maxAttempts: 3, message: null, echo: false, hop: null });
    await expect(page.getByRole("form", { name: "Password for deploy" })).toBeVisible();
    await shot(page, `${theme}-authenticating`);
    await emitSessionEvent(page, { type: "state", state: "failed" });
    await emitSessionEvent(page, { type: "closed", error: { code: "AUTH_FAILED", message: "Synthetic sign-in failure." }, exitStatus: null });
    await expect(page.getByRole("alert").filter({ hasText: "The server did not accept the sign-in" })).toBeVisible();
    await shot(page, `${theme}-auth-failed`);
    await page.clock.resume();
  });

  test(`${theme}: unknown and changed host key`, async ({ page }) => {
    await openApp(page, { theme, hostsLayout: "list", trustPromptFor: "staging-web" });
    await hosts(page);
    await connectHost(page, "staging-web");
    await expect(page.getByRole("alertdialog", { name: "Verify this server before connecting" })).toBeVisible();
    await shot(page, `${theme}-trust`);
    await openApp(page, { theme, hostsLayout: "list", hostKeyChangedFor: "staging-web" });
    await hosts(page);
    await connectHost(page, "staging-web");
    const warning = page.getByRole("alert").filter({ hasText: "This server's identity has changed" });
    await expect(warning).toBeVisible();
    await expect(warning.getByTestId("connect-fingerprint")).toHaveCount(2);
    await shot(page, `${theme}-changed-key`);
  });

  test(`${theme}: SFTP panes`, async ({ page }) => {
    await openApp(page, { theme });
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "SFTP", exact: true }).click();
    const view = page.getByRole("region", { name: "SFTP file manager" });
    await expect(view.getByRole("heading", { name: "Connect to host" }).first()).toBeVisible();
    await shot(page, `${theme}-sftp-picker`);
    await view.getByRole("region", { name: "Left pane", exact: true }).getByRole("button", { name: "Choose folder…" }).click();
    await view.getByRole("region", { name: "Right pane", exact: true }).getByRole("button", { name: /^api-gateway/ }).click();
    await expect(view.getByRole("grid", { name: /on api-gateway/ })).toBeVisible();
    await shot(page, `${theme}-sftp-panes`);
  });
}

// Themes exist only after the redesign, so these have no "before" counterpart.
for (const palette of ["verdigris", "fjord", "graphite", "contrast"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: theme ${palette}`, async ({ page }) => {
      test.skip(stage !== "after", "application themes were added by the redesign");
      await openApp(page, { theme, palette, hostsLayout: "list" });
      await hosts(page);
      await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
      await expect(page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true })).toBeVisible();
      await shot(page, `${theme}-theme-${palette}`);
    });
  }
}

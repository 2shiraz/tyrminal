// Search across open sessions (P-28) and one command's output (P-29) against the UI test mock.
// The mock prints shell-integration marks (OSC 133) the way the real integration does; the
// native suite checks the same against a real shell.
import { type Page, expect, test } from "@playwright/test";

import { searchLines } from "../../apps/desktop/src/features/terminal/scrollbackSearch";
import { openApp, openSettings, waitForTerminalText } from "./fixtures";

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function connect(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

async function palette(page: Page, label: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(label);
  const option = page.getByRole("option", { name: new RegExp(label) });
  await expect(option).toHaveCount(1);
  await option.click();
}

test("search finds text in every open session, grouped by tab, and jumps to it", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await output(page, "\r\nalpha needle-one omega\r\n");
  await connect(page, "build-runner-03");
  await output(page, "\r\nbeta NEEDLE-two\r\n");
  await waitForTerminalText(page, "NEEDLE-two");

  await palette(page, "Search all sessions");
  const dialog = page.getByRole("dialog", { name: "Search all sessions" });
  await dialog.getByLabel("Text to find in every open session").fill("needle");
  await expect(dialog.getByRole("status")).toHaveText("2 matches in 2 tabs");
  const gateway = dialog.getByRole("region", { name: /api-gateway/ });
  await expect(gateway.getByRole("button")).toHaveText(["alpha needle-one omega"]);
  // Match case narrows it to one.
  await dialog.getByLabel("Match case").check();
  await expect(dialog.getByRole("status")).toHaveText("1 match in 1 tab");
  await dialog.getByLabel("Match case").uncheck();
  await expect(dialog.getByRole("status")).toHaveText("2 matches in 2 tabs");

  // Choosing the match in the background tab brings that tab to the front and selects it.
  await gateway.getByRole("button").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /api-gateway/ })).toHaveAttribute("aria-selected", "true");
  await waitForTerminalText(page, "needle-one");
  // Nothing was sent anywhere: the search never leaves the page.
  expect(JSON.stringify(await page.evaluate(() => (window as unknown as { __mockCalls: unknown[] }).__mockCalls))).not.toContain("needle");
});

test("search: sliced reads resume where they stopped and never repeat or skip a match", () => {
  // A fake buffer: 25 rows, row 7 continues row 6 (soft wrap), "x" twice on row 3.
  const rows = Array.from({ length: 25 }, (_, y) => (y === 3 ? "x and x" : y === 6 ? "a long lin" : y === 7 ? "e ending x" : y % 5 === 0 ? `row ${y} x` : `row ${y}`));
  const getLine = (y: number) =>
    rows[y] === undefined ? undefined : ({ isWrapped: y === 7, translateToString: () => rows[y] as string } as unknown as import("@xterm/xterm").IBufferLine);
  const whole = searchLines(getLine, rows.length, "x").matches.map((m) => `${m.row}:${m.col}`);
  expect(whole).toEqual(["0:6", "3:0", "3:6", "5:6", "7:9", "10:7", "15:7", "20:7"]);
  for (const step of [1, 2, 3, 7]) {
    for (const max of [1, 2, 100]) {
      const seen: string[] = [];
      let from = 0;
      for (let guard = 0; from < rows.length && guard < 100; guard++) {
        const r = searchLines(getLine, rows.length, "x", false, { from, rows: step, max });
        seen.push(...r.matches.map((m) => `${m.row}:${m.col}`));
        // A slice never ends inside a wrapped line.
        expect(rows[r.next] === undefined || r.next !== 7, `step ${step} max ${max}`).toBe(true);
        expect(r.next).toBeGreaterThan(from);
        from = r.next;
      }
      expect(seen, `step ${step} max ${max}`).toEqual(whole);
    }
  }
  // Starting inside a wrapped line starts at its first row.
  expect(searchLines(getLine, rows.length, "x", false, { from: 7, rows: 1 }).matches.map((m) => m.row)).toEqual([7]);
});

test("search: its shortcut opens it, terminals only, and the query is never logged, sent or stored", async ({ page }) => {
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  await openApp(page, { renderer: "compatibility" });
  // Without a terminal there is nothing to search: the shortcut does nothing.
  await page.keyboard.press("Alt+Shift+F");
  await expect(page.getByRole("dialog", { name: "Search all sessions" })).toHaveCount(0);

  await connect(page, "api-gateway");
  await output(page, "\r\nsecret-canary-5521 in the scrollback\r\n");
  await waitForTerminalText(page, "secret-canary-5521");
  // An SFTP tab is open too; it is never listed.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("SFTP");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /SFTP/ })).toBeVisible();

  // The shortcut is listed under Keyboard shortcuts and opens the search.
  await page.keyboard.press("Alt+Shift+F");
  const dialog = page.getByRole("dialog", { name: "Search all sessions" });
  await dialog.getByLabel("Text to find in every open session").fill("canary-5521");
  await expect(dialog.getByRole("status")).toHaveText("1 match in 1 tab");
  await expect(dialog.getByRole("region")).toHaveCount(1);
  await expect(dialog.getByRole("region", { name: /SFTP/ })).toHaveCount(0);
  await dialog.getByLabel("Match case").check();
  await dialog.getByLabel("Text to find in every open session").fill("canary-5521 in");
  await expect(dialog.getByRole("status")).toHaveText("1 match in 1 tab");

  // Not in any native call, console line, storage, the URL or the title.
  const leaks = await page.evaluate(() => {
    const store = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? "")}`).join("\n");
    return [
      JSON.stringify((window as unknown as { __mockCalls: unknown[] }).__mockCalls),
      JSON.stringify((window as unknown as { __mockState: { prefs: unknown } }).__mockState.prefs),
      store(localStorage),
      store(sessionStorage),
      location.href,
      document.title,
    ];
  });
  for (const text of [...leaks, consoleText.join("\n")]) expect(text).not.toContain("canary-5521");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await openSettings(page, "Keyboard shortcuts");
  await expect(page.locator("#settings-shortcuts").getByText("Search all sessions", { exact: true })).toBeVisible();
});

test("search: stops at 500 matches and offers more", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");
  await output(page, Array.from({ length: 700 }, (_, i) => `\r\nhit ${i}`).join(""));
  await waitForTerminalText(page, "hit 699");
  await palette(page, "Search all sessions");
  const dialog = page.getByRole("dialog", { name: "Search all sessions" });
  await dialog.getByLabel("Text to find in every open session").fill("hit ");
  await expect(dialog.getByRole("status")).toHaveText("500 matches in 1 tab");
  await expect(dialog.getByText("Showing the first 500 matches.")).toBeVisible();
  await expect(dialog.locator(".search-match")).toHaveCount(500);
  await dialog.getByRole("button", { name: "More…" }).click();
  await expect(dialog.getByRole("status")).toHaveText("700 matches in 1 tab");
  await expect(dialog.getByRole("button", { name: "More…" })).toHaveCount(0);
  // Each line once, in order.
  await expect(dialog.locator(".search-match").nth(500)).toContainText("hit 500");
});

test("a command's output is copied or saved without the prompt and command line, and only with marks", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, { renderer: "compatibility" });
  await connect(page, "api-gateway");

  // Without shell integration marks, the action is not offered.
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("command's output");
  await expect(page.getByRole("option", { name: /command's output/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A prompt, a command, its output, its end (exit 3), and the next prompt, with OSC 133 marks.
  const osc = (s: string) => `\x1b]133;${s}\x07`;
  await output(page, `\r\n${osc("A")}deploy$ ${osc("B")}ls -1 /srv\r\n${osc("C")}file-a\r\nfile-b\r\n${osc("D;3")}${osc("A")}deploy$ ${osc("B")}`);
  await waitForTerminalText(page, "file-b");

  await palette(page, "command's output");
  const dialog = page.getByRole("dialog", { name: /Command output/ });
  const row = dialog.getByTestId("command-list").getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("ls -1 /srv");
  await expect(row).toContainText("Exit 3");
  await row.getByRole("button", { name: "Copy the output of ls -1 /srv" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("file-a\nfile-b");
  await row.getByRole("button", { name: "Save the output of ls -1 /srv to a file" }).click();
  await expect(page.getByText("Output saved to command-output.txt")).toBeVisible();
  expect(await calls(page, "terminal_output_save")).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __mockSavedOutput: string }).__mockSavedOutput)).toBe("file-a\nfile-b");
});

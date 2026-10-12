// Paste safety (P-25, ADR 0011) against the UI test mock: what is reviewed, how hidden characters
// and the bracketed-paste end marker are shown, the session the text goes to, and per-host
// lowering that never turns off the hidden-character review. The rules themselves are covered
// without a page in paste-safety.unit.spec.ts.
import { type Page, expect, test } from "@playwright/test";

import { openApp, waitForTerminalText } from "./fixtures";

const received = (page: Page) => page.evaluate(() => (window as unknown as { __mockReceived?: string }).__mockReceived ?? "");
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);
const paste = (page: Page, text: string) =>
  page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    document.querySelector(".terminal-pane:not([hidden]) .xterm-helper-textarea")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);

async function connect(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "deploy@api-gateway");
}

test("one line ending in a newline is reviewed and names the session it goes to", async ({ page }) => {
  await connect(page);
  const before = await received(page);
  await paste(page, "rm -rf ./build\n");
  const dialog = page.getByRole("dialog", { name: "Paste and run this line?" });
  await expect(dialog).toContainText("runs it as soon as it is pasted");
  await expect(dialog.getByTestId("paste-target")).toContainText("api-gateway");
  await expect(dialog.getByTestId("paste-target")).toContainText("deploy@");
  // Cancel is the default and sends nothing.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await received(page)).toBe(before);
  // Without the newline it goes straight through.
  await paste(page, "echo plain");
  await expect.poll(() => received(page)).toContain("echo plain");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("control, bidi and zero-width characters are shown by name with a warning", async ({ page }) => {
  await connect(page);
  await paste(page, "echo ‮safe​\u001b[2J");
  const dialog = page.getByRole("dialog", { name: "This paste has hidden characters" });
  await expect(dialog).toContainText("3 control or invisible characters");
  const text = dialog.getByLabel("Text to paste, with hidden characters shown");
  await expect(text).toHaveText("echo <U+202E>safe<U+200B>␛[2J");
  await expect(text.locator("mark")).toHaveText(["<U+202E>", "<U+200B>␛"]);
  // Sending sends the exact text the user reviewed.
  const before = await received(page);
  await dialog.getByRole("button", { name: "Paste", exact: true }).click();
  await expect.poll(async () => (await received(page)).slice(before.length)).toBe("echo ‮safe​\u001b[2J");
});

test("a bracketed-paste end marker is never sent; the review can only strip it", async ({ page }) => {
  await connect(page);
  await output(page, "\u001b[?2004h");
  const evil = "echo safe\u001b[201~rm -rf ~\r";
  await paste(page, evil);
  const dialog = page.getByRole("dialog", { name: "This paste would end bracketed paste early" });
  await expect(dialog).toContainText("ESC [201~");
  await expect(dialog.getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
  const before = await received(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await received(page)).toBe(before);

  await paste(page, evil);
  await page.getByRole("button", { name: "Remove the marker and paste" }).click();
  await expect.poll(async () => (await received(page)).slice(before.length)).toBe("\u001b[200~echo saferm -rf ~\r\u001b[201~");
  // The 8-bit form is caught the same way.
  await paste(page, "a\u009b201~b");
  await expect(page.getByRole("dialog", { name: "This paste would end bracketed paste early" })).toBeVisible();
});

test("a host can lower the line and newline reviews but never the hidden-character review", async ({ page }) => {
  await connect(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).first().click();
  await page.getByRole("button", { name: "More actions for api-gateway" }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editor = page.getByRole("complementary", { name: "Host details" });
  await editor.getByText("Show more").click();
  await expect(editor.getByText("always reviewed, on every host")).toBeVisible();
  await editor.getByRole("switch", { name: "Paste several lines or a large text without review" }).click();
  await editor.getByRole("switch", { name: "Paste one line ending in a newline without review" }).click();
  // Saved as you go.
  await expect(page.getByTestId("host-panel")).toHaveAttribute("data-autosave", "clean");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __mockCalls: { cmd: string; args: { host: { terminal: { pasteSkipTrailingNewline?: boolean } } } }[] }).__mockCalls
            .filter((c) => c.cmd === "host_save")
            .at(-1)?.args.host.terminal.pasteSkipTrailingNewline,
      ),
    )
    .toBe(true);
  const saved = await page.evaluate(() =>
    (window as unknown as { __mockCalls: { cmd: string; args: { host: { terminal: unknown } } }[] }).__mockCalls.filter((c) => c.cmd === "host_save").at(-1)?.args.host.terminal,
  );
  expect(saved).toMatchObject({ pasteSkipMultiline: true, pasteSkipTrailingNewline: true });

  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await paste(page, "echo first\necho second\n");
  await expect.poll(() => received(page)).toContain("echo second");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await paste(page, "ls\u0007\n");
  await expect(page.getByRole("dialog", { name: "This paste has hidden characters" })).toBeVisible();
});

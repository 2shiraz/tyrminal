// Behavior of the redesigned shell and terminal policy in the browser, against the test-only mock
// backend. Native enforcement of the same rules is tested in crates/core and tests/native.
import { type Page, expect, test } from "@playwright/test";

import { openApp, terminalText, waitForTerminalText } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
/** Clicks terminal text the way a user does: at its position on the terminal's screen layer. */
async function clickTerminalText(page: Page, text: string) {
  const box = await page.locator(".xterm-rows span", { hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no terminal text ${text}`);
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.move(x + 1, y);
  await page.mouse.click(x + 1, y);
}
const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (s: string) => void }).__mockOutput(t), text);

async function connectFromPalette(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  const input = page.getByRole("combobox", { name: /Type a command/ });
  await expect(input).toBeFocused();
  await input.fill(host);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: new RegExp(host) })).toBeVisible();
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

test("keyboard only: palette connects, tabs rename, move and close, focus returns", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  await waitForTerminalText(page, "deploy@api-gateway");
  // Typing goes to the terminal that just opened.
  await page.keyboard.type("uptime");
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "uptime: synthetic output");

  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(3);
  // Rename the local terminal tab from the keyboard.
  await page.keyboard.press("Control+Shift+R");
  const rename = page.getByRole("textbox", { name: "Rename tab" });
  await expect(rename).toBeFocused();
  await rename.fill("scratch");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /scratch/ })).toBeFocused();
  // Move it left (Ctrl+Shift+Left on the focused tab) and close it with Delete.
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect(page.getByRole("tab").nth(1)).toHaveText(/scratch/);
  await page.keyboard.press("Delete");
  await expect(page.getByRole("tab")).toHaveCount(2);
  // Alt+1 selects the first terminal tab again.
  await page.keyboard.press("Alt+1");
  await expect(page.getByRole("tab", { name: /api-gateway/ })).toHaveAttribute("aria-selected", "true");
});

test("splits: open, focus moves between panes, close the focused pane", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "db-primary");
  await page.keyboard.press("Alt+Shift+Equal");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(page.locator('.pane[data-focused="true"]')).toHaveCount(1);
  const second = await page.locator('.pane[data-focused="true"]').boundingBox();
  await page.keyboard.press("Alt+ArrowLeft");
  const first = await page.locator('.pane[data-focused="true"]').boundingBox();
  expect(first!.x).toBeLessThan(second!.x);
  await page.keyboard.press("Alt+Shift+Minus");
  await expect(page.locator(".pane")).toHaveCount(3);
  await page.keyboard.press("Control+Shift+W");
  await expect(page.locator(".pane")).toHaveCount(2);
  // A separator can be resized from the keyboard.
  const splitter = page.getByRole("separator").first();
  await splitter.focus();
  const before = Number(await splitter.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(before + 3));
});

test("snippets: target is the visible session, multi-line runs only after a preview", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox").fill("Local terminal");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab")).toHaveCount(3);
  // Back to the SSH tab: it is the target.
  await page.getByRole("tab", { name: /api-gateway/ }).click();
  await page.keyboard.press("Control+Shift+S");
  const panel = page.getByRole("complementary", { name: "Snippets" });
  await expect(panel.getByRole("status", { name: "Target" })).toContainText("Sends to api-gateway");

  // Single line: sent at once, to the active pane's session.
  await panel.getByRole("button", { name: "Run Disk usage in the terminal" }).click();
  await waitForTerminalText(page, "df -h: synthetic output");
  const sent = await calls(page, "snippet_send");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args).toMatchObject({ mode: "run" });

  // Multi-line: a preview names the target and shows the text; cancelling sends nothing.
  await panel.getByRole("button", { name: "Run Deploy to staging in the terminal" }).click();
  const preview = page.getByRole("alertdialog", { name: /Run “Deploy to staging”/ });
  await expect(preview).toContainText("api-gateway");
  await expect(preview).toContainText("make build");
  await preview.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "snippet_send")).toHaveLength(1);
  await panel.getByRole("button", { name: "Run Deploy to staging in the terminal" }).click();
  await page.getByRole("button", { name: "Run 3 lines" }).click();
  await waitForTerminalText(page, "./scripts/deploy.sh staging: synthetic output");
  expect(await calls(page, "snippet_send")).toHaveLength(2);
});

test("snippets page has no target, so nothing can be sent from it", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Snippets/ }).click();
  await expect(page.getByRole("button", { name: "Run Disk usage in the terminal" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Paste Disk usage into the terminal" })).toBeDisabled();
});

test("snippets: create with a folder, duplicate and delete", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Snippets/ }).click();
  await page.getByRole("button", { name: "New snippet" }).click();
  const dialog = page.getByRole("dialog", { name: "New snippet" });
  await dialog.getByLabel("Name").fill("Who is logged in");
  await dialog.getByLabel("Folder").fill("Audit/Users");
  await dialog.getByLabel("Command").fill("who\nlast -n 5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Audit/Users" })).toBeVisible();
  await page.getByRole("button", { name: "More actions for Who is logged in" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("dialog", { name: "New snippet" }).getByLabel("Name")).toHaveValue("Who is logged in copy");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[data-snippet="Who is logged in copy"]')).toBeVisible();
  await page.getByRole("button", { name: "More actions for Who is logged in copy" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator('[data-snippet="Who is logged in copy"]')).toHaveCount(0);
});

test("locking clears the snippets panel, terminals and every decrypted name", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+S");
  await expect(page.getByText("Deploy to staging")).toBeVisible();
  await page.keyboard.press("Control+Shift+L");
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  const text = await page.evaluate(() => document.body.innerText);
  for (const leaked of ["Deploy to staging", "api-gateway", "df -h", "10.20.0.11"]) expect(text).not.toContain(leaked);
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await expect(page.locator(".side-panel")).toHaveCount(0);
});

test("GPU renderer falls back when WebGL is unavailable", async ({ page }) => {
  await openApp(page, { noWebgl: true });
  await connectFromPalette(page, "api-gateway");
  await expect(page.locator(".statusbar")).toContainText("Renderer: Compatibility");
  await expect(page.locator(".terminal-host")).toHaveAttribute("data-renderer", "dom");
});

test("GPU renderer falls back when the WebGL context is lost, and the session keeps working", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await expect(page.locator(".statusbar")).toContainText("Renderer: GPU");
  const lost = await page.evaluate(() => {
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(".terminal-pane:not([hidden]) canvas")) {
      const gl = canvas.getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_lose_context");
      if (ext) {
        ext.loseContext();
        return true;
      }
    }
    return false;
  });
  expect(lost).toBe(true);
  // xterm waits 3 s for the context to be restored before giving up on it.
  await expect(page.locator(".statusbar")).toContainText("Renderer: Compatibility", { timeout: 10_000 });
  await expect(page.getByRole("status").filter({ hasText: "switched to the compatibility renderer" })).toBeVisible();
  await page.keyboard.type("echo still-here");
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "echo still-here: synthetic output");
});

test("links need a click and a confirmation that shows the real destination", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  // OSC 8 hyperlink whose visible text claims a different site.
  await output(page, "\r\n\u001b]8;;https://evil.example/login\u001b\\https://bank.example\u001b]8;;\u001b\\ \r\n");
  await waitForTerminalText(page, "https://bank.example");
  expect(await calls(page, "link_open")).toHaveLength(0);
  await clickTerminalText(page, "https://bank.example");
  const dialog = page.getByRole("dialog", { name: "Open this link in your browser?" });
  await expect(dialog).toContainText("evil.example");
  await expect(dialog.getByTestId("link-destination")).toHaveText("https://evil.example/login");
  await dialog.getByRole("button", { name: "Open in browser" }).click();
  expect((await calls(page, "link_open"))[0]!.args).toEqual({ url: "https://evil.example/login" });

  // A non-web scheme is refused outright.
  await output(page, "\r\n\u001b]8;;javascript:alert(1)\u001b\\click me\u001b]8;;\u001b\\ \r\n");
  await waitForTerminalText(page, "click me");
  await clickTerminalText(page, "click me");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(await calls(page, "link_open")).toHaveLength(1);
});

test("OSC 52: clipboard writes wait for consent; reads are never answered", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  const writesBefore = (await calls(page, "session_write")).length;
  // A read request: nothing may be written back to the session.
  await output(page, "\u001b]52;c;?\u0007");
  // A write request: held for consent.
  await output(page, `\u001b]52;c;${Buffer.from("rm -rf ~").toString("base64")}\u0007`);
  const banner = page.getByRole("alertdialog", { name: "The server wants to set your clipboard." });
  await expect(banner).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("before");
  await banner.getByRole("button", { name: "Ignore" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("before");
  expect((await calls(page, "session_write")).length).toBe(writesBefore);

  await output(page, `\u001b]52;c;${Buffer.from("allowed text").toString("base64")}\u0007`);
  await page.getByRole("button", { name: "Allow for this session" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("allowed text");
  await expect(page.locator(".statusbar")).toContainText("Clipboard writes allowed");
});

test("multi-line paste is previewed; single-line paste goes straight through", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await connectFromPalette(page, "api-gateway");
  const paste = (text: string) =>
    page.evaluate((t) => {
      const data = new DataTransfer();
      data.setData("text/plain", t);
      document.querySelector(".terminal-pane:not([hidden]) .xterm-helper-textarea")!.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
  await paste("echo one-line");
  await waitForTerminalText(page, "echo one-line");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await paste("echo first\necho second\n");
  const dialog = page.getByRole("dialog", { name: "Paste several lines?" });
  await expect(dialog).toContainText("2 lines");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await terminalText(page)).not.toContain("echo first");
  await paste("echo first\necho second\n");
  await page.getByRole("dialog").getByRole("button", { name: "Paste" }).click();
  await waitForTerminalText(page, "echo second: synthetic output");
});

test("theme and terminal preferences apply live and are persisted natively", async ({ page }) => {
  await openApp(page, { theme: "dark" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  await page.locator(".segmented label", { hasText: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("radio", { name: /Solarized Light/ }).click();
  await expect.poll(async () => (await calls(page, "prefs_set")).at(-1)?.args).toMatchObject({
    prefs: { theme: "light", terminal: { scheme: "solarized-light" } },
  });
});

test("every button has an accessible name and ids are unique", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+S");
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"]')) {
      const name = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").trim();
      if (!name) out.push(`unnamed ${el.tagName} ${el.className}`);
    }
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) out.push(`duplicate id ${id}`);
    return out;
  });
  expect(problems).toEqual([]);
});

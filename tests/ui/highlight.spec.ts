// Highlight patterns (TRM-07): bounded regular expressions, matched in a worker under a time
// limit. Mock backend; never native evidence.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

async function openSettings(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Output highlighting" })).toBeVisible();
  const on = page.getByLabel("Highlight output").first();
  if (!(await on.isChecked())) await on.check();
  // Only patterns in these tests.
  const ip = page.getByLabel("IP addresses").first();
  if (await ip.isChecked()) await ip.uncheck();
}

async function addRule(page: Page, kind: "Word" | "Pattern", text: string) {
  await page.getByLabel("Match as").selectOption({ label: kind });
  await page.getByLabel(kind === "Pattern" ? "Pattern to highlight" : "Word to highlight").fill(text);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

async function connect(page: Page) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("api-gateway");
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

const output = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __mockOutput: (t: string) => void }).__mockOutput(t), text);

test("patterns: a match is drawn over exactly its cells; earlier rules win; the text is unchanged", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSettings(page);
  await addRule(page, "Pattern", "user=\\w+");
  await addRule(page, "Word", "ok");
  // A later rule overlapping an earlier one loses.
  await addRule(page, "Word", "alice");
  await expect(page.locator(".highlight-words li")).toHaveCount(3);
  await expect(page.locator(".highlight-words li").first()).toContainText("/user=\\w+/");

  await connect(page);
  const line = "login user=alice id=7 ok";
  await output(page, `\r\n${line}\r\n`);
  const marks = page.locator(".term-highlight");
  await expect(marks).toHaveCount(2);
  await expect(page.locator('.term-highlight[data-tone="info"]')).toHaveCount(1);
  await expect(page.locator('.term-highlight[data-tone="danger"]')).toHaveCount(1);
  // "user=alice" is ten cells, "ok" two.
  const widths = await marks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width).sort((a, b) => a - b));
  expect(Math.round((widths[1] as number) / (widths[0] as number))).toBe(5);
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText(line);
});

test("patterns: shapes that could run without bound are refused before they are saved", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await openSettings(page);
  await page.getByLabel("Match as").selectOption({ label: "Pattern" });
  const input = page.getByLabel("Pattern to highlight");
  const add = page.getByRole("button", { name: "Add", exact: true });
  const cases: [string, RegExp][] = [
    ["(a+)+$", /A group cannot be repeated/],
    ["(x|xx)*y", /A group cannot be repeated/],
    ["(a)\\1", /Backreferences/],
    ["(?=a)b", /Lookahead/],
    ["(?<!a)b", /Lookahead/],
    ["a{1,999}", /256 at most/],
    ["\\w*\\w*\\w*\\w*x", /three times at most/],
    ["a*", /matches empty text/],
    ["[a-", /unclosed \[/],
    ["(a", /unclosed \(/],
  ];
  for (const [pattern, why] of cases) {
    await input.fill(pattern);
    await expect(page.getByRole("alert")).toHaveText(why);
    await expect(add).toBeDisabled();
    await expect(input).toHaveAttribute("aria-invalid", "true");
  }
  await input.fill("ERR-\\d{3}");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(add).toBeEnabled();
  // A word is literal text, whatever it contains.
  await page.getByLabel("Match as").selectOption({ label: "Word" });
  await page.getByLabel("Word to highlight").fill("(a+)+$");
  await expect(add).toBeEnabled();
});

test("patterns: one that takes too long is switched off, the others keep working and the terminal stays responsive", async ({ page }) => {
  await openApp(page, { renderer: "compatibility" });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openSettings(page);
  // Polynomial backtracking within the static limits: three unbounded runs before a ! that never comes.
  await addRule(page, "Pattern", "[a-z]*[a-z]*[a-z]*!");
  await addRule(page, "Pattern", "id=\\d+");

  await connect(page);
  const rows = Array.from({ length: 30 }, () => "a".repeat(150)).join("\r\n");
  await output(page, `\r\n${rows}\r\nid=42\r\n`);
  await expect(page.getByText("The highlight pattern /[a-z]*[a-z]*[a-z]*!/ took too long and was switched off.")).toBeVisible({ timeout: 10_000 });
  // The other pattern still applies once the slow one is off.
  await expect(page.locator('.term-highlight[data-tone="info"]')).toHaveCount(1);
  // Typing still reaches the session.
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane:not([hidden]) .xterm-rows")).toContainText("echo hi: synthetic output");

  // Settings show it as off; changing the rules gives it another chance.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
  const slowRow = page.locator(".highlight-words li").first();
  await expect(slowRow.getByRole("status")).toHaveText("Off: took too long. Edit the rules to try again.");
  await slowRow.getByRole("button", { name: /Remove/ }).click();
  await expect(page.locator(".highlight-words li")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "took too long" })).toHaveCount(0);
});

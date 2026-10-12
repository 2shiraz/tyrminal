import { expect, type Page, test } from "@playwright/test";

import { openApp } from "./fixtures";

// Session recordings against the mock backend. The format, encryption and "output only" rule are
// verified natively (crates/session-log, crates/core/tests/history.rs); these tests cover the page.

async function recordingsPage(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Recordings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Recordings" })).toBeVisible();
}

const settings = (page: Page) =>
  page.evaluate(() => (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke("recording_settings_get"));

test("recordings: off by default; turning it off keeps existing recordings", async ({ page }) => {
  await openApp(page, { recordings: true });
  await recordingsPage(page);
  const record = page.getByRole("switch", { name: /Record sessions/ });
  await expect(record).not.toBeChecked();
  await expect(page.getByTestId("recordings-storage")).toHaveText("3 recordings · 24 KB on this computer");

  await record.check();
  await expect(page.getByText("New sessions will be recorded.")).toBeVisible();
  await page.getByRole("combobox", { name: "Keep per host" }).selectOption("10");
  await page.getByRole("combobox", { name: "Size limit per recording" }).selectOption("128");
  await expect.poll(() => settings(page)).toEqual({ enabled: true, keepPerHost: 10, maxLogMib: 128 });

  await record.uncheck();
  await expect(page.getByText("Recording is off. Existing recordings are kept.")).toBeVisible();
  await expect(page.getByTestId("recordings").getByRole("listitem")).toHaveCount(3);
});

test("recordings: newest first, search and bookmark filter, comments, delete and delete all", async ({ page }) => {
  await openApp(page, { recordings: true });
  await recordingsPage(page);
  const rows = page.getByTestId("recordings").getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-recording", "staging-web");
  await expect(rows.nth(1)).toHaveAttribute("data-recording", "api-gateway");
  await expect(rows.nth(2)).toHaveAttribute("data-recording", "Local terminal");
  await expect(rows.nth(1)).toContainText("Incomplete");
  await expect(rows.nth(2)).toContainText("Damaged");

  // Search covers titles and comments.
  const search = page.getByRole("searchbox", { name: "Search recordings" });
  await search.fill("pods restarted");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-recording", "staging-web");
  await search.fill("nothing like this");
  await expect(page.getByText("No recordings match.")).toBeVisible();
  await search.fill("");

  // Bookmarks: toggle, filter, then a comment through the dialog.
  const show = page.getByRole("radiogroup", { name: "Show" });
  await show.getByText("Bookmarked").click();
  await expect(show.getByRole("radio", { name: "Bookmarked" })).toBeChecked();
  await expect(rows).toHaveCount(1);
  await show.getByText("All").click();
  await page.getByRole("button", { name: "Bookmark recording of api-gateway" }).click();
  await expect(page.getByRole("button", { name: "Remove bookmark from recording of api-gateway" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "More actions for recording of api-gateway" }).click();
  await page.getByRole("menuitem", { name: "Edit comment" }).click();
  const dialog = page.getByRole("dialog", { name: "Bookmark and comment" });
  await dialog.getByLabel("Comment").fill("  gateway timeouts at 09:12  ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(rows.nth(1)).toContainText("gateway timeouts at 09:12");

  // Delete one, with a confirmation.
  await page.getByRole("button", { name: "More actions for recording of Local terminal" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete this recording?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(2);

  // Delete all is its own action and says it includes bookmarks.
  await page.getByRole("button", { name: "Delete all recordings" }).click();
  const all = page.getByRole("alertdialog", { name: "Delete every recording?" });
  await expect(all).toContainText("including bookmarked ones");
  await all.getByRole("button", { name: "Delete all" }).click();
  await expect(page.getByText("Deleted 2 recordings.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No recordings yet" })).toBeVisible();
});

test("playback is read-only: recorded links, clipboard writes and titles do nothing", async ({ page }) => {
  await openApp(page, { recordings: true });
  await page.evaluate(() => {
    const w = window as unknown as { __clipboardWrites: number };
    w.__clipboardWrites = 0;
    const clip = navigator.clipboard as unknown as { writeText: (t: string) => Promise<void> };
    clip.writeText = async () => {
      w.__clipboardWrites += 1;
    };
    // xterm's built-in link handling would ask with window.confirm and open with window.open.
    const x = window as unknown as { __opened: number; open: () => null; confirm: () => boolean };
    x.__opened = 0;
    x.open = () => {
      x.__opened += 1;
      return null;
    };
    x.confirm = () => {
      x.__opened += 1;
      return true;
    };
  });
  const title = await page.title();
  await recordingsPage(page);
  await page.getByRole("button", { name: "Open recording of staging-web" }).click();
  const player = page.getByTestId("log-player");
  await expect(player).toContainText("rollout finished: 12 pods ready");
  await expect(page.getByText(/Read-only playback/)).toBeVisible();

  // The recorded hyperlink: hovering and clicking it (as behavior.spec.ts does to show that a live
  // terminal asks before opening) opens no confirmation and changes nothing.
  const box = await player.locator(".xterm-rows span", { hasText: "open the runbook" }).first().boundingBox();
  if (!box) throw new Error("the recorded link is not on screen");
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.move(x + 1, y);
  await page.mouse.click(x + 1, y);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __clipboardWrites: number }).__clipboardWrites)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __opened: number }).__opened)).toBe(0);
  expect(await page.title()).toBe(title);

  // Typing into the player sends nothing anywhere.
  await player.click();
  await page.keyboard.type("rm -rf /");
  await expect(player).not.toContainText("rm -rf");

  // Find in the recording.
  const find = page.getByRole("searchbox", { name: "Find in recording" });
  await find.fill("pods ready");
  await find.press("Enter");
  await expect(page.getByText("No match")).toHaveCount(0);
  await find.fill("not in this recording");
  await find.press("Enter");
  await expect(page.getByText("No match")).toBeVisible();

  // Back to the list; an incomplete recording says so when opened.
  await page.getByRole("button", { name: "Back to recordings" }).click();
  await page.getByRole("button", { name: "Open recording of api-gateway" }).click();
  await expect(page.getByText(/stops early/)).toBeVisible();
  await page.getByRole("button", { name: "Back to recordings" }).click();
  await page.getByRole("button", { name: "Open recording of Local terminal" }).click();
  await expect(page.getByText(/failed verification/)).toBeVisible();
});

test("the palette opens the Recordings page", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill("recordings");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Recordings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No recordings yet" })).toBeVisible();
  await expect(page.getByText(/Turn on recording above/)).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`recordings page and player pass the WCAG 2.2 AA audit (${theme})`, async ({ page }) => {
    const AxeBuilder = (await import("@axe-core/playwright")).default;
    const audit = async () => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .exclude(".xterm")
        // The tab strip, excluded the same way in accessibility.spec.ts.
        .exclude(".tabstrip")
        .analyze();
      const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      expect(summary, summary.join("\n")).toEqual([]);
    };
    await openApp(page, { recordings: true, theme });
    await recordingsPage(page);
    await expect(page.getByTestId("recordings").getByRole("listitem")).toHaveCount(3);
    await audit();
    await page.getByRole("button", { name: "Open recording of staging-web" }).click();
    await expect(page.getByTestId("log-player")).toContainText("pods ready");
    await audit();
  });
}

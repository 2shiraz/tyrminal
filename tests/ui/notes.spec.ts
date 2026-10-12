// P-30 notes in the UI: the Host details panel and the connection side panel. Negative cases
// first: markup in a note never becomes DOM, unsafe links are never clickable, images are never
// requested, and a code block reaches a session only through the paste review, never by running.
// Runs against the UI test mock; storage and encryption are tested in the core (tests/notes.rs).
import { type Page, expect, test } from "@playwright/test";

import { openApp, terminalText, waitForTerminalText } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

const HOSTILE = [
  "# Runbook",
  "",
  "<script>window.__pwned = 1</script>",
  '<img src="https://tracker.example/pixel.gif" onerror="window.__pwned = 2">',
  "[click me](javascript:window.__pwned=3) and [passwd](file:///etc/passwd)",
  "![rack photo](https://cdn.example/rack.png)",
  "See [the wiki](https://wiki.example/runbook) or <ssh://ops@bastion.example:2222>.",
  "",
  "```sh",
  "uptime",
  "```",
].join("\n");

async function openHost(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByTestId("host-list").getByRole("button", { name: label, exact: true }).click();
  return page.getByTestId("host-panel");
}

async function connectFromPalette(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/);
}

test("notes: markup, scripts, unsafe links and remote images stay inert in the host panel", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await openApp(page, { notes: { "host:api-gateway": { text: HOSTILE } } });
  const panel = await openHost(page, "api-gateway");
  const note = panel.locator(".note-view");
  await expect(note).toContainText("<script>window.__pwned = 1</script>");
  await expect(note).toContainText('<img src="https://tracker.example/pixel.gif"');

  // Nothing in the note became an element of its own, and nothing ran or was fetched.
  await expect(note.locator("script, img, iframe, svg, style, a, [href], [src], [onerror]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(requests.filter((u) => /tracker\.example|cdn\.example|wiki\.example/.test(u))).toEqual([]);

  // The image shows only its description; refused links are plain text, not buttons.
  await expect(note).toContainText("[image: rack photo]");
  await expect(note.getByRole("button")).toHaveText(["the wiki", "ssh://ops@bastion.example:2222"]);
  await expect(note.getByText("click me")).toBeVisible();
  // The host panel offers no way to send a code block anywhere.
  await expect(panel.getByRole("button", { name: "Paste into session" })).toHaveCount(0);

  // A web link opens only after a click and a look at its destination.
  expect(await calls(page, "link_open")).toHaveLength(0);
  await note.getByRole("button", { name: "the wiki" }).click();
  const dialog = page.getByRole("dialog", { name: "Open this link?" });
  await expect(dialog.getByTestId("note-link-destination")).toHaveText("https://wiki.example/runbook");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await calls(page, "link_open")).toHaveLength(0);
  await note.getByRole("button", { name: "the wiki" }).click();
  await page.getByRole("dialog", { name: "Open this link?" }).getByRole("button", { name: "Open in browser" }).click();
  expect((await calls(page, "link_open")).map((c) => c.args.url)).toEqual(["https://wiki.example/runbook"]);

  // An ssh link never connects: it only offers to add the server as a host, prefilled.
  await note.getByRole("button", { name: "ssh://ops@bastion.example:2222" }).click();
  const ssh = page.getByRole("dialog", { name: "Add this server as a host?" });
  await expect(ssh).toContainText("bastion.example");
  await ssh.getByRole("button", { name: "Add as host…" }).click();
  const editor = page.getByRole("dialog", { name: "Add host" });
  await expect(editor.getByLabel("Address")).toHaveValue("bastion.example");
  expect(await calls(page, "session_open_ssh")).toHaveLength(0);
  expect(await calls(page, "host_save")).toHaveLength(0);
});

test("notes: written and saved in the host panel, group notes shown beneath", async ({ page }) => {
  await openApp(page, { notes: { "group:Production": { text: "Change freeze on **Fridays**." } } });
  const panel = await openHost(page, "api-gateway");
  await expect(panel.getByText("From group Production")).toBeVisible();
  await expect(panel.locator(".note-inherited strong")).toHaveText("Fridays");

  await panel.getByRole("button", { name: "Add note" }).click();
  const text = panel.getByRole("textbox", { name: "Note" });
  await expect(text).toBeFocused();
  await text.fill("Primary API. Logs: `journalctl -u api`");
  // An unsaved note counts as an unsaved change.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Keep editing" }).click();
  await panel.getByRole("button", { name: "Save note" }).click();
  await expect(panel.locator(".note-card code").first()).toHaveText("journalctl -u api");
  expect((await calls(page, "note_set")).map((c) => c.args)).toEqual([
    { target: { kind: "host", hostId: expect.any(String) }, note: { text: "Primary API. Logs: `journalctl -u api`", format: "markdown" } },
  ]);

  // Plain text shows Markdown characters as they are; deleting sends an empty note.
  await panel.getByRole("button", { name: "Edit note" }).click();
  await panel.getByRole("radio", { name: "Plain text" }).check({ force: true });
  await panel.getByRole("button", { name: "Save note" }).click();
  await expect(panel.locator(".note-plain")).toHaveText("Primary API. Logs: `journalctl -u api`");
  await panel.getByRole("button", { name: "Edit note" }).click();
  await panel.getByRole("button", { name: "Delete note" }).click();
  await expect(panel.getByRole("button", { name: "Add note" })).toBeVisible();
  expect((await calls(page, "note_set")).at(-1)?.args.note).toBeNull();
});

test("notes: a code block is pasted into the session only through the paste review, never run", async ({ page }) => {
  await openApp(page, {
    renderer: "compatibility",
    notes: {
      "host:api-gateway": { text: "Check:\n\n```\necho from-note\n```\n\nTwo lines:\n\n```\necho a\necho b\n```" },
      "group:Production": { text: "<b>bold?</b>" },
    },
  });
  await connectFromPalette(page, "api-gateway");
  await waitForTerminalText(page, "deploy@api-gateway");
  await page.locator(".statusbar").getByRole("button", { name: "Notes" }).click();
  const side = page.getByRole("complementary", { name: "Host notes" });
  await expect(side.locator("h3")).toHaveText(["api-gateway", "From group Production"]);
  await expect(side).toContainText("<b>bold?</b>");

  const writes = (await calls(page, "session_write")).length;
  const blocks = side.getByRole("button", { name: "Paste into session" });
  await expect(blocks).toHaveCount(2);

  // Cancel in the review sends nothing.
  await blocks.first().click();
  const review = page.getByRole("dialog", { name: /Paste/ });
  await expect(review.locator("pre")).toHaveText("echo from-note");
  await review.getByRole("button", { name: "Cancel" }).click();
  expect((await calls(page, "session_write")).length).toBe(writes);

  // Pasting types the block without pressing Enter: nothing runs.
  await blocks.first().click();
  await page.getByRole("dialog", { name: /Paste/ }).getByRole("button", { name: "Paste" }).click();
  await waitForTerminalText(page, "echo from-note");
  await page.waitForTimeout(300);
  expect(await terminalText(page)).not.toContain("from-note: synthetic output");

  // A block of several lines is reviewed with its line count, like any multi-line paste.
  await blocks.nth(1).click();
  await expect(page.getByRole("dialog", { name: /Paste/ })).toContainText("2 lines");
});

test("notes: the side panel says when the session has no saved host or no notes", async ({ page }) => {
  await openApp(page);
  await connectFromPalette(page, "edge-cache");
  await page.locator(".statusbar").getByRole("button", { name: "Notes" }).click();
  await expect(page.getByRole("complementary", { name: "Host notes" })).toContainText("This host and its groups have no notes.");
});

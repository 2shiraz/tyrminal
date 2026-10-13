// Optimistic vault edits (docs/design/interaction-polish.md, section 1): moving hosts to a group
// and adding or removing a tag show at once and roll back with an inline error when the vault
// refuses. Deleting is never optimistic. Mock backend; UI evidence only.
import { type Page, expect, test } from "@playwright/test";

import { uiModifier, openApp, openSelectionMenu, selectionAction } from "./fixtures";

type MockWindow = { __mockDelay: Record<string, number>; __mockFailNext: Record<string, unknown> };

async function openHosts(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

const list = (page: Page) => page.getByTestId("host-list");
const card = (page: Page, name: string) => list(page).getByRole("article", { name });

async function selectTwo(page: Page) {
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click({ modifiers: [uiModifier] });
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click({ modifiers: [uiModifier] });
}

async function addTag(page: Page, tag: string) {
  await openSelectionMenu(page);
  await page.getByRole("menuitem", { name: "Add tag…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add tag" });
  await dialog.getByLabel("Tag").fill(tag);
  await dialog.getByRole("button", { name: "Save" }).click();
}

test("optimistic: a new tag shows at once, before the vault answers", async ({ page }) => {
  await openHosts(page);
  await page.evaluate(() => {
    (window as unknown as MockWindow).__mockDelay = { host_bulk: 1500 };
  });
  await selectTwo(page);
  await addTag(page, "urgent");
  // Shown while the call is still running, marked as saving.
  await expect(card(page, "edge-cache").locator(".tag", { hasText: "urgent" })).toBeVisible({ timeout: 500 });
  await expect(card(page, "staging-web")).toHaveAttribute("data-pending", "true");
  // Then confirmed by the vault.
  await expect(page.getByText("2 hosts changed")).toBeVisible();
  await expect(card(page, "staging-web")).not.toHaveAttribute("data-pending", /.*/);
  await expect(card(page, "staging-web").locator(".tag", { hasText: "urgent" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("optimistic: a refused move rolls back exactly and says so inline", async ({ page }) => {
  await openHosts(page);
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    w.__mockDelay = { host_bulk: 600 };
    w.__mockFailNext = { host_bulk: { code: "IO_ERROR", message: "The vault could not be written." } };
  });
  await selectTwo(page);
  await selectionAction(page, "Move to group…");
  const dialog = page.getByRole("dialog", { name: "Move to group" });
  await dialog.getByRole("combobox").selectOption({ label: "Lab" });
  await dialog.getByRole("button", { name: "Save" }).click();
  // Moved at once…
  await expect(card(page, "edge-cache").locator(".tag-group", { hasText: "Lab" })).toBeVisible({ timeout: 500 });
  // …and back when the vault refuses, with the reason next to the list and the selection kept for a retry.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("That change to 2 hosts was not saved, so they are back as they were.");
  await expect(alert).toContainText("The vault could not be written.");
  await expect(card(page, "edge-cache").locator(".tag-group")).toHaveCount(0);
  await expect(card(page, "staging-web").locator(".tag-group")).toHaveCount(0);
  await expect(card(page, "edge-cache")).not.toHaveAttribute("data-pending", /.*/);
  // The selection comes back for a retry.
  await expect(card(page, "edge-cache")).toHaveAttribute("data-selected", "true");
  await expect(card(page, "staging-web")).toHaveAttribute("data-selected", "true");
  // Nothing changed in the vault.
  const stored = await page.evaluate(() =>
    (window as unknown as { __mockState: { hosts: { label: string; groupId: string | null }[] } }).__mockState.hosts.filter((h) => ["edge-cache", "staging-web"].includes(h.label)).map((h) => h.groupId),
  );
  expect(stored).toEqual([null, null]);
});

test("optimistic: a refused tag removal puts the tag back", async ({ page }) => {
  await openHosts(page);
  await page.evaluate(() => {
    (window as unknown as MockWindow).__mockFailNext = { host_bulk: { code: "IO_ERROR", message: "The vault could not be written." } };
  });
  // The strip shows from two hosts on: api-gateway (tagged web) and staging-web (no tags).
  await list(page).getByRole("button", { name: "api-gateway", exact: true }).click({ modifiers: [uiModifier] });
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click({ modifiers: [uiModifier] });
  await openSelectionMenu(page);
  await page.getByRole("menuitem", { name: "Remove tag…" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove tag" });
  await dialog.getByLabel("Tag").fill("web");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("That change to 2 hosts was not saved, so they are back as they were.");
  await expect(card(page, "api-gateway").locator(".tag")).toHaveText(["Production", "prod", "web"]);
});

test("optimistic: never for deletes — hosts stay until the vault confirms", async ({ page }) => {
  await openHosts(page);
  await page.evaluate(() => {
    (window as unknown as MockWindow).__mockDelay = { host_bulk: 800 };
  });
  await selectTwo(page);
  await selectionAction(page, "Delete 2 hosts…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  // Still listed while the call runs.
  await expect(card(page, "edge-cache")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(card(page, "edge-cache")).toBeVisible();
  await expect(card(page, "edge-cache")).toHaveCount(0);
});

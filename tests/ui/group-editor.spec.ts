// The group editor saves as you go, like the Host details panel: per-field validation, a group
// created on its first valid name, undo that restores the record exactly, the route defaults as
// one unit written before the group's basics, and a proxy password written only by its button.
// Runs against the UI test mock; group storage and loops are tested in the core.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

type Call = { cmd: string; args: unknown };
const allCalls = (page: Page) => page.evaluate(() => (window as unknown as { __mockCalls: Call[] }).__mockCalls);
const calls = async (page: Page, cmd: string) => (await allCalls(page)).filter((x) => x.cmd === cmd);
const count = (page: Page, cmd: string) => async () => (await calls(page, cmd)).length;
const storedGroup = (page: Page, name: string) =>
  page.evaluate((n) => structuredClone((window as unknown as { __mockState: { groups: { name: string }[] } }).__mockState.groups.find((g) => g.name === n)), name);

async function openHosts(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).first().click();
}

async function editGroup(page: Page, name: string) {
  await page.getByRole("button", { name: `Actions for group ${name}` }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  return page.getByRole("dialog", { name: "Edit group" });
}

test("an invalid group field is never stored; the valid ones save", async ({ page }) => {
  await openHosts(page);
  const group = await editGroup(page, "Lab");
  await group.getByLabel("Name", { exact: true }).fill("Lab/2");
  await group.getByLabel("Port").fill("99999");
  await group.getByLabel("User name").fill("ops");
  await expect(group.getByText("Enter a name without “/”.")).toBeVisible();
  await expect(group.getByText("1–65535")).toBeVisible();
  await expect.poll(count(page, "group_save")).toBe(1);
  expect((await calls(page, "group_save"))[0]?.args).toMatchObject({ group: { name: "Lab", port: null, username: "ops" } });
  expect(JSON.stringify(await calls(page, "group_save"))).not.toContain("Lab/2");
  await expect(group.getByTestId("group-editor-status")).toHaveText(/Saved|^$/);
});

test("a new group is created on its first valid name; closing with none creates nothing", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "New group" }).click();
  let dialog = page.getByRole("dialog", { name: "New group" });
  await dialog.getByLabel("Name", { exact: true }).fill("a/b");
  await page.waitForTimeout(600);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "group_save")).toHaveLength(0);

  await page.getByRole("button", { name: "Actions for group Production" }).click();
  await page.getByRole("menuitem", { name: "New group" }).click();
  dialog = page.getByRole("dialog", { name: "New group" });
  await dialog.getByLabel("Name", { exact: true }).fill("Web");
  await expect.poll(count(page, "group_save")).toBe(1);
  expect((await calls(page, "group_save"))[0]?.args).toMatchObject({ group: { id: null, name: "Web" } });
  const edited = page.getByRole("dialog", { name: "Edit group" });
  await edited.getByLabel("User name").fill("www");
  await expect.poll(count(page, "group_save")).toBe(2);
  expect((await calls(page, "group_save"))[1]?.args).toMatchObject({ group: { id: expect.any(String), name: "Web", username: "www" } });
  await edited.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("group-bar").getByRole("button", { name: "› Web", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("group undo restores the previous record exactly", async ({ page }) => {
  await openHosts(page);
  const before = await storedGroup(page, "Databases");
  const group = await editGroup(page, "Databases");
  await group.getByLabel("Name", { exact: true }).fill("DBs");
  await group.getByLabel("Port").fill("5022");
  await group.getByRole("heading", { name: "Edit group" }).click();
  await expect.poll(count(page, "group_save")).toBe(2);
  await group.getByLabel("Port").focus();
  // The port field has nothing unsaved: Ctrl+Z undoes the last write, then the one before.
  await page.keyboard.press("Control+z");
  await expect.poll(count(page, "group_save")).toBe(3);
  await group.getByRole("button", { name: "Undo the last change" }).click();
  await expect.poll(count(page, "group_save")).toBe(4);
  await expect.poll(() => storedGroup(page, "Databases")).toEqual(before);
  await expect(group.getByLabel("Name", { exact: true })).toHaveValue("Databases");
});

test("group route defaults are one unit, written before the basics; the proxy password only on request", async ({ page }) => {
  await openHosts(page);
  const group = await editGroup(page, "Lab");
  const section = group.getByTestId("group-defaults");
  await section.locator("summary").click();
  await section.getByRole("combobox", { name: "Proxy" }).selectOption("socks5");
  await group.getByLabel("User name", { exact: true }).fill("labuser");
  await expect.poll(count(page, "group_save")).toBe(1);
  // The proxy has no host yet: the route waits (the icon could still save on its own).
  expect(await calls(page, "group_defaults_set")).toHaveLength(0);
  await section.getByLabel("Proxy host").fill("socks.lab.example");
  await section.getByLabel("Proxy port").fill("1080");
  await section.getByLabel("Proxy user name").fill("ops");
  await group.getByLabel("Port", { exact: true }).fill("2200");
  await expect.poll(count(page, "group_save")).toBe(2);
  const order = (await allCalls(page)).map((c) => c.cmd).filter((c) => c === "group_save" || c === "group_defaults_set");
  // Every route write carries the complete proxy, and comes before the basics it was saved with.
  for (const set of await calls(page, "group_defaults_set")) {
    expect(set.args).toMatchObject({ defaults: { proxy: { kind: "socks5", host: "socks.lab.example", port: 1080, password: null } } });
  }
  expect(order.at(-2)).toBe("group_defaults_set");
  expect(order.at(-1)).toBe("group_save");

  await section.getByLabel("Proxy password").fill("canary-group-proxy");
  await page.waitForTimeout(600);
  expect(JSON.stringify(await allCalls(page))).not.toContain("canary-group-proxy");
  await section.getByLabel("Proxy password").press("Enter");
  await expect.poll(async () => JSON.stringify(await calls(page, "group_defaults_set")).split("canary-group-proxy").length).toBe(2);
  await expect(section.getByLabel("Proxy password")).toHaveValue("");
  expect(await page.content()).not.toContain("canary-group-proxy");
});

test("closing the group editor with a typed, unset proxy password asks first", async ({ page }) => {
  await openHosts(page);
  const group = await editGroup(page, "Lab");
  const section = group.getByTestId("group-defaults");
  await section.locator("summary").click();
  await section.getByRole("combobox", { name: "Proxy" }).selectOption("http");
  await section.getByLabel("Proxy host").fill("proxy.lab.example");
  await section.getByLabel("Proxy port").fill("3128");
  await section.getByLabel("Proxy user name").fill("ops");
  await section.getByLabel("Proxy password").fill("canary-unset");
  await group.getByRole("button", { name: "Done" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Discard the password you typed?" });
  await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(section.getByLabel("Proxy password")).toHaveValue("canary-unset");
  await group.getByRole("button", { name: "Done" }).click();
  await confirm.getByRole("button", { name: "Discard password" }).click();
  await expect(group).toHaveCount(0);
  expect(JSON.stringify(await allCalls(page))).not.toContain("canary-unset");
});

test("closing the group editor with note changes asks about the note", async ({ page }) => {
  await openHosts(page);
  const group = await editGroup(page, "Lab");
  await group.getByRole("button", { name: "Add note" }).click();
  await group.getByRole("textbox", { name: "Note" }).fill("Lab hardware lives in rack 3");
  await group.getByRole("button", { name: "Done" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Discard your note changes?" });
  await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(group.getByRole("textbox", { name: "Note" })).toHaveValue("Lab hardware lives in rack 3");
  await group.getByRole("button", { name: "Done" }).click();
  await confirm.getByRole("button", { name: "Discard note changes" }).click();
  await expect(group).toHaveCount(0);
  expect(await calls(page, "note_set")).toHaveLength(0);
});

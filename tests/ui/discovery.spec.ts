// LAN discovery (HST-14) against the UI test mock: nothing is sent until Start, announced names
// are shown as text, adding a result only prefills the host editor. Real DNS-SD browsing against a
// responder is tested in crates/core/tests/discovery_lab.rs. The mock never makes a row VERIFIED.

import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

import { type MockOptions, openApp } from "./fixtures";

const callsOf = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function openDiscovery(page: Page, options: MockOptions = {}) {
  await openApp(page, options);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Find on network…" }).click();
  const dialog = page.getByRole("dialog", { name: "Find SSH servers on a network" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("nothing is sent before Start; results are text; adding one only prefills the editor", async ({ page }) => {
  const dialog = await openDiscovery(page);
  await expect(dialog.getByLabel("Network")).toHaveValue("en0");
  await expect(dialog.getByRole("option", { name: "en0 (192.0.2.20, fe80::1)" })).toBeAttached();
  await expect(dialog.getByRole("status")).toHaveText("Not started.");
  expect(await callsOf(page, "discovery_start")).toHaveLength(0);

  const axe = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);

  await dialog.getByRole("button", { name: "Start" }).click();
  expect((await callsOf(page, "discovery_start")).map((c) => c.args.networkId)).toEqual(["en0"]);
  const results = dialog.getByRole("list", { name: "Servers found" });
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("status")).toHaveText(/Listening… \d+ s left/);
  // An announced name that looks like markup is only text.
  await expect(results.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  await expect(dialog.locator("img")).toHaveCount(0);
  await expect(results.getByText("nas.local · 192.0.2.40 port 2222")).toBeVisible();
  await expect(dialog.getByText(/Any computer on the network can announce any name/)).toBeVisible();

  await results.getByRole("button", { name: "Add Build server as a host" }).click();
  await expect(dialog).toBeHidden();
  // Closing the dialog stops listening.
  await expect.poll(async () => (await callsOf(page, "discovery_stop")).length).toBe(1);
  const editor = page.getByRole("dialog").filter({ has: page.getByLabel("Address") });
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Build server");
  await expect(editor.getByLabel("Address")).toHaveValue("192.0.2.30");
  await expect(editor.getByLabel("Port")).toHaveValue("22");
  await editor.getByRole("button", { name: "Cancel" }).click();
  expect(await callsOf(page, "host_save")).toHaveLength(0);
});

test("Stop ends listening and a finished browse keeps its results", async ({ page }) => {
  const dialog = await openDiscovery(page);
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog.getByRole("list", { name: "Servers found" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByLabel("Network")).toBeDisabled();
  await dialog.getByRole("button", { name: "Stop" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Finished. 2 servers found.");
  await expect(dialog.getByRole("button", { name: "Start" })).toBeEnabled();
  await expect(dialog.getByRole("list", { name: "Servers found" }).getByRole("listitem")).toHaveCount(2);

  // A browse whose time ran out is reported as finished too.
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog.getByRole("status")).toHaveText(/Listening/);
  await expect(dialog.getByRole("list", { name: "Servers found" }).getByRole("listitem")).toHaveCount(2);
  await page.evaluate(() => (window as unknown as { __mockDiscoveryFinish: () => void }).__mockDiscoveryFinish());
  await expect(dialog.getByRole("status")).toHaveText("Finished. 2 servers found.");
});

test("without a connected network nothing can start", async ({ page }) => {
  const dialog = await openDiscovery(page, { discoveryNetworks: [] });
  await expect(dialog.getByText("No connected network was found on this computer.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  expect(await callsOf(page, "discovery_stop")).toHaveLength(0);
});

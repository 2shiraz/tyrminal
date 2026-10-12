// Telnet and serial hosts in the Host details panel. The protocols themselves are tested
// natively in crates/core/tests/protocols.rs (a real Telnet server; a pseudo-terminal pair).
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function addHost(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await page.getByRole("button", { name: "Add host" }).click();
  return page.getByRole("complementary", { name: "New host" });
}

test("protocols: a Telnet host warns that nothing is encrypted and stores no credentials", async ({ page }) => {
  const dialog = await addHost(page);
  await dialog.getByLabel("Name", { exact: true }).fill("old switch");
  await dialog.getByRole("combobox", { name: "Protocol" }).selectOption("telnet");
  await expect(dialog.getByText(/Telnet is not encrypted/)).toBeVisible();
  // No user name or sign-in method: the device's own login prompt asks.
  await expect(dialog.getByLabel("User name")).toHaveCount(0);
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(dialog.getByLabel("Port")).toHaveValue("23");
  await dialog.getByLabel("Address").fill("192.0.2.40");
  // Encoding and terminal type are under "Show more".
  await dialog.getByText("Show more").click();
  await dialog.getByRole("combobox", { name: "Character encoding" }).selectOption("koi8-r");
  await dialog.getByRole("combobox", { name: "Terminal type" }).selectOption("vt100");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const saves = await calls(page, "host_save");
  expect(saves.at(-1)?.args).toMatchObject({
    host: {
      address: "192.0.2.40",
      port: 23,
      username: "",
      auth: { kind: "ask_password" },
      protocol: { type: "telnet" },
      terminal: { encoding: "koi8-r", term: "vt100" },
    },
  });
});

test("protocols: a serial host picks a device and line settings", async ({ page }) => {
  const dialog = await addHost(page);
  await dialog.getByLabel("Name", { exact: true }).fill("router console");
  await dialog.getByRole("combobox", { name: "Protocol" }).selectOption("serial");
  await expect(dialog.getByLabel("Address")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await dialog.getByLabel("Serial port").fill("/dev/ttyUSB0");
  await dialog.getByRole("combobox", { name: "Speed (baud)" }).selectOption("9600");
  await dialog.getByRole("combobox", { name: "Parity" }).selectOption("even");
  await dialog.getByRole("combobox", { name: "Flow control" }).selectOption("hardware");
  // A serial line has no terminal type to report.
  await dialog.getByText("Show more").click();
  await expect(dialog.getByRole("combobox", { name: "Terminal type" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const saves = await calls(page, "host_save");
  expect(saves.at(-1)?.args).toMatchObject({
    host: {
      address: "/dev/ttyUSB0",
      port: null,
      protocol: { type: "serial", settings: { path: "/dev/ttyUSB0", baud: 9600, dataBits: 8, parity: "even", stopBits: 1, flowControl: "hardware" } },
    },
  });
});

test("protocols: notices from Tyrminal show in the session, not only inside a password prompt", async ({ page }) => {
  // Regression: the Telnet warning and "the server used your forwarded key" arrived as server
  // banners, which the terminal shows only inside a password dialog, so nobody saw them.
  const dialog = await addHost(page);
  await dialog.getByLabel("Name", { exact: true }).fill("old switch");
  await dialog.getByRole("combobox", { name: "Protocol" }).selectOption("telnet");
  await dialog.getByLabel("Address").fill("192.0.2.40");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Connect to old switch" }).first().click();
  await expect(page.getByText("Telnet is not encrypted: anything you type here")).toBeVisible();
});

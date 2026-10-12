// P-33: container shells on the connected host, against the UI test mock. The listing, the ID
// checks and stopping with the session are tested against a real engine in
// crates/core/tests/containers_lab.rs and inventory_lab.rs. The mock never makes a row VERIFIED.

import { type Page, expect, test } from "@playwright/test";

import { connectHost, openApp, waitForTerminalText } from "./fixtures";

const callsOf = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const setContainers = (page: Page, list: unknown) => page.evaluate((l) => ((window as unknown as { __mockContainers: unknown }).__mockContainers = l), list);

async function connected(page: Page) {
  await openApp(page, { renderer: "compatibility" });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await connectHost(page, "api-gateway");
  await waitForTerminalText(page, "deploy@api-gateway");
}

async function openContainers(page: Page) {
  await page.getByRole("button", { name: "Search or run a command" }).click();
  await page.getByRole("combobox", { name: /Type a command/ }).fill("containers");
  await page.getByRole("option", { name: /Containers on this host/ }).click();
  return page.getByRole("dialog", { name: "Containers on api-gateway" });
}

test("running containers are listed as plain text and a shell opens in a new tab", async ({ page }) => {
  await connected(page);
  const dialog = await openContainers(page);
  const table = dialog.getByRole("table", { name: "Running containers" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(dialog.getByText("Engine: Docker")).toBeVisible();
  // Server text stays text: no element is created from it and nothing runs.
  await expect(table.getByRole("cell", { name: "<img src=x onerror=window.__pwned=1>", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "evil/<b>bold</b>", exact: true })).toBeVisible();
  await expect(dialog.locator("img")).toHaveCount(0);
  await expect(dialog.locator("b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(dialog.getByText("1 entry was not shown.")).toBeVisible();

  const sessionId = (await callsOf(page, "containers_list")).at(-1)?.args.sessionId;
  const tabsBefore = await page.getByRole("tab").count();
  await dialog.getByRole("button", { name: "Open a shell in web" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(tabsBefore + 1);
  await expect(page.getByRole("tab", { name: /web \(container\)/ })).toBeVisible();
  await expect.poll(async () => (await callsOf(page, "container_session_open")).length).toBe(1);
  const opened = (await callsOf(page, "container_session_open")).at(-1)?.args;
  // Only the session, the engine and the full ID go to the native side.
  expect(opened).toMatchObject({
    sessionId,
    engine: "docker",
    containerId: "4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a",
  });
  expect(Object.keys(opened ?? {}).sort()).toEqual(["cols", "containerId", "engine", "events", "output", "rows", "sessionId"]);
});

test("no engine, an engine error and an empty list are each said plainly", async ({ page }) => {
  await connected(page);
  await setContainers(page, { engine: null, containers: [], problem: null, skipped: 0 });
  let dialog = await openContainers(page);
  await expect(dialog.getByText("Neither Docker nor Podman was found on this host.")).toBeVisible();
  await expect(dialog.getByRole("table")).toHaveCount(0);

  // The engine's own error, as it is (the app never retries with more privilege).
  await setContainers(page, {
    engine: "docker",
    containers: [],
    problem: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
    skipped: 0,
  });
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The container engine reported:");
  await expect(dialog.getByTestId("container-problem")).toHaveText(
    "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
  );
  await dialog.getByRole("button", { name: "Close" }).click();

  await setContainers(page, { engine: "podman", containers: [], problem: null, skipped: 0 });
  dialog = await openContainers(page);
  await expect(dialog.getByText("Engine: Podman")).toBeVisible();
  await expect(dialog.getByText("No containers are running.")).toBeVisible();
});

test("containers are offered only for a connected SSH session", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+Shift+T");
  await page.getByRole("button", { name: "Search or run a command" }).click();
  await page.getByRole("combobox", { name: /Type a command/ }).fill("containers");
  await expect(page.getByRole("option", { name: /Containers on this host/ })).toHaveCount(0);
});

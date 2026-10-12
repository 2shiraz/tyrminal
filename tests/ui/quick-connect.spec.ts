// Quick connect from the Hosts search against the UI test mock: an address that matches no saved
// host opens a new tab at once, and its pane shows the setup (protocol, user, sign-in) with the
// connection track; no modal dialog. "Continue" connects in that pane without saving anything;
// "Continue & Save" saves the host and the pane becomes that host's. Closing the tab cancels. The
// core path is covered by the sessions_lab quick_connect tests against the real OpenSSH lab.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";
import { connectHeld } from "./session-events";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: Record<string, unknown> }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
const field = (page: Page) => page.getByRole("searchbox", { name: "Search hosts" });
/** Types into the Hosts search and waits for the core's search to answer (no host matches). */
async function search(page: Page, text: string) {
  const before = (await calls(page, "host_search")).length;
  await field(page).fill(text);
  // The search is debounced: wait for this query's answer, then a frame for its render, so a
  // missing offer means the text was refused rather than not yet searched.
  await expect.poll(async () => (await calls(page, "host_search")).slice(before).some((c) => c.args.query === text.trim())).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText("No hosts match")).toBeVisible();
}
/** The setup, in the new tab's pane (a region of the pane, not a dialog). */
const sheet = (page: Page, address: string) => page.locator(".terminal-pane:not([hidden])").getByRole("region", { name: `Connect to ${address}` });
const trackOf = (page: Page, scope: string) =>
  page.locator(`.terminal-pane:not([hidden]) ${scope} [data-testid="connect-track"] .track-stop`).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-stage")}:${e.getAttribute("data-state")}`));
const stops = (page: Page) => trackOf(page, ".quick-connect-sheet");
/** The connection's own stops, still to come while the setup runs. */
const ahead = ["resolve:pending", "connect:pending", "verify:pending", "auth:pending", "shell:pending"];
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(name.replaceAll(".", "\\.")) });
/** Session tabs (the strip also holds the Hosts tab). */
const sessionTabs = (page: Page) => page.getByRole("tab").filter({ hasNotText: /^Hosts$/ });
const hosts = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();

test("an address offers quick connect only when no saved host matches", async ({ page }) => {
  await openApp(page);
  const offer = page.getByRole("button", { name: /^Connect to .*…$/ });
  for (const address of ["198.51.100.7", "198.51.100.7:2200", "db.example.org", "ops@db.example.org:2200", "2001:db8::5", "[2001:db8::5]:2200", "backup01"]) {
    await search(page, address);
    await expect(offer, address).toHaveText(`Connect to ${address}…`);
  }
  // A saved host's name finds the host, not a new connection.
  await field(page).fill("api-gateway");
  await expect(page.locator('[data-testid="host-list"]')).toContainText("api-gateway");
  await expect(offer).toHaveCount(0);
  for (const text of ["ssh://db.example.org", "not an address", "db.example.org/path", "300.1.1.1"]) {
    await search(page, text);
    await expect(offer, text).toHaveCount(0);
  }
});

test("an ssh command line opens the sheet with its user and port; options it cannot honour do not", async ({ page }) => {
  await openApp(page);
  const offer = page.getByRole("button", { name: /^Connect to .*…$/ });
  for (const [text, shown] of [
    ["ssh ops@db.example.org -p 2222", "ops@db.example.org:2222"],
    ["ssh -p2222 -l ops db.example.org", "ops@db.example.org:2222"],
    ["ssh -p 2200 2001:db8::5", "[2001:db8::5]:2200"],
    ["ssh backup01", "backup01"],
  ]) {
    await search(page, text as string);
    await expect(offer, text).toHaveText(`Connect to ${shown}…`);
  }
  for (const text of ["ssh -i id_ed25519 db.example.org", "ssh db.example.org:2222", "ssh -l ops root@db.example.org", "ssh -p 70000 db.example.org", "ssh a.example.org b.example.org", "ssh -p"]) {
    await search(page, text);
    await expect(offer, text).toHaveCount(0);
  }

  await search(page, "ssh ops@db.example.org -p 2222");
  await page.keyboard.press("Enter");
  const dialog = sheet(page, "db.example.org");
  await expect(dialog.getByLabel("SSH port", { exact: true })).toHaveValue("2222");
  await expect(dialog.getByTestId("quick-preview-ssh")).toHaveText("Will run: ssh ops@db.example.org -p 2222");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByLabel("User name")).toHaveValue("ops");
});

test("quick connect opens a tab at once and sets up in its pane; Continue connects there without saving", async ({ page }) => {
  await openApp(page);
  await search(page, "198.51.100.7");
  await page.keyboard.press("Enter");
  // A new tab named after the address, like a saved host's, and no modal dialog anywhere.
  await expect(tab(page, "198.51.100.7")).toHaveAttribute("aria-selected", "true");
  const setup = sheet(page, "198.51.100.7");
  await expect(setup).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls(page, "session_open_quick")).toHaveLength(0);
  await expect.poll(() => stops(page)).toEqual(["protocol:waiting", "user:pending", "signIn:pending", ...ahead]);

  // Protocol: SSH on 22 by default; the preview follows the port.
  await expect(setup.getByRole("radio", { name: /SSH/ })).toBeChecked();
  await expect(setup.getByTestId("quick-preview-ssh")).toHaveText("Will run: ssh 198.51.100.7");
  const sshPort = setup.getByLabel("SSH port", { exact: true });
  await sshPort.fill("2200");
  await expect(setup.getByTestId("quick-preview-ssh")).toHaveText("Will run: ssh 198.51.100.7 -p 2200");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();

  // User: required before going on.
  await expect.poll(() => stops(page)).toEqual(["protocol:done", "user:waiting", "signIn:pending", ...ahead]);
  const next = setup.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeDisabled();
  await setup.getByLabel("User name").fill("ops");
  await next.click();

  // Sign-in: a typed password, used once.
  await expect.poll(() => stops(page)).toEqual(["protocol:done", "user:done", "signIn:waiting", ...ahead]);
  await setup.getByLabel("Password", { exact: true }).fill("s3cret-once");
  await connectHeld(page, () => setup.getByRole("button", { name: "Continue", exact: true }).click());

  // The same pane connects: the track carries on past the setup into the connection's steps.
  await expect(setup).toHaveCount(0);
  await page.clock.runFor(27); // verifying_host
  await expect(page.getByRole("dialog", { name: "Connecting to 198.51.100.7" })).toBeVisible();
  await expect.poll(() => trackOf(page, ".connection-sheet")).toEqual(["protocol:done", "user:done", "signIn:done", "resolve:done", "connect:done", "verify:now", "auth:pending", "shell:pending"]);
  await page.clock.resume();
  const opened = await calls(page, "session_open_quick");
  expect(opened).toHaveLength(1);
  expect(opened[0]?.args.input).toEqual({ protocol: "ssh", address: "198.51.100.7", port: 2200, username: "ops", auth: { kind: "password", password: "s3cret-once" } });
  expect(await calls(page, "host_save")).toHaveLength(0);
  await expect(sessionTabs(page)).toHaveCount(1);
});

test("a key from the keychain is never chosen for you; Continue & Save makes the tab the saved host's", async ({ page }) => {
  await openApp(page);
  await search(page, "ops@db.example.org");
  await page.keyboard.press("Enter");
  const setup = sheet(page, "db.example.org");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(setup.getByLabel("User name")).toHaveValue("ops");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();

  await setup.getByRole("radio", { name: /A key from the keychain/ }).check();
  const key = setup.getByRole("combobox", { name: "Choose a key" });
  await expect(key).toHaveValue("");
  await expect(setup.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await key.selectOption({ label: "Deploy key (ssh-ed25519)" });

  await setup.getByRole("button", { name: "More ways to continue" }).click();
  await page.getByRole("menuitem", { name: "Continue & Save" }).click();
  await expect(setup).toHaveCount(0);
  const saves = await calls(page, "host_save");
  expect(saves).toHaveLength(1);
  expect(saves[0]?.args.host).toEqual(expect.objectContaining({ address: "db.example.org", port: 22, username: "ops", auth: { kind: "key", keyId: expect.any(String) }, protocol: { type: "ssh" } }));
  // The same tab, now the saved host's, connects the normal way.
  await expect.poll(async () => (await calls(page, "session_open_ssh")).length).toBe(1);
  expect(await calls(page, "session_open_quick")).toHaveLength(0);
  await expect(sessionTabs(page)).toHaveCount(1);
  await expect(tab(page, "db.example.org")).toBeVisible();
});

test("a saved identity fills the user and the sign-in", async ({ page }) => {
  await openApp(page, { identities: [{ id: "a".repeat(31) + "1", label: "Ops team", username: "ops", password: "pw", keyId: null }] });
  await search(page, "10.0.4.12");
  await page.keyboard.press("Enter");
  const setup = sheet(page, "10.0.4.12");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("textbox", { name: "Search identities" }).fill("ops");
  await setup.getByRole("option", { name: /Ops team/ }).click();
  await expect(setup.getByLabel("User name")).toHaveValue("ops");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(setup.getByRole("radio", { name: "Identity Ops team" })).toBeChecked();
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await calls(page, "session_open_quick")).length).toBe(1);
  const opened = await calls(page, "session_open_quick");
  expect(opened[0]?.args.input).toEqual(expect.objectContaining({ username: "ops", auth: { kind: "identity", identityId: "a".repeat(31) + "1" } }));
});

test("Telnet connects without a user or sign-in step, and warns that nothing is encrypted", async ({ page }) => {
  await openApp(page);
  await search(page, "192.0.2.40");
  await page.keyboard.press("Enter");
  const setup = sheet(page, "192.0.2.40");
  await setup.getByRole("radio", { name: /Telnet/ }).check();
  await expect(setup).toContainText("Not encrypted");
  await expect(setup.getByTestId("quick-preview-telnet")).toHaveText("Will run: telnet 192.0.2.40");
  await expect.poll(() => stops(page)).toEqual(["protocol:waiting", "connect:pending"]);
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await calls(page, "session_open_quick")).length).toBe(1);
  const opened = await calls(page, "session_open_quick");
  expect(opened[0]?.args.input).toEqual(expect.objectContaining({ protocol: "telnet", address: "192.0.2.40", port: 23 }));
  await expect(page.getByText("Telnet is not encrypted").first()).toBeVisible();
});

test("Escape or Close closes the tab without connecting or saving; quick connects run in parallel tabs", async ({ page }) => {
  await openApp(page);
  await search(page, "198.51.100.9");
  await page.keyboard.press("Enter");
  await expect(sheet(page, "198.51.100.9")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionTabs(page)).toHaveCount(0);

  // Two at once, each in its own tab; closing one leaves the other.
  await hosts(page);
  await search(page, "198.51.100.9");
  await page.keyboard.press("Enter");
  await expect(sheet(page, "198.51.100.9")).toBeVisible();
  await hosts(page);
  await search(page, "198.51.100.10");
  await page.keyboard.press("Enter");
  await expect(sheet(page, "198.51.100.10")).toBeVisible();
  await expect(sessionTabs(page)).toHaveCount(2);
  await sheet(page, "198.51.100.10").getByRole("button", { name: "Close" }).click();
  await expect(sessionTabs(page)).toHaveCount(1);
  await tab(page, "198.51.100.9").click();
  await expect(sheet(page, "198.51.100.9")).toBeVisible();
  expect(await calls(page, "session_open_quick")).toHaveLength(0);
  expect(await calls(page, "host_save")).toHaveLength(0);
});

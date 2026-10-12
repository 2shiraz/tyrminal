// Host details panel on the Hosts view: opening and closing, focus, autosave (per-field
// validation, debounce, undo, the route as one unit, creating a new host), the write-only
// password that is set on purpose and never autosaved, and the full-width layout at narrow
// widths. Runs against the UI test mock; host validation and storage are tested in the core.

import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

type Call = { cmd: string; args: unknown };
const allCalls = (page: Page) => page.evaluate(() => (window as unknown as { __mockCalls: Call[] }).__mockCalls);
const calls = async (page: Page, cmd: string) => (await allCalls(page)).filter((x) => x.cmd === cmd);
const count = (page: Page, cmd: string) => async () => (await calls(page, cmd)).length;
const storedHost = (page: Page, label: string) =>
  page.evaluate((l) => structuredClone((window as unknown as { __mockState: { hosts: { label: string }[] } }).__mockState.hosts.find((h) => h.label === l)), label);
const storedHostById = (page: Page, id: string) =>
  page.evaluate((i) => structuredClone((window as unknown as { __mockState: { hosts: { id: string }[] } }).__mockState.hosts.find((h) => h.id === i)), id);

async function openHosts(page: Page) {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

const panel = (page: Page) => page.getByTestId("host-panel");
const details = (page: Page) => page.getByRole("complementary", { name: "Host details" });
const list = (page: Page) => page.getByTestId("host-list");
const status = (page: Page) => panel(page).getByTestId("host-panel-status");
/** Everything valid in the panel is stored and nothing is waiting. */
const settled = (page: Page) => expect(panel(page)).toHaveAttribute("data-autosave", "clean");
const undoKey = "Control+z";

// ---- Negative tests first: what autosave must never do. ----

test("autosave never sends a secret: a password is written only by Set password (or Enter), once", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByRole("radio", { name: /Store a password in the vault/ }).check();
  const password = details(page).getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await password.fill("canary-ui-host-secret");
  // Other edits around it autosave; the typed password and the unusable sign-in stay out.
  await details(page).getByLabel("Tags").fill("web");
  await details(page).getByLabel("Name", { exact: true }).focus();
  await expect.poll(count(page, "host_save")).toBe(1);
  await settled(page);
  let saves = await calls(page, "host_save");
  expect(JSON.stringify(saves)).not.toContain("canary-ui-host-secret");
  expect(saves[0]?.args).toMatchObject({ host: { tags: ["web"], auth: { kind: "ask_password" } } });
  await expect(password).toHaveValue("canary-ui-host-secret");

  // Set password: one write that carries it, then the field is empty again and the page holds no copy.
  await details(page).getByRole("button", { name: "Set password" }).click();
  await expect.poll(count(page, "host_save")).toBe(2);
  saves = await calls(page, "host_save");
  expect(saves[1]?.args).toMatchObject({ host: { auth: { kind: "stored_password", password: "canary-ui-host-secret" } } });
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("type", "password");
  await expect(details(page).getByText("A password is stored. Type a new one and press Set password to replace it.")).toBeVisible();
  expect(await page.content()).not.toContain("canary-ui-host-secret");

  // Later autosaves keep the stored password without ever resending it.
  await details(page).getByLabel("Name", { exact: true }).fill("staging-web-2");
  await expect.poll(count(page, "host_save")).toBe(3);
  saves = await calls(page, "host_save");
  expect(saves[2]?.args).toMatchObject({ host: { label: "staging-web-2", auth: { kind: "stored_password", password: null } } });

  // Enter in the field sets a new one, also exactly once.
  await password.fill("canary-ui-second-secret");
  await page.waitForTimeout(600);
  expect(JSON.stringify(await calls(page, "host_save"))).not.toContain("canary-ui-second-secret");
  await password.press("Enter");
  await expect.poll(count(page, "host_save")).toBe(4);
  const all = JSON.stringify(await calls(page, "host_save"));
  expect(all.split("canary-ui-second-secret")).toHaveLength(2);
  await expect(password).toHaveValue("");
});

test("an invalid field is shown inline and never stored; the valid fields around it still save", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByLabel("Port").fill("70000");
  await details(page).getByLabel("Address").fill("user@stg.example.net");
  await details(page).getByLabel("User name").fill("-oProxyCommand=x");
  await details(page).getByLabel("Name", { exact: true }).fill("staging-web-2");
  await expect(details(page).getByText("1–65535")).toBeVisible();
  await expect(details(page).getByText("Enter a host name or an IP address, without a scheme, user or path.")).toBeVisible();
  await expect(details(page).getByText("No spaces, control characters or leading hyphen.")).toBeVisible();
  await expect(details(page).getByLabel("Port")).toHaveAttribute("aria-invalid", "true");

  await expect.poll(count(page, "host_save")).toBe(1);
  await settled(page);
  const [save] = await calls(page, "host_save");
  // The name saved; the invalid port, address and user name kept their stored values.
  expect(save?.args).toMatchObject({ host: { label: "staging-web-2", port: 22, address: "stg.example.net", username: "www" } });
  await expect(list(page).getByRole("button", { name: "staging-web-2", exact: true })).toBeVisible();

  // Fixing a field saves it.
  await details(page).getByLabel("Port").fill("2200");
  await expect.poll(count(page, "host_save")).toBe(2);
  expect((await calls(page, "host_save"))[1]?.args).toMatchObject({ host: { port: 2200, address: "stg.example.net" } });
  expect(JSON.stringify(await calls(page, "host_save"))).not.toContain("70000");
  expect(JSON.stringify(await calls(page, "host_save"))).not.toContain("oProxyCommand");
});

test("undo restores the previous record exactly, from the keyboard or the status", async ({ page }) => {
  await openHosts(page);
  const before = await storedHost(page, "api-gateway");
  const id = (before as { id: string }).id;
  await list(page).getByRole("button", { name: "api-gateway", exact: true }).click();
  // Leaving each field saves it: three writes, each its own undo step.
  await details(page).getByLabel("Name", { exact: true }).fill("api-gateway-renamed");
  await details(page).getByLabel("Tags").fill("prod, web, edge");
  await details(page).getByLabel("Port").fill("2022");
  await details(page).getByRole("heading", { name: "Host details" }).focus();
  await expect.poll(count(page, "host_save")).toBe(3);
  await settled(page);
  await expect(panel(page).getByRole("button", { name: "Undo the last change" })).toBeVisible();
  expect(await storedHostById(page, id)).toMatchObject({ label: "api-gateway-renamed", port: 2022, tags: ["edge", "prod", "web"] });

  // Ctrl+Z (Cmd+Z on macOS) in the panel steps back one write at a time.
  await page.keyboard.press(undoKey);
  await expect.poll(count(page, "host_save")).toBe(4);
  await settled(page);
  expect(await storedHostById(page, id)).toMatchObject({ label: "api-gateway-renamed", port: 22, tags: ["edge", "prod", "web"] });
  await expect(details(page).getByLabel("Port")).toHaveValue("22");
  await page.keyboard.press(undoKey);
  await page.keyboard.press(undoKey);
  await expect.poll(count(page, "host_save")).toBe(6);
  await settled(page);
  // Exactly the record as it was, every field.
  expect(await storedHostById(page, id)).toEqual(before);
  await expect(details(page).getByLabel("Name", { exact: true })).toHaveValue("api-gateway");
  await expect(details(page).getByLabel("Tags")).toHaveValue("prod, web");
  // Undo steps are not undoable themselves: nothing is left.
  await expect(panel(page).getByRole("button", { name: "Undo the last change" })).toHaveCount(0);

  // The status's Undo does the same.
  await details(page).getByLabel("Name", { exact: true }).fill("api-2");
  await expect.poll(count(page, "host_save")).toBe(7);
  await settled(page);
  await panel(page).getByRole("button", { name: "Undo the last change" }).click();
  await expect.poll(count(page, "host_save")).toBe(8);
  await settled(page);
  expect(await storedHostById(page, id)).toEqual(before);
});

test("undo is offered for 10 s only", async ({ page }) => {
  await openHosts(page);
  await page.clock.install({ time: new Date("2026-10-11T12:00:00Z") });
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByLabel("Tags").fill("web");
  await page.clock.runFor(500);
  await expect.poll(count(page, "host_save")).toBe(1);
  const undo = panel(page).getByRole("button", { name: "Undo the last change" });
  await expect(undo).toBeVisible();
  await page.clock.runFor(10_500);
  await expect(undo).toHaveCount(0);
  await details(page).getByRole("heading", { name: "Host details" }).focus();
  await page.keyboard.press(undoKey);
  await page.clock.runFor(1_000);
  expect(await calls(page, "host_save")).toHaveLength(1);
});

test("a key sign-in without a chosen key is never saved, and autosave never picks a key", async ({ page }) => {
  await openHosts(page);
  const usesKey = async () => (await calls(page, "host_save")).filter((c) => (c.args as { host: { auth: { kind: string } } }).host.auth.kind === "key");
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByRole("radio", { name: /Use a key from the keychain/ }).check();
  const select = details(page).getByRole("combobox", { name: "Choose a key" });
  await expect(select).toHaveValue("");
  await expect(details(page).getByText("Choose a key. Until you do, the host keeps its current sign-in.")).toBeVisible();
  await expect(select).toHaveAttribute("aria-invalid", "true");
  // Other edits save; the sign-in stays as stored, and no key is chosen for the user.
  await details(page).getByLabel("Tags").fill("web");
  await details(page).getByLabel("Name", { exact: true }).focus();
  await expect.poll(count(page, "host_save")).toBe(1);
  await settled(page);
  expect((await calls(page, "host_save"))[0]?.args).toMatchObject({ host: { tags: ["web"], auth: { kind: "ask_password" } } });
  expect(await usesKey()).toHaveLength(0);
  await expect(select).toHaveValue("");

  // A new host too: created with its own sign-in, never with a key nobody chose.
  await page.getByRole("button", { name: "Add host" }).click();
  await panel(page).getByRole("radio", { name: /Use a key from the keychain/ }).check();
  await panel(page).getByLabel("Address").fill("198.51.100.8");
  await panel(page).getByLabel("Name", { exact: true }).focus();
  await expect.poll(count(page, "host_save")).toBe(2);
  await settled(page);
  expect((await calls(page, "host_save"))[1]?.args).toMatchObject({ host: { address: "198.51.100.8", auth: { kind: "ask_password" } } });
  expect(await usesKey()).toHaveLength(0);

  // Choosing a key saves it.
  await panel(page).getByRole("combobox", { name: "Choose a key" }).selectOption({ label: "Deploy key (ssh-ed25519)" });
  await expect.poll(async () => (await usesKey()).length).toBe(1);
  await expect(panel(page).getByText("Choose a key. Until you do, the host keeps its current sign-in.")).toHaveCount(0);
});

test("the jump host and proxy are one unit: saved once valid, never half, before the host's basics", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByText("Show more").click();
  // A proxy without its host is not a valid route: the name still saves, the route waits.
  await details(page).getByRole("combobox", { name: "Proxy" }).selectOption("socks5");
  await details(page).getByRole("combobox", { name: "Jump host" }).selectOption({ label: "api-gateway" });
  await details(page).getByLabel("Name", { exact: true }).fill("staging-web-2");
  await expect.poll(count(page, "host_save")).toBe(1);
  await settled(page);
  await expect(details(page).getByText("The jump host and proxy are saved together once every part is valid.")).toBeVisible();
  expect(await calls(page, "host_connection_set")).toHaveLength(0);

  // Port first: still not valid (no proxy host). Then the host: one write with every part.
  await details(page).getByLabel("Proxy port").fill("1080");
  await page.waitForTimeout(600);
  expect(await calls(page, "host_connection_set")).toHaveLength(0);
  await details(page).getByLabel("Proxy host").fill("socks.lab.example");
  await details(page).getByLabel("Tags").fill("web");
  await expect.poll(count(page, "host_connection_set")).toBe(1);
  await settled(page);
  const [route] = await calls(page, "host_connection_set");
  expect(route?.args).toMatchObject({
    connection: { jumpHostId: expect.any(String), proxy: { kind: "socks5", host: "socks.lab.example", port: 1080, username: "", password: null }, inherit: false },
  });
  // The order of an existing host: route, then basics (a refused route changes nothing else).
  const order = (await allCalls(page)).map((c) => c.cmd).filter((c) => c === "host_save" || c === "host_connection_set");
  expect(order.slice(-2)).toEqual(["host_connection_set", "host_save"]);
});

test("a refused route leaves the host unchanged and offers Retry", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "db-primary", exact: true }).click();
  await details(page).getByText("Show more").click();
  await details(page).getByRole("combobox", { name: "Jump host" }).selectOption({ label: "api-gateway" });
  await expect.poll(count(page, "host_connection_set")).toBe(1);
  await settled(page);
  await list(page).getByRole("button", { name: "api-gateway", exact: true }).click();
  await details(page).getByText("Show more").click();
  await details(page).getByRole("combobox", { name: "Jump host" }).selectOption({ label: "db-primary" });
  await details(page).getByLabel("Tags").fill("loop");
  await expect(status(page)).toHaveText("Couldn't save –");
  await expect(details(page).getByRole("alert")).toContainText("would form a loop");
  // Nothing of the batch was stored: the basics come after the route.
  expect((await storedHost(page, "api-gateway") as { tags: string[] }).tags).toEqual(["prod", "web"]);
  // Fix the route; Retry is not needed, the next edit saves.
  await details(page).getByRole("combobox", { name: "Jump host" }).selectOption({ label: "None (connect directly)" });
  await settled(page);
  expect((await storedHost(page, "api-gateway") as { tags: string[] }).tags).toEqual(["loop"]);
});

test("a failed write says so and Retry writes it", async ({ page }) => {
  await openHosts(page);
  await page.evaluate(() => {
    (window as unknown as { __mockFailNext: Record<string, number> }).__mockFailNext = { host_save: 1 };
  });
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByLabel("Tags").fill("web");
  await expect(status(page)).toHaveText("Couldn't save –");
  await expect(panel(page)).toHaveAttribute("data-autosave", "error");
  await panel(page).getByRole("button", { name: "Retry" }).click();
  await settled(page);
  expect((await storedHost(page, "staging-web") as { tags: string[] }).tags).toEqual(["web"]);
});

test("a new host is created on its first valid address, never from an invalid one", async ({ page }) => {
  await openHosts(page);
  const add = page.getByRole("button", { name: "Add host" });
  await add.click();
  const fresh = page.getByRole("complementary", { name: "New host" });
  await expect(fresh.getByLabel("Address")).toBeFocused();
  await expect(fresh.getByText("Enter an address to save this host. Everything you change is saved as you go.")).toBeVisible();
  // Only Connect: no Save, Cancel or "Save and connect".
  await expect(fresh.getByRole("button", { name: /Save|Cancel/ })).toHaveCount(0);
  await expect(fresh.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();

  for (const bad of ["user@198.51.100.7", "ssh://198.51.100.7", "a b", "-oProxyCommand=x"]) {
    await fresh.getByLabel("Address").fill(bad);
    await fresh.getByLabel("Name", { exact: true }).focus();
  }
  await page.waitForTimeout(600);
  expect(await calls(page, "host_save")).toHaveLength(0);
  await expect(fresh.getByText("Enter a host name or an IP address, without a scheme, user or path.")).toBeVisible();

  // Closing with nothing valid creates nothing.
  await fresh.getByRole("button", { name: "Close host details" }).click();
  await expect(fresh).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(await calls(page, "host_save")).toHaveLength(0);

  // A valid address creates the host (named after it); later edits update the same host.
  await add.click();
  await page.getByRole("complementary", { name: "New host" }).getByLabel("Address").fill("198.51.100.7");
  await expect.poll(count(page, "host_save")).toBe(1);
  await settled(page);
  expect((await calls(page, "host_save"))[0]?.args).toMatchObject({ host: { id: null, label: "198.51.100.7", address: "198.51.100.7", port: 22 } });
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByLabel("Address")).toBeFocused();
  await expect(details(page).getByRole("button", { name: "Host details actions" })).toBeVisible();
  await details(page).getByLabel("Name", { exact: true }).fill("lab-box");
  await expect.poll(count(page, "host_save")).toBe(2);
  const [created, renamed] = await calls(page, "host_save");
  expect((renamed?.args as { host: { id: string } }).host.id).toEqual(expect.any(String));
  expect((created?.args as { host: { id: null } }).host.id).toBeNull();
  await expect(list(page).getByRole("button", { name: "lab-box", exact: true })).toBeVisible();
});

test("a new host's route is written right after the host is created", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Add host" }).click();
  const fresh = page.getByRole("complementary", { name: "New host" });
  await fresh.getByText("Show more").click();
  await fresh.getByRole("combobox", { name: "Jump host" }).selectOption({ label: "api-gateway" });
  await page.waitForTimeout(600);
  expect(await calls(page, "host_connection_set")).toHaveLength(0);
  await fresh.getByLabel("Address").fill("10.20.0.99");
  await expect.poll(count(page, "host_connection_set")).toBe(1);
  const order = (await allCalls(page)).map((c) => c.cmd).filter((c) => c === "host_save" || c === "host_connection_set");
  expect(order).toEqual(["host_save", "host_connection_set"]);
});

test("debounce: typing saves once, 400 ms after the last change; leaving the field saves at once", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  const name = details(page).getByLabel("Name", { exact: true });
  await name.fill("");
  await name.pressSequentially("stage-two", { delay: 60 });
  // Within the debounce window nothing has been written yet.
  expect(await calls(page, "host_save")).toHaveLength(0);
  await expect(status(page)).toHaveText("");
  await expect.poll(count(page, "host_save")).toBe(1);
  expect((await calls(page, "host_save"))[0]?.args).toMatchObject({ host: { label: "stage-two" } });
  await expect(status(page)).toHaveText("Saved");
  // "Saved" fades, then the status is empty.
  await expect(status(page)).toHaveText("", { timeout: 5_000 });

  // Blur: no waiting for the debounce.
  await details(page).getByLabel("Tags").fill("web");
  await page.keyboard.press("Tab");
  await expect.poll(count(page, "host_save"), { timeout: 350 }).toBe(2);
});

test("a stored password is not dropped by an autosave: switching away waits for Remove", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await details(page).getByRole("radio", { name: /Ask for the password each time/ }).check();
  await details(page).getByLabel("Tags").fill("cache");
  await expect.poll(count(page, "host_save")).toBe(1);
  await settled(page);
  // The tag saved; the sign-in stayed the stored password.
  expect((await calls(page, "host_save"))[0]?.args).toMatchObject({ host: { tags: ["cache"], auth: { kind: "stored_password", password: null } } });
  await expect(details(page).getByText(/removes the stored password from the vault/)).toBeVisible();
  await details(page).getByRole("button", { name: "Remove stored password" }).click();
  await expect.poll(count(page, "host_save")).toBe(2);
  expect((await calls(page, "host_save"))[1]?.args).toMatchObject({ host: { auth: { kind: "ask_password" } } });
  await expect(details(page).getByText(/removes the stored password from the vault/)).toHaveCount(0);
});

test("leaving with a typed but unset password asks first; Keep editing is the default", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "db-primary", exact: true }).click();
  await details(page).getByRole("radio", { name: /Store a password in the vault/ }).check();
  await details(page).getByLabel("Password", { exact: true }).fill("canary-typed-not-set");

  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog", { name: "Discard the password you typed?" });
  await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(details(page).getByLabel("Password", { exact: true })).toHaveValue("canary-typed-not-set");

  // Switching host asks too; discarding switches, and nothing carried the password.
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await confirm.getByRole("button", { name: "Discard password" }).click();
  await expect(details(page).getByLabel("Address")).toHaveValue("203.0.113.24");
  expect(JSON.stringify(await allCalls(page))).not.toContain("canary-typed-not-set");

  // Other edits never ask: they are already saved.
  await details(page).getByLabel("Tags").fill("edge");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  await expect.poll(async () => ((await storedHost(page, "edge-cache")) as { tags: string[] }).tags).toEqual(["edge"]);
});

// ---- The panel itself. ----

test("clicking a host opens its details beside the list; Escape closes and focus returns", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByLabel("Address")).toBeFocused();
  await expect(details(page).getByLabel("Address")).toHaveValue("203.0.113.24");
  await expect(details(page).getByLabel("Name", { exact: true })).toHaveValue("edge-cache");
  await expect(panel(page).getByTestId("host-panel-location")).toHaveText("Local vault");
  // The cards, top to bottom.
  await expect(panel(page).locator("h3")).toHaveText(["General", "Protocol", "Credentials", "Notes"]);
  await expect(panel(page).getByText("Show more")).toBeVisible();
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toHaveAttribute("aria-current", "true");
  // The primary button is always Connect.
  await expect(panel(page).getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await expect(panel(page).getByRole("button", { name: /Save|Cancel/ })).toHaveCount(0);

  // The list stays usable: another host opens in the same panel.
  await list(page).getByRole("article", { name: "api-gateway" }).locator(".host-card-dest").click();
  await expect(details(page).getByLabel("Address")).toHaveValue("10.20.0.11");
  await expect(panel(page).getByTestId("host-panel-location")).toHaveText("Local vault · Production");

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toBeFocused();
  expect(await calls(page, "host_save")).toHaveLength(0);
});

test("closing right after an edit still saves it", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByLabel("Tags").fill("web");
  await details(page).getByRole("button", { name: "Close host details" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => ((await storedHost(page, "staging-web")) as { tags: string[] }).tags).toEqual(["web"]);
});

test("the menu copies the address, duplicates, and deletes after confirmation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openHosts(page);
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  const menu = details(page).getByRole("button", { name: "Host details actions" });

  await menu.click();
  await page.getByRole("menuitem", { name: "Copy address" }).click();
  await expect(page.getByText("Address copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("203.0.113.24");

  await menu.click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Created “edge-cache (copy)”")).toBeVisible();

  await menu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete “edge-cache”?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add host" })).toBeFocused();
  expect(await calls(page, "host_delete")).toHaveLength(1);
});

test("a new host connects from the bottom button once it exists", async ({ page }) => {
  await openHosts(page);
  await page.getByRole("button", { name: "Add host" }).click();
  // The panel is renamed "Host details" once the host exists, so address it by its test id.
  await panel(page).getByLabel("Address").fill("198.51.100.7");
  await panel(page).getByLabel("Name", { exact: true }).fill("lab-box");
  await panel(page).getByLabel("User name").fill("tester");
  await panel(page).getByRole("radio", { name: /Ask for the password each time/ }).check();
  await panel(page).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("tab", { name: /lab-box/ })).toBeVisible();
  const saves = await calls(page, "host_save");
  expect(saves.at(-1)?.args).toMatchObject({ host: { label: "lab-box", username: "tester", auth: { kind: "ask_password" } } });
  // One host, created once and then updated.
  expect(saves.filter((s) => (s.args as { host: { id: string | null } }).host.id === null)).toHaveLength(1);
});

test("at a narrow width the panel takes the whole view and the list behind it is inert", async ({ page }) => {
  await openHosts(page);
  await page.setViewportSize({ width: 820, height: 760 });
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  const layout = page.locator(".hosts-layout");
  await expect(layout).toHaveAttribute("data-narrow", "true");
  const [box, outer] = await Promise.all([panel(page).boundingBox(), layout.boundingBox()]);
  expect(box?.width).toBeCloseTo(outer?.width ?? 0, 0);
  await expect(page.locator(".hosts-main")).toHaveAttribute("inert", "");
  // Tab stays inside the panel (the list is inert).
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".hosts-main"))).toBe(false);
  }
  await details(page).getByRole("button", { name: "Close host details" }).click();
  await expect(page.locator(".hosts-main")).not.toHaveAttribute("inert", "");
  await expect(list(page).getByRole("button", { name: "edge-cache", exact: true })).toBeFocused();

  // Wide again: side by side.
  await page.setViewportSize({ width: 1360, height: 860 });
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  await expect(layout).toHaveAttribute("data-narrow", "false");
  const wide = await panel(page).boundingBox();
  expect(wide?.width).toBe(400);
});

test("Show more holds the terminal settings and, for a key sign-in, agent forwarding (off by default)", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "api-gateway", exact: true }).click();
  await details(page).getByText("Show more").click();
  const forward = details(page).getByRole("switch", { name: /agent forwarding/ });
  await expect(forward).not.toBeChecked();
  await forward.click();
  await details(page).getByRole("combobox", { name: "Character encoding" }).selectOption("iso8859-1");
  await expect.poll(async () => (await calls(page, "host_save")).at(-1)?.args).toMatchObject({
    host: { protocol: { type: "ssh" }, forwardAgent: true, terminal: { encoding: "iso8859-1" } },
  });

  // A password sign-in has nothing to forward: the switch is not offered.
  await details(page).getByRole("radio", { name: /Ask for the password each time/ }).check();
  await expect(details(page).getByRole("switch", { name: /agent forwarding/ })).toHaveCount(0);
});

test("leaving with note changes asks about the note, not a password; with both it names both", async ({ page }) => {
  await openHosts(page);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByRole("button", { name: "Add note" }).click();
  await details(page).getByRole("textbox", { name: "Note" }).fill("Reboot window: Sundays");

  await page.keyboard.press("Escape");
  const note = page.getByRole("alertdialog", { name: "Discard your note changes?" });
  await expect(note).toContainText("Your changes to the note have not been saved.");
  await expect(note).not.toContainText("password");
  await expect(note.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await note.getByRole("button", { name: "Keep editing" }).click();
  await expect(details(page).getByRole("textbox", { name: "Note" })).toHaveValue("Reboot window: Sundays");

  // A typed password as well: the prompt names both.
  await details(page).getByRole("radio", { name: /Store a password in the vault/ }).check();
  await details(page).getByLabel("Password", { exact: true }).fill("canary-unset-both");
  await list(page).getByRole("button", { name: "edge-cache", exact: true }).click();
  const both = page.getByRole("alertdialog", { name: "Discard the password and note changes?" });
  await both.getByRole("button", { name: "Discard both" }).click();
  await expect(details(page).getByLabel("Address")).toHaveValue("203.0.113.24");
  expect(await calls(page, "note_set")).toHaveLength(0);
  expect(JSON.stringify(await allCalls(page))).not.toContain("canary-unset-both");
});

test("the port suggestions switch autosaves, even while the route is incomplete, and undo restores it", async ({ page }) => {
  await openHosts(page);
  const off = () => page.evaluate(() => [...(window as unknown as { __mockPortSuggestionsOff: Set<string> }).__mockPortSuggestionsOff]);
  await list(page).getByRole("button", { name: "staging-web", exact: true }).click();
  await details(page).getByText("Show more").click();
  const suggestions = details(page).getByRole("switch", { name: "Forwarding suggestions for this host" });
  await expect(suggestions).toBeChecked();

  // A proxy without its host: the route waits, the switch still saves (with the route as stored).
  await details(page).getByRole("combobox", { name: "Proxy" }).selectOption("socks5");
  await suggestions.click();
  await expect.poll(async () => (await off()).length).toBe(1);
  await settled(page);
  const [set] = await calls(page, "host_connection_set");
  expect(set?.args).toMatchObject({ connection: { noPortSuggestions: true, proxy: null, jumpHostId: null } });

  // Undo puts the switch back on and stores it.
  await details(page).getByRole("heading", { name: "Host details" }).focus();
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await off()).length).toBe(0);
  await settled(page);
  await expect(suggestions).toBeChecked();
});

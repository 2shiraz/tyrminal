// Group defaults for route and icon (HST-05) against the UI test mock: a group sets a jump host
// and an icon, its hosts and subgroups show what they inherit and from where, and a host can set
// its own route instead. Real connections through an inherited jump host are tested in
// crates/core/tests/tunnels_lab.rs.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);

async function editGroup(page: Page, name: string) {
  await page.getByRole("button", { name: `Actions for group ${name}` }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  return page.getByRole("dialog", { name: "Edit group" });
}

async function editHost(page: Page, label: string) {
  await page.getByRole("button", { name: `More actions for ${label}` }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  return page.getByRole("dialog", { name: /Edit host/ });
}

test("a group's jump host and icon reach its hosts and subgroups; a host can set its own route", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).first().click();

  const group = await editGroup(page, "Production");
  const section = group.getByTestId("group-defaults");
  await section.locator("summary").click();
  await section.getByRole("combobox", { name: "Jump host" }).selectOption({ label: "build-runner-03" });
  await section.getByRole("combobox", { name: "Icon" }).selectOption({ label: "Debian" });
  await group.getByRole("button", { name: "Save" }).click();
  await expect(group).toHaveCount(0);
  expect((await calls(page, "group_defaults_set")).at(-1)!.args).toMatchObject({ defaults: { os: "debian", proxy: null } });

  // The subgroup shows what its hosts get from Production.
  const sub = await editGroup(page, "Databases");
  await expect(sub.getByTestId("group-defaults")).toContainText("Without a route here, hosts use Production's: through build-runner-03.");
  await expect(sub.getByTestId("group-defaults")).toContainText("Without an icon here, hosts show Production's: Debian.");
  await sub.getByRole("button", { name: "Cancel" }).click();

  // A host in the group uses the group's route, and says where it comes from.
  let host = await editHost(page, "api-gateway");
  await expect(host.getByRole("radio", { name: /Use the group's route/ })).toBeChecked();
  await expect(host.getByTestId("route-inherited")).toHaveText("From Production: through build-runner-03");
  await expect(host.getByRole("combobox", { name: "Jump host" })).toHaveCount(0);
  // Setting its own route (directly) is saved before the host's basics.
  await host.getByRole("radio", { name: /Set a route for this host/ }).check();
  await expect(host.getByRole("combobox", { name: "Jump host" })).toHaveValue("");
  await host.getByRole("button", { name: "Save" }).click();
  await expect(host).toHaveCount(0);
  expect((await calls(page, "host_connection_set")).at(-1)!.args).toMatchObject({ connection: { inherit: false, jumpHostId: null } });

  host = await editHost(page, "api-gateway");
  await expect(host.getByRole("radio", { name: /Set a route for this host/ })).toBeChecked();
  // And back to the group's.
  await host.getByRole("radio", { name: /Use the group's route/ }).check();
  await host.getByRole("button", { name: "Save" }).click();
  expect((await calls(page, "host_connection_set")).at(-1)!.args).toMatchObject({ connection: { inherit: true } });

  // The icon of a host in the subgroup is the inherited Debian one.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Home/ }).first().click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).first().click();
  await expect(page.getByTestId("host-list").getByRole("article", { name: /db-primary/ }).locator('[data-os="debian"]')).toHaveCount(1);
});

// Layout regressions uncovered by the redesign baseline, with real rendered bounds.
import { type Page, expect, test } from "@playwright/test";
import { connectHost, openApp, openSettings } from "./fixtures";

const hosts = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Hosts/ }).click();
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

for (const theme of ["dark", "light"] as const) {
  test(`redesign: ${theme} minimum window keeps changed-key warning and actions reachable`, async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 620 });
    await openApp(page, { theme, hostsLayout: "list", hostKeyChangedFor: "staging-web" });
    await hosts(page);
    await connectHost(page, "staging-web");
    const warning = page.getByRole("alert").filter({ hasText: "This server's identity has changed" });
    await expect(warning).toBeVisible();
    const title = warning.getByRole("heading", { name: "This server's identity has changed" });
    // Severity must be visible immediately even while the safe Close tab action has focus.
    expect((await title.boundingBox())?.y).toBeGreaterThanOrEqual(0);
    await title.scrollIntoViewIfNeeded();
    const titleBox = await title.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(titleBox?.y).toBeGreaterThanOrEqual(0);
    expect((titleBox?.y ?? 0) + (titleBox?.height ?? 0)).toBeLessThanOrEqual(620);
    await expect(warning.getByTestId("connect-fingerprint")).toHaveCount(2);
    const close = warning.getByRole("button", { name: "Close tab" });
    await close.scrollIntoViewIfNeeded();
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox?.y).toBeGreaterThanOrEqual(0);
    expect((closeBox?.y ?? 0) + (closeBox?.height ?? 0)).toBeLessThanOrEqual(620);
    await noOverflow(page);
    await close.click();
    await expect(warning).toHaveCount(0);
  });

  test(`redesign: ${theme} host title and switch hint are separate before settings loads`, async ({ page }) => {
    await openApp(page, { theme, hostsLayout: "list" });
    await hosts(page);
    const title = page.getByRole("heading", { name: "Hosts", level: 1 });
    await expect(title).toBeVisible();
    expect((await title.boundingBox())?.height).toBeGreaterThan(10);
    await page.getByRole("button", { name: "New host" }).click();
    const editor = page.getByRole("complementary", { name: "New host" });
    const row = editor.locator(".switch-row").filter({ has: page.getByText("Production host", { exact: true }) });
    const labelBox = await row.getByText("Production host", { exact: true }).boundingBox();
    const hintBox = await row.locator(".hint").boundingBox();
    expect(labelBox).not.toBeNull();
    expect(hintBox).not.toBeNull();
    expect(hintBox?.y).toBeGreaterThanOrEqual((labelBox?.y ?? 0) + (labelBox?.height ?? 0));
    await noOverflow(page);
  });
}

test("redesign: 500-host minimum library stays windowed through theme change and search", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 620 });
  await openApp(page, { theme: "dark", hostsLayout: "list", extraHosts: 494 });
  await hosts(page);
  const list = page.getByTestId("host-list");
  await expect(list).toHaveAttribute("data-windowed", "true");
  await expect(list.getByRole("button", { name: "api-gateway", exact: true })).toBeVisible();
  expect(await list.getByRole("button").count()).toBeLessThan(100);
  await noOverflow(page);
  await page.getByRole("button", { name: "Switch light / dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(list).toHaveAttribute("data-windowed", "true");
  await page.getByRole("searchbox", { name: "Search hosts" }).fill("bulk-host-494");
  await expect(list.getByRole("button", { name: "bulk-host-494", exact: true })).toBeVisible();
  await noOverflow(page);
});

// Owner report (2026-10-14): Hosts showed a horizontal scrollbar. Invisible tooltips of buttons
// near the right edge counted as content; a page must never be wider than its pane.
for (const layout of ["list", "grid"] as const) {
  test(`redesign: Hosts (${layout}) never scrolls sideways, at any window size or with a tooltip showing`, async ({ page }) => {
    const pageOverflow = () =>
      page.locator(".hosts-main").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, left: el.scrollLeft, overflowX: getComputedStyle(el).overflowX }));
    for (const [width, height] of [[1920, 1080], [1360, 860], [1100, 700], [820, 620]] as const) {
      await page.setViewportSize({ width, height });
      await openApp(page, { hostsLayout: layout, extraHosts: 14 });
      await hosts(page);
      await expect(page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true })).toBeVisible();
      const idle = await pageOverflow();
      expect(idle.scroll, `${width}px wide`).toBeLessThanOrEqual(idle.client);
      await noOverflow(page);
    }
    // With a tooltip showing on the right-most button the page still cannot scroll sideways.
    await page.getByRole("button", { name: "New group" }).hover();
    await page.waitForTimeout(600);
    const shown = await pageOverflow();
    expect(shown.overflowX).toBe("hidden");
    expect(shown.left).toBe(0);
    // The host details panel open beside the list.
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.getByTestId("host-list").getByRole("button", { name: "api-gateway", exact: true }).click();
    await expect(page.getByTestId("host-panel")).toBeVisible();
    const beside = await pageOverflow();
    expect(beside.scroll).toBeLessThanOrEqual(beside.client);
    await noOverflow(page);
  });
}

// Owner report (2026-10-14): in a full-screen window every page but Hosts left the right side empty.
test("redesign: in a wide window pages and Settings use the width of their pane", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openApp(page, { hostsLayout: "list" });
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const [name, heading] of [[/^Snippets/, "Snippets"], [/^Tunnels/, "Tunnels"], [/^Keychain/, "Keychain"], [/^Known hosts/, "Known hosts"]] as const) {
    await nav.getByRole("button", { name }).click();
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    const used = await page.evaluate(() => {
      const pane = document.querySelector(".content") as HTMLElement;
      const column = [...pane.querySelectorAll<HTMLElement>(".page-inner")].find((el) => el.offsetParent !== null) as HTMLElement;
      return column.getBoundingClientRect().width / pane.getBoundingClientRect().width;
    });
    expect(used, `${heading} column`).toBeGreaterThan(0.97);
    await noOverflow(page);
  }
  // Settings: its groups flow into two columns; none is split or cut off.
  await openSettings(page, "Terminal");
  const body = page.locator(".settings-section-body");
  await expect(body).toBeVisible();
  const wide = await body.evaluate((el) => {
    const pane = (el.closest(".settings-section") as HTMLElement).getBoundingClientRect();
    const groups = [...el.querySelectorAll<HTMLElement>(":scope > *")].map((g) => g.getBoundingClientRect());
    return { rightmost: Math.max(...groups.map((g) => g.right)) / pane.right, lefts: new Set(groups.map((g) => Math.round(g.left))).size, cut: groups.some((g) => g.right > pane.right + 0.5) };
  });
  expect(wide.rightmost).toBeGreaterThan(0.95);
  expect(wide.lefts).toBeGreaterThan(1);
  expect(wide.cut).toBe(false);
  await noOverflow(page);
  // A window of ordinary width keeps the single column.
  await page.setViewportSize({ width: 1200, height: 800 });
  expect(await body.evaluate((el) => new Set([...el.querySelectorAll<HTMLElement>(":scope > .settings-group, :scope > .box")].map((g) => Math.round(g.getBoundingClientRect().left))).size)).toBeLessThanOrEqual(1);
  await noOverflow(page);
});

// Found in the real WebView: at the minimum window a row's fixed control column was wider than its
// group, so the group could be scrolled sideways and the theme cards touched its edge.
test("redesign: at the minimum window no Settings group is wider than its pane", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 620 });
  await openApp(page);
  for (const section of ["Appearance", "Terminal", "Vault and unlock", "Privacy"]) {
    await openSettings(page, section);
    await expect(page.locator(".settings-section-body")).toBeVisible();
    const wide = await page.locator(".settings-section").evaluate((pane) =>
      [...pane.querySelectorAll<HTMLElement>(".settings-group, .box")].filter((g) => g.scrollWidth > g.clientWidth + 1 || g.getBoundingClientRect().right > pane.getBoundingClientRect().right).map((g) => g.textContent?.slice(0, 30)),
    );
    expect(wide, section).toEqual([]);
    await noOverflow(page);
  }
});

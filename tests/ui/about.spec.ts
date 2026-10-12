// Version information: Settings → About, the sidebar version and the vault screens. Channel
// detection is a pure function and is tested without a browser.
import { type Page, expect, test } from "@playwright/test";

import { channelName, releaseChannel, versionLabel, versionReport } from "../../apps/desktop/src/lib/version";
import { openApp } from "./fixtures";

const INFO = { commit: "1a2b3c4", buildDate: "2026-10-12", os: "linux", arch: "x86_64", tauriVersion: "2.12.1", webviewVersion: "2.50.1" };

test("version: a SemVer pre-release suffix is the pre-release channel", () => {
  for (const v of ["0.1.0-beta.2", "v0.1.0-beta.2", "1.0.0-rc.1", "2.3.4-alpha", "1.0.0-0.3.7", "1.0.0-beta.1+exp.sha.5114f85"]) {
    expect(releaseChannel(v), v).toBe("prerelease");
  }
  for (const v of ["0.1.0", "v1.2.3", "1.0.0+20261012", "10.20.30"]) {
    expect(releaseChannel(v), v).toBe("release");
  }
  // Not a version at all: never claimed as a pre-release.
  for (const v of ["", "beta", "0.1-beta.1", "0.1.0-", "0.1.0-beta..1"]) {
    expect(releaseChannel(v), v).toBe("release");
  }
  expect(channelName("0.1.0-beta.2")).toBe("Pre-release");
  expect(channelName("0.1.0")).toBe("Release");
  expect(versionLabel("0.1.0-beta.2")).toBe("v0.1.0-beta.2");
  expect(versionLabel("v0.1.0")).toBe("v0.1.0");
});

test("version: the report holds the build and platform facts only", () => {
  expect(versionReport("0.1.0-beta.2", INFO)).toBe(
    "Tyrminal v0.1.0-beta.2\nChannel: Pre-release\nCommit: 1a2b3c4\nBuilt: 2026-10-12 (UTC)\nOS: linux x86_64\nTauri: 2.12.1\nWebView: 2.50.1\n",
  );
  expect(versionReport("0.1.0", { ...INFO, webviewVersion: null })).toContain("WebView: unknown");
  expect(versionReport("0.1.0", null)).toBe("Tyrminal v0.1.0\nChannel: Release\n");
});

/** Every name, address, user name, label, fingerprint and snippet text the mock vault holds. */
async function vaultStrings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = (window as unknown as { __mockState: Record<string, unknown> }).__mockState;
    const out = new Set<string>();
    const walk = (value: unknown) => {
      if (typeof value === "string") {
        if (value.length >= 3) out.add(value);
      } else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object" && !(value instanceof Map)) Object.values(value).forEach(walk);
    };
    for (const key of ["hosts", "groups", "keys", "knownHosts", "snippets"]) walk(state[key]);
    return [...out];
  });
}

test("about: build facts, copy for bug reports without host or vault data, links only on click", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();

  // About is the last section in the settings navigation.
  const nav = page.getByRole("navigation", { name: "Settings" }).getByRole("button");
  await expect(nav.last()).toHaveText("About");
  await nav.last().click();
  const about = page.locator("#settings-about");
  await expect(about.getByRole("heading", { name: "About" })).toBeInViewport();

  const facts = about.getByRole("definition");
  await expect(facts).toHaveText([/^Tyrminal v\d+\.\d+\.\d+/, /^(Pre-release|Release)$/, "1a2b3c4", "2026-10-12 (UTC)", "linux x86_64", "Tauri 2.12.1 · WebView 2.50.1"]);
  const version = ((await facts.first().textContent()) ?? "").replace("Tyrminal v", "");
  await expect(facts.nth(1)).toHaveText(releaseChannel(version) === "prerelease" ? "Pre-release" : "Release");

  // Nothing opens or is fetched until a link is clicked.
  const opened = () =>
    page.evaluate(() => (window as unknown as { __mockCalls: { cmd: string; args: { url?: string } }[] }).__mockCalls.filter((c) => c.cmd === "link_open").map((c) => c.args.url));
  expect(await opened()).toEqual([]);

  await page.getByRole("button", { name: "Copy version info" }).click();
  await expect(about.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(versionReport(version, INFO));
  // Only the listed fields: no host names, addresses, user names, key or snippet data.
  const secrets = await vaultStrings(page);
  expect(secrets.length).toBeGreaterThan(20);
  for (const value of secrets) expect(copied, value).not.toContain(value);
  expect(copied).not.toMatch(/\/home\/|\/Users\/|C:\\|@|\d+\.\d+\.\d+\.\d+/);

  await about.getByRole("button", { name: "Releases" }).click();
  await about.getByRole("button", { name: "Licence", exact: true }).click();
  await about.getByRole("button", { name: "Third-party licences" }).click();
  expect(await opened()).toEqual([
    "https://github.com/2shiraz/tyrminal/releases",
    "https://github.com/2shiraz/tyrminal/blob/main/LICENSE",
    "https://github.com/2shiraz/tyrminal/tree/main/third_party",
  ]);
});

test("about: the sidebar version opens Settings → About", async ({ page }) => {
  await openApp(page);
  const primary = page.getByRole("navigation", { name: "Primary" });
  const version = primary.getByRole("button", { name: /^Tyrminal v\d+\.\d+\.\d+\S*: open About$/ });
  await expect(version).toHaveText(/^v\d+\.\d+\.\d+/);
  await version.click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.locator("#settings-about").getByRole("heading", { name: "About" })).toBeInViewport();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "About" })).toHaveAttribute("aria-current", "page");

  // Opening Settings from the navigation afterwards starts at the top again.
  await primary.getByRole("button", { name: "Home" }).click();
  await primary.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
});

test("about: the vault screens show the version", async ({ page }) => {
  await openApp(page, { scenario: "locked" });
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await expect(page.getByText(/^Tyrminal v\d+\.\d+\.\d+\S*$/)).toBeVisible();

  const onboarding = await page.context().newPage();
  await openApp(onboarding, { scenario: "onboarding" });
  await expect(onboarding.getByText(/^Tyrminal v\d+\.\d+\.\d+\S*$/)).toBeVisible();
});

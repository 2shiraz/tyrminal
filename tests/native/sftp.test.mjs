// Native end-to-end test of the SFTP tab: the real application, a real vault and a real OpenSSH
// lab server. The host is opened for files only: the server must see the SFTP subsystem and no
// shell or terminal request.
//
//   pnpm lab:up && pnpm build:e2e && node --test tests/native/sftp.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { ui } from "./flows.mjs";
import { App, loadLab } from "./harness.mjs";

const lab = loadLab();

function serverLog(server) {
  const { container, logFile } = lab.servers[server];
  if (logFile) return readFileSync(logFile, "utf8");
  const r = spawnSync("docker", ["logs", container], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
}

describe("SFTP tab", { concurrency: false }, () => {
  /** @type {App} */ let app;
  /** @type {import("./webdriver.mjs").Session} */ let s;
  let u;
  const local = mkdtempSync(join(tmpdir(), "tyrminal-sftp-e2e-"));
  const name = `tyr-sftp-e2e-${process.pid}.txt`;
  const body = `files only ${process.pid}\n`;
  writeFileSync(join(local, name), body);

  before(async () => {
    // The native folder dialog is replaced by this folder in test builds.
    app = await App.launch({ env: { TYRMINAL_E2E_DOWNLOAD_DIR: local } });
    s = app.session;
    u = ui(s);
  });

  after(async () => {
    await app?.quit();
    rmSync(local, { recursive: true, force: true });
  });

  const pane = (side) => `section.sftp-pane[aria-label="${side === "left" ? "Left pane" : "Right pane"}"]`;
  const bodyText = () => s.execute("return document.body.innerText");
  const rowNames = (side) =>
    s.execute(`return [...document.querySelectorAll(arguments[0] + " table tbody .ft-name-text")].map((e) => e.textContent)`, [pane(side)]);
  // A menu item by its label (its shortcut keys are shown beside it, outside the label).
  const findItem = `[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.querySelector(":scope > span:not(.kbd-group)")?.textContent.trim() === arguments[0])`;
  const menuItem = async (label) => {
    const item = await s.until(() => s.execute(`return ${findItem} ? true : null`, [label]), { describe: `menu item ${label}` });
    assert.ok(item);
    await s.execute(`${findItem}.click()`, [label]);
  };
  /** Selects a row, then opens its menu with the row's "More actions" button. */
  const rowMenu = async (side, entry) => {
    await s.click(await s.waitFor(`${pane(side)} button[aria-label="Select ${entry}"]`));
    await s.click(await s.waitFor(`${pane(side)} button[aria-label="More actions for ${entry}"]`));
  };

  test("a host opens for files only, after the host-key check, and a file goes both ways", async () => {
    await u.createVault();
    await u.importKey(lab.keys.ed25519);
    await u.addHost({ label: "Lab files", port: lab.servers.a.port, user: lab.user });
    const logBefore = serverLog("a").split("\n").length;

    await s.click(await s.waitFor('nav.sidebar [data-nav="sftp"]'));
    await s.until(async () => /Connect to host/.test(await bodyText()), { describe: "host picker" });
    // The picker button shows the label and the destination; match on the label.
    await s.until(
      () => s.execute(`return [...document.querySelectorAll(arguments[0] + " .sftp-host")].some((b) => b.textContent.includes("Lab files")) || null`, [pane("right")]),
      { describe: "host in the picker" },
    );
    await s.execute(`[...document.querySelectorAll(arguments[0] + " .sftp-host")].find((b) => b.textContent.includes("Lab files")).click()`, [pane("right")]);

    // The usual trust prompt, with the server's real fingerprint.
    await s.until(async () => (await s.find("dialog .fingerprint")) !== null, { describe: "trust prompt" });
    assert.equal(await s.attribute(await s.waitFor("dialog .fingerprint"), "aria-label"), lab.servers.a.hostKeyEd25519Fingerprint);
    await s.clickButton("Trust and remember", { within: "dialog" });
    await s.waitGone("dialog");
    await s
      .until(async () => (await s.find(`${pane("right")} table`)) !== null, { describe: "remote listing", timeout: 30_000 })
      .catch(async (error) => {
        throw new Error(`${error.message}\n--- page ---\n${await bodyText().catch(() => "?")}`);
      });
    await app.screenshot("sftp-01-connected");

    // This computer: the folder the test chose.
    await s.clickButton("Choose folder…", { within: pane("left") });
    await s.until(async () => (await rowNames("left")).includes(name), { describe: "local listing" });

    // Local → host with the row menu's Copy to.
    await rowMenu("left", name);
    await menuItem("Copy to Lab files");
    await s.until(async () => (await rowNames("right")).includes(name), { describe: "uploaded file listed", timeout: 30_000 });

    // Host → this computer under a free name: the original stays untouched.
    await rowMenu("right", name);
    await menuItem("Copy to This computer");
    await s.until(async () => (await s.find('dialog[open]')) !== null, { describe: "conflict prompt" });
    await s.clickButton("Keep both", { within: "dialog" });
    const copy = name.replace(/\.txt$/, " (1).txt");
    await s.until(() => existsSync(join(local, copy)), { describe: "downloaded copy", timeout: 30_000 });
    assert.equal(readFileSync(join(local, copy), "utf8"), body);
    assert.equal(readFileSync(join(local, name), "utf8"), body);
    await app.screenshot("sftp-02-transferred");

    // Clean up on the server through the UI (delete asks first).
    await rowMenu("right", name);
    await menuItem("Delete…");
    await s.clickButton("Delete", { within: "dialog" });
    await s.until(async () => !(await rowNames("right")).includes(name), { describe: "deleted" });

    // The server saw file access and nothing else from this connection.
    const lines = serverLog("a").split("\n").slice(logBefore - 1);
    assert.ok(lines.some((l) => l.includes("subsystem 'sftp'")), `no sftp subsystem in:\n${lines.join("\n")}`);
    for (const asked of ["Starting session: shell", "Starting session: command", "pty"]) {
      assert.ok(!lines.some((l) => l.includes(asked)), `the SFTP tab asked for ${asked}:\n${lines.join("\n")}`);
    }
  });
});

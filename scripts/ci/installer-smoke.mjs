#!/usr/bin/env node
// Release workflow: installs the packaged application the way a user would, starts it, then
// uninstalls it and checks that the user's data is still there (Phase 09: clean install, first
// run offline, removal preserving data by default). Disposable CI runners only.
//
//   node scripts/ci/installer-smoke.mjs <platform> <dir with installers>
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [platform, dir] = process.argv.slice(2);
if (!process.env.CI) throw new Error("installer-smoke installs and removes software: CI runners only");
const IDENTIFIER = "app.tyrminal.desktop";

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (r.status !== 0) throw new Error(`${cmd} failed with ${r.status}`);
}

function find(pattern) {
  const name = readdirSync(dir).find((n) => pattern.test(n));
  if (!name) throw new Error(`no installer matching ${pattern} in ${dir}`);
  return resolve(dir, name);
}

/** Starts the app, waits until it created its data folder and is still running, then stops it. */
async function startsAndStays(cmd, args, dataDir, env = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  let exited = null;
  child.on("exit", (code) => {
    exited = code;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && exited === null && !existsSync(dataDir)) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 3000));
  if (exited !== null) throw new Error(`the application exited on start (code ${exited})`);
  if (!existsSync(dataDir)) throw new Error(`the application did not create its data folder ${dataDir}`);
  child.kill();
  console.log(`started, created ${dataDir}, still running after 3 s: ok`);
}

function marker(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "installer-smoke-keep.txt");
  writeFileSync(path, "user data must survive uninstalling\n");
  return path;
}

function expectKept(path) {
  if (!existsSync(path)) throw new Error(`uninstalling removed user data (${path})`);
  console.log("user data kept after uninstall: ok");
}

if (platform === "linux-x64") {
  const dataDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), IDENTIFIER);
  run("sudo", ["apt-get", "install", "-y", "-qq", find(/\.deb$/)]);
  if (!existsSync("/usr/bin/tyrminal")) throw new Error("the package did not install /usr/bin/tyrminal");
  await startsAndStays("xvfb-run", ["-a", "dbus-run-session", "--", "/usr/bin/tyrminal"], dataDir);
  const kept = marker(dataDir);
  run("sudo", ["apt-get", "remove", "-y", "-qq", "tyrminal"]);
  if (existsSync("/usr/bin/tyrminal")) throw new Error("removing the package left /usr/bin/tyrminal");
  expectKept(kept);
} else if (platform === "windows-x64") {
  const dataDir = join(process.env.APPDATA, IDENTIFIER);
  const installDir = join(process.env.LOCALAPPDATA, "Tyrminal");
  run(find(/-setup\.exe$/), ["/S"]);
  const exe = join(installDir, "tyrminal.exe");
  if (!existsSync(exe)) throw new Error(`the installer did not install ${exe}`);
  await startsAndStays(exe, [], dataDir);
  spawnSync("taskkill", ["/IM", "tyrminal.exe", "/F"], { stdio: "inherit" });
  const kept = marker(dataDir);
  run(join(installDir, "uninstall.exe"), ["/S"]);
  // The uninstaller copies itself and returns before it finishes.
  for (let i = 0; i < 60 && existsSync(exe); i += 1) await new Promise((r) => setTimeout(r, 1000));
  if (existsSync(exe)) throw new Error("uninstalling left tyrminal.exe in place");
  expectKept(kept);
} else if (platform === "macos-arm64" || platform === "macos-x64") {
  const dataDir = join(homedir(), "Library", "Application Support", IDENTIFIER);
  const mount = mkdtempSync(join(tmpdir(), "tyr-dmg-"));
  run("hdiutil", ["attach", find(/\.dmg$/), "-nobrowse", "-mountpoint", mount]);
  const apps = mkdtempSync(join(tmpdir(), "tyr-apps-"));
  run("cp", ["-R", join(mount, "Tyrminal.app"), apps]);
  run("hdiutil", ["detach", mount]);
  const app = join(apps, "Tyrminal.app");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  await startsAndStays(join(app, "Contents", "MacOS", "tyrminal"), [], dataDir);
  const kept = marker(dataDir);
  run("rm", ["-rf", app]);
  expectKept(kept);
} else {
  throw new Error(`unknown platform ${platform}`);
}

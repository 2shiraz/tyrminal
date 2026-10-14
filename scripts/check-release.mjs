#!/usr/bin/env node
// Release-policy checks (INV-05, INV-09, spec §4.6, §9.7). Static checks always run; binary
// checks run when a release binary exists and are reported as BLOCKED when it does not.
//
//   node scripts/check-release.mjs [--require-binary]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "apps", "desktop", "src-tauri");
const problems = [];
const notes = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

// ---- first-party unsafe (ADR 0007) ----
// Every crate inherits `unsafe_code = "forbid"` from the workspace; only crates/os-hooks may relax it.
const rootToml = readFileSync(join(root, "Cargo.toml"), "utf8");
check(/unsafe_code\s*=\s*"forbid"/.test(rootToml), "the workspace no longer forbids unsafe code");
for (const base of [join(root, "crates"), join(root, "apps", "desktop")]) {
  for (const name of readdirSync(base)) {
    const manifest = join(base, name, name === "src-tauri" ? "" : "", "Cargo.toml");
    if (!existsSync(manifest)) continue;
    const text = readFileSync(manifest, "utf8");
    const own = /\[lints\.rust\]/.test(text) || !/\[lints\]\s*\n\s*workspace\s*=\s*true/.test(text);
    if (name === "os-hooks") check(/unsafe_code\s*=\s*"deny"/.test(text), "crates/os-hooks must deny unsafe outside its FFI modules");
    else check(!own, `${manifest.slice(root.length + 1)} does not inherit the workspace lints (unsafe must stay forbidden)`);
  }
}

// ---- configuration ----
const config = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
const csp = config.app?.security?.csp ?? {};
const cspText = typeof csp === "string" ? csp : Object.entries(csp).map(([k, v]) => `${k} ${v}`).join("; ");
check(cspText.length > 0, "production CSP is missing");
check(!/unsafe-eval/.test(cspText), "CSP allows unsafe-eval");
check(!/https?:\/\/(?!ipc\.localhost)/.test(cspText), "CSP names a remote origin");
check(!/(^|[\s;])\*([\s;]|$)/.test(cspText), "CSP contains a wildcard source");
check((csp["script-src"] ?? "") === "'self'", "script-src must be exactly 'self'");
check((csp["default-src"] ?? "") === "'none'", "default-src must be 'none'");
check(config.app?.withGlobalTauri === false, "withGlobalTauri must be false");
check(!("updater" in (config.plugins ?? {})), "an updater endpoint is configured before an authorized trust root exists");
check(
  JSON.stringify(config.app?.security?.capabilities) === '["main","detached"]',
  "release config must enable exactly the 'main' and 'detached' capabilities",
);

// ---- capabilities ----
const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities", "main.json"), "utf8"));
const allowedPrefixes = ["allow-", "core:event:allow-listen", "core:event:allow-unlisten"];
for (const permission of capability.permissions) {
  const id = typeof permission === "string" ? permission : permission.identifier;
  check(allowedPrefixes.some((p) => id.startsWith(p)), `unexpected permission in main capability: ${id}`);
  check(!/^(fs|shell|http|process|opener|dialog|clipboard|wdio|global-shortcut|sql|store):/.test(id), `plugin permission granted to the renderer: ${id}`);
}
check(JSON.stringify(capability.windows) === '["main"]', "main capability must apply to the main window only");
const capabilityFiles = readdirSync(join(tauriDir, "capabilities")).filter((f) => f.endsWith(".json"));
check(capabilityFiles.join() === "detached.json,main.json", `unexpected capability files: ${capabilityFiles.join(", ")}`);

// agent C: workspaces. A detached window (a tab moved out of the main window) gets a scoped
// capability: only these permissions, only for windows labelled detached-*.
const detached = JSON.parse(readFileSync(join(tauriDir, "capabilities", "detached.json"), "utf8"));
const DETACHED_ALLOWED = [
  "allow-window-detach-take",
  "allow-session-attach",
  "allow-session-write",
  "allow-session-resize",
  "allow-session-ack",
  "allow-session-close",
  "allow-session-trust-answer",
  "allow-session-auth-answer",
  "allow-prefs-get",
  "allow-vault-activity",
];
check(JSON.stringify(detached.windows) === '["detached-*"]', "detached capability must apply to detached-* windows only");
for (const permission of detached.permissions) {
  const id = typeof permission === "string" ? permission : permission.identifier;
  check(DETACHED_ALLOWED.includes(id), `unexpected permission in detached capability: ${id}`);
}

// ---- every declared command is granted and vice versa ----
const buildRs = readFileSync(join(tauriDir, "build.rs"), "utf8");
const declared = [...buildRs.matchAll(/^\s+"([a-z_]+)",$/gm)].map((m) => m[1]).sort();
const allowName = (p) => p.slice(6).replaceAll("-", "_");
const granted = [
  ...new Set([...capability.permissions, ...detached.permissions].filter((p) => typeof p === "string" && p.startsWith("allow-")).map(allowName)),
].sort();
check(declared.join() === granted.join(), "commands declared in build.rs and the permissions of the capability files differ");
// Taking a detached tab belongs to detached windows only; the main window never holds its tokens.
check(!capability.permissions.includes("allow-window-detach-take"), "the main window must not be able to take a detached tab");
const forbiddenCommand = /(execute|eval|read_any|query_database|decrypt|export_secret|shell|spawn)/;
for (const command of declared) check(!forbiddenCommand.test(command), `generic or secret-revealing command name: ${command}`);

// ---- cargo features: the e2e automation plugin is optional and off by default ----
const manifest = readFileSync(join(tauriDir, "Cargo.toml"), "utf8");
check(/tauri-plugin-wdio-webdriver = \{[^}]*optional = true/.test(manifest), "the WebDriver plugin must be an optional dependency");
check(!/^default\s*=.*e2e/m.test(manifest), "the e2e feature must not be a default feature");
const tree = spawnSync("cargo", ["tree", "-p", "tyrminal-desktop", "-e", "normal", "--prefix", "none"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
if (tree.status === 0) {
  check(!/tauri-plugin-wdio/.test(tree.stdout), "default feature graph contains the WebDriver plugin");
  check(!/\b(reqwest|hyper|ureq|isahc)\b/.test(tree.stdout), "default feature graph contains an HTTP client (no vendor/network client is expected in local mode)");
} else {
  problems.push("cargo tree failed; the release feature graph was not inspected");
}

// ---- frontend sources: no remote assets, no direct native access outside the IPC module ----
const srcDir = join(root, "apps", "desktop", "src");
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
for (const file of walk(srcDir).filter((f) => /\.(ts|tsx|css|html)$/.test(f))) {
  const text = readFileSync(file, "utf8");
  const rel = file.slice(root.length + 1);
  check(!/https?:\/\/(?!www\.w3\.org)/.test(text.replace(/\/\/.*$/gm, "")), `${rel}: references a remote URL`);
  check(!/\b(localStorage|sessionStorage|indexedDB)\b/.test(text), `${rel}: uses browser storage`);
  check(!/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/.test(text), `${rel}: renders HTML or evaluates code dynamically`);
  if (!rel.endsWith(join("lib", "ipc.ts"))) check(!/@tauri-apps\/api/.test(text), `${rel}: imports the native API outside lib/ipc.ts`);
}
check(!/https?:\/\//.test(readFileSync(join(root, "apps", "desktop", "index.html"), "utf8")), "index.html references a remote URL");

// ---- release binary, when present ----
const binary = join(root, "target", "release", process.platform === "win32" ? "tyrminal.exe" : "tyrminal");
if (existsSync(binary)) {
  const bytes = readFileSync(binary);
  for (const marker of ["tauri-plugin-wdio", "wdio-webdriver", "TAURI_WEBDRIVER_PORT", "/wdio/eval", "MemorySecretStore", "tyrminal-lab"]) {
    check(!bytes.includes(marker), `release binary contains test-only marker "${marker}"`);
  }
  notes.push(`release binary inspected: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB`);
} else if (process.argv.includes("--require-binary")) {
  problems.push("BLOCKED: no release binary to inspect (pnpm build:desktop)");
} else {
  notes.push("release binary not built; binary inspection skipped (static checks only)");
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  console.error(problems.map((p) => `FAIL: ${p}`).join("\n"));
  process.exit(1);
}
console.log(`release policy ok: ${declared.length} commands, CSP and capabilities locked down`);

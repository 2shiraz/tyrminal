#!/usr/bin/env node
// Environment doctor: reports toolchain/SDK availability and which gates this machine can run.
// It only runs `--version`-style probes and checks that the repository is writable.
// It never reads SSH configuration, keys, keychains or any other user data.

import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = process.argv.includes("--json");

function probe(cmd, args) {
  // npm-installed tools are .cmd shims on Windows, which spawn only through a shell. The
  // arguments here are fixed literals, so the shell sees no outside input.
  const shim = process.platform === "win32" && ["pnpm", "npm", "npx"].includes(cmd);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, shell: shim });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout}${r.stderr}`.trim().split("\n")[0];
}

const pinnedRust = /channel = "([^"]+)"/.exec(readFileSync(join(root, "rust-toolchain.toml"), "utf8"))?.[1];
const pinnedPnpm = /"packageManager": "pnpm@([^"+]+)/.exec(readFileSync(join(root, "package.json"), "utf8"))?.[1];

const checks = [
  { id: "rustc", need: "required", value: probe("rustc", ["--version"]), want: pinnedRust },
  { id: "cargo", need: "required", value: probe("cargo", ["--version"]) },
  { id: "node", need: "required", value: probe("node", ["--version"]) },
  { id: "pnpm", need: "required", value: probe("pnpm", ["--version"]), want: pinnedPnpm },
  { id: "git", need: "required", value: probe("git", ["--version"]) },
  { id: "ssh-keygen", need: "lab", value: probe("ssh-keygen", ["-?"]) ?? (probe("which", ["ssh-keygen"]) && "present") },
  { id: "sshd", need: "lab", value: probe("which", ["sshd"]) },
  { id: "docker-daemon", need: "lab-docker", value: probe("docker", ["info", "--format", "{{.ServerVersion}}"]) },
  { id: "xcode-full", need: "ios", value: probe("xcodebuild", ["-version"]) },
  { id: "android-sdk", need: "android", value: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null },
  { id: "cargo-deny", need: "security", value: probe("cargo", ["deny", "--version"]) },
  { id: "cargo-fuzz", need: "fuzz", value: probe("cargo", ["fuzz", "--version"]) },
];

let writable = true;
try { accessSync(root, constants.W_OK); } catch { writable = false; }

const host = {
  platform: process.platform,
  arch: process.arch,
  os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  memoryGiB: Math.round(os.totalmem() / 2 ** 30),
  repositoryWritable: writable,
};

const gates = {
  "core build/tests": ["rustc", "cargo"].every((id) => checks.find((c) => c.id === id).value),
  "desktop UI build": ["node", "pnpm"].every((id) => checks.find((c) => c.id === id).value),
  "ssh lab (local sshd process)": Boolean(checks.find((c) => c.id === "sshd").value),
  "ssh lab (pinned OpenSSH containers)": Boolean(checks.find((c) => c.id === "docker-daemon").value),
  "native macOS app": process.platform === "darwin",
  "native Windows app": process.platform === "win32",
  "iOS build": Boolean(checks.find((c) => c.id === "xcode-full").value),
  "Android build": Boolean(checks.find((c) => c.id === "android-sdk").value),
};

if (json) {
  console.log(JSON.stringify({ host, checks, gates }, null, 2));
} else {
  console.log(`Host: ${host.platform}/${host.arch} · ${host.cpu} · ${host.cores} cores · ${host.memoryGiB} GiB · ${host.os}`);
  console.log(`Repository writable: ${writable ? "yes" : "NO"}\n`);
  for (const c of checks) {
    const mismatch = c.want && c.value && !c.value.includes(c.want) ? `  (pinned: ${c.want})` : "";
    console.log(`${c.value ? "ok     " : "MISSING"}  ${c.id.padEnd(14)} [${c.need}] ${c.value ?? ""}${mismatch}`);
  }
  console.log("\nGates runnable on this machine:");
  for (const [name, ok] of Object.entries(gates)) console.log(`  ${ok ? "yes    " : "BLOCKED"}  ${name}`);
}

const requiredMissing = checks.filter((c) => c.need === "required" && !c.value);
process.exit(requiredMissing.length || !writable ? 1 : 0);

#!/usr/bin/env node
// Release workflow helper: copies the installers Tauri produced for this platform into one
// directory under stable, versioned names.
//
//   node scripts/ci/collect-artifacts.mjs <platform> <tag> <outDir>
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [platform, tag, outDir] = process.argv.slice(2);
const bundle = join("target", "release", "bundle");
const patterns = {
  "macos-arm64": [["dmg", /\.dmg$/]],
  "macos-x64": [["dmg", /\.dmg$/]],
  "windows-x64": [["nsis", /-setup\.exe$/]],
  "linux-x64": [["deb", /\.deb$/], ["appimage", /\.AppImage$/]],
}[platform];
if (!patterns) throw new Error(`unknown platform ${platform}`);

mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const [dir, pattern] of patterns) {
  const from = join(bundle, dir);
  if (!existsSync(from)) continue;
  for (const name of readdirSync(from).filter((n) => pattern.test(n))) {
    const ext = name.slice(name.search(pattern));
    const target = `tyrminal-${tag}-${platform}${ext.startsWith("-setup") ? ext : ext}`;
    copyFileSync(join(from, name), join(outDir, target));
    console.log(`${join(from, name)} -> ${target}`);
    copied += 1;
  }
}
if (copied === 0) throw new Error(`no installers found under ${bundle} for ${platform}`);

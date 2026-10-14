#!/usr/bin/env node
// Release workflow helper: writes the update feed manifest (latest.json) for a published release
// from the signed update artifacts collected in <dir>. Prints nothing and writes nothing when the
// build made no signed update artifacts (no update signing key configured).
//
//   node scripts/ci/updater-feed.mjs <dir> <tag> <notes-file> <out>
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TARGETS, buildManifest } from "./updater.mjs";

const [dir, tag, notesFile, out] = process.argv.slice(2);
const artifacts = {};
for (const [platform, { suffix }] of Object.entries(TARGETS)) {
  const file = `tyrminal-${tag}-${platform}${suffix}`;
  if (existsSync(join(dir, file)) && existsSync(join(dir, `${file}.sig`))) {
    artifacts[platform] = { file, signature: readFileSync(join(dir, `${file}.sig`), "utf8") };
  }
}
if (Object.keys(artifacts).length === 0) {
  console.log(`no signed update artifacts in ${dir} (${readdirSync(dir).length} files); no feed written`);
} else {
  const manifest = buildManifest({ tag, notes: readFileSync(notesFile, "utf8"), date: new Date().toISOString(), artifacts });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`feed for ${tag}: ${Object.keys(manifest.platforms).join(", ")}`);
}

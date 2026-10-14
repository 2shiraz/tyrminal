// node --test scripts/ci/updater.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { FEED_URL, buildManifest, updaterOverlay, updaterPolicy } from "./updater.mjs";

const KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgQUJDREVGCg==";

test("the overlay gives a release build its updater, and nothing weaker passes policy", () => {
  const overlay = updaterOverlay(KEY);
  assert.equal(overlay.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(updaterPolicy(overlay.plugins.updater), []);
  assert.deepEqual(updaterPolicy(undefined), [], "no updater (development builds) is fine");
  assert.throws(() => updaterOverlay(""), /public key/);
  assert.throws(() => updaterOverlay("not a key"), /public key/);
  const weaker = [
    { ...overlay.plugins.updater, endpoints: ["http://example.com/latest.json"] },
    { ...overlay.plugins.updater, endpoints: [FEED_URL, "https://example.com/latest.json"] },
    { ...overlay.plugins.updater, requireSignedVersion: false },
    { ...overlay.plugins.updater, allowDowngrades: true },
    { ...overlay.plugins.updater, dangerousAcceptInvalidCerts: true },
    { ...overlay.plugins.updater, pubkey: "" },
  ];
  for (const config of weaker) assert.notDeepEqual(updaterPolicy(config), [], JSON.stringify(config));
});

test("the manifest names each signed artifact of the tag, and refuses anything unsigned or misnamed", () => {
  const manifest = buildManifest({
    tag: "v0.3.0-beta.1",
    notes: "Fixes",
    date: "2026-10-20T00:00:00Z",
    artifacts: {
      "macos-arm64": { file: "tyrminal-v0.3.0-beta.1-macos-arm64.app.tar.gz", signature: "c2ln\n" },
      "linux-x64": { file: "tyrminal-v0.3.0-beta.1-linux-x64.AppImage", signature: "c2ln" },
    },
  });
  assert.equal(manifest.version, "0.3.0-beta.1");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "linux-x86_64"]);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "c2ln");
  assert.equal(manifest.platforms["linux-x86_64"].url, "https://github.com/2shiraz/tyrminal/releases/download/v0.3.0-beta.1/tyrminal-v0.3.0-beta.1-linux-x64.AppImage");
  assert.throws(() => buildManifest({ tag: "latest", artifacts: {} }), /release tag/);
  assert.throws(() => buildManifest({ tag: "v1.0.0", artifacts: { "linux-x64": { file: "x.deb", signature: "s" } } }), /not the linux-x64/);
  assert.throws(() => buildManifest({ tag: "v1.0.0", artifacts: { "linux-x64": { file: "x.AppImage", signature: " " } } }), /no signature/);
  assert.throws(() => buildManifest({ tag: "v1.0.0", artifacts: {} }), /no signed update artifacts/);
});

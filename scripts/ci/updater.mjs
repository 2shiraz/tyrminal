// Signed in-app updates (UX-05, ADR 0013): the one place that knows the update feed, the release
// build's updater configuration, its policy, and how the feed's manifest is assembled.
//
// The feed is a single file, `latest.json`, kept as an asset of the repository's `updater`
// release. The release workflow replaces it after each published release. The manifest is not
// itself signed: every artifact it names carries a minisign signature checked against the public
// key built into the app, and `requireSignedVersion` makes the signed version decide, so a
// tampered or replayed manifest cannot install an older build (INV-14).

export const REPOSITORY = "2shiraz/tyrminal";
export const FEED_TAG = "updater";
export const FEED_URL = `https://github.com/${REPOSITORY}/releases/download/${FEED_TAG}/latest.json`;

/** Platform of an artifact set (as collect-artifacts names them) -> manifest target and file suffix. */
export const TARGETS = {
  "macos-arm64": { target: "darwin-aarch64", suffix: ".app.tar.gz" },
  "windows-x64": { target: "windows-x86_64", suffix: "-setup.exe" },
  "linux-x64": { target: "linux-x86_64", suffix: ".AppImage" },
};

/** The Tauri configuration overlay that gives a release build its updater. */
export function updaterOverlay(pubkey) {
  const key = String(pubkey ?? "").trim();
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(key)) throw new Error("the update public key must be the base64 text `tauri signer generate` prints");
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: key, endpoints: [FEED_URL], requireSignedVersion: true } },
  };
}

/** Problems with an updater configuration, as release policy sees them (empty: acceptable). */
export function updaterPolicy(updater) {
  if (updater === undefined) return [];
  const problems = [];
  if (!updater || typeof updater !== "object") return ["the updater configuration is not an object"];
  if (typeof updater.pubkey !== "string" || updater.pubkey.trim() === "") problems.push("the updater has no public key");
  if (JSON.stringify(updater.endpoints) !== JSON.stringify([FEED_URL])) problems.push(`the updater endpoint must be exactly ${FEED_URL}`);
  if (updater.requireSignedVersion !== true) problems.push("the updater must require the signed version (requireSignedVersion)");
  for (const flag of ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts", "dangerousAcceptInvalidHostnames", "allowDowngrades"]) {
    if (updater[flag]) problems.push(`the updater must not set ${flag}`);
  }
  return problems;
}

/**
 * The feed manifest for a release: `artifacts` maps a platform (TARGETS key) to the published
 * file name and the text of its `.sig` file. Platforms without a signed artifact are left out.
 */
export function buildManifest({ tag, notes, date, artifacts }) {
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const platforms = {};
  for (const [platform, { file, signature }] of Object.entries(artifacts)) {
    const known = TARGETS[platform];
    if (!known) throw new Error(`unknown platform ${platform}`);
    if (!file.endsWith(known.suffix)) throw new Error(`${file} is not the ${platform} update artifact`);
    if (!signature || !signature.trim()) throw new Error(`${file} has no signature`);
    platforms[known.target] = {
      signature: signature.trim(),
      url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(file)}`,
    };
  }
  if (Object.keys(platforms).length === 0) throw new Error("no signed update artifacts");
  return { version: tag.slice(1), notes: String(notes ?? "").slice(0, 4000), pub_date: date, platforms };
}

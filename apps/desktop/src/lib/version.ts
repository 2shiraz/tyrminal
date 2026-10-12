// Version facts shown in Settings → About, the sidebar and the vault screens. Pure functions only:
// the build-time version (`__APP_VERSION__`) is passed in, so these are testable outside the app.
import type { AppInfo } from "@tyrminal/contracts";

export type ReleaseChannel = "prerelease" | "release";

/** SemVer: a hyphen after `major.minor.patch` (before any `+build`) marks a pre-release. */
export function releaseChannel(version: string): ReleaseChannel {
  return /^v?\d+\.\d+\.\d+-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*(\+[0-9A-Za-z.-]+)?$/.test(version.trim()) ? "prerelease" : "release";
}

/** `v0.1.0-beta.2`. */
export function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

const CHANNEL_NAMES: Record<ReleaseChannel, string> = { prerelease: "Pre-release", release: "Release" };

export function channelName(version: string): string {
  return CHANNEL_NAMES[releaseChannel(version)];
}

/**
 * The plain-text block "Copy version info" puts on the clipboard for bug reports. It holds the
 * build and platform facts and nothing else: no host names, paths, user names or vault data.
 */
export function versionReport(version: string, info: AppInfo | null): string {
  const lines = [`Tyrminal ${versionLabel(version)}`, `Channel: ${channelName(version)}`];
  if (info) {
    lines.push(
      `Commit: ${info.commit}`,
      `Built: ${info.buildDate} (UTC)`,
      `OS: ${info.os} ${info.arch}`,
      `Tauri: ${info.tauriVersion}`,
      `WebView: ${info.webviewVersion ?? "unknown"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

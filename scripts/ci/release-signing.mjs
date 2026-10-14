#!/usr/bin/env node
// Release workflow helper: writes a Tauri config overlay that enables code signing only when the
// signing secrets exist, and prints its path as the `config` step output. No key is created or
// stored in the repository. Without secrets the build is unsigned (macOS: ad-hoc signature).
//
// The same overlay sets the app's version to the release tag (so the updater compares real
// versions) and, only when the update signing key and its public key are both configured, gives
// the build its updater (scripts/ci/updater.mjs, ADR 0013). Without them the build has none.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FEED_URL, updaterOverlay } from "./updater.mjs";

const overlay = { bundle: {} };
const out = mkdtempSync(join(tmpdir(), "tyrminal-signing-"));
const summary = [];

if (process.platform === "darwin") {
  if (process.env.APPLE_CERTIFICATE) {
    summary.push("macOS: Developer ID signing via APPLE_* secrets (Tauri imports the certificate).");
  } else {
    // Ad-hoc signature: a structurally valid bundle, but not a Developer ID identity.
    overlay.bundle.macOS = { signingIdentity: "-" };
    summary.push("macOS: no signing secrets; ad-hoc signature only (unsigned for Gatekeeper).");
  }
}

if (process.platform === "win32") {
  if (process.env.WINDOWS_CERTIFICATE) {
    const pfx = join(out, "signing.pfx");
    writeFileSync(pfx, Buffer.from(process.env.WINDOWS_CERTIFICATE, "base64"));
    // The password reaches PowerShell through the environment of this step only, not argv.
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force; ` +
          `(Import-PfxCertificate -FilePath '${pfx}' -CertStoreLocation Cert:\\CurrentUser\\My -Password $p).Thumbprint`,
      ],
      { encoding: "utf8" },
    );
    rmSync(pfx);
    if (ps.status !== 0) throw new Error("importing the Windows signing certificate failed");
    overlay.bundle.windows = {
      certificateThumbprint: ps.stdout.trim().split(/\s+/).pop(),
      digestAlgorithm: "sha256",
      timestampUrl: "http://timestamp.digicert.com",
    };
    summary.push("Windows: Authenticode signing with the imported certificate.");
  } else {
    summary.push("Windows: no signing secrets; installer and executable are unsigned.");
  }
}

if (process.platform === "linux") summary.push("Linux: packages are unsigned.");

const tag = process.env.TYRMINAL_RELEASE_TAG;
if (tag) overlay.version = tag.replace(/^v/, "");
const withUpdater = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY && process.env.TYRMINAL_UPDATER_PUBKEY);
if (withUpdater) {
  const updater = updaterOverlay(process.env.TYRMINAL_UPDATER_PUBKEY);
  overlay.bundle = { ...overlay.bundle, ...updater.bundle };
  overlay.plugins = updater.plugins;
  summary.push(`Updater: update artifacts signed; the app checks ${FEED_URL} when the user asks or opts in.`);
} else {
  summary.push("Updater: no update signing key configured; this build has no in-app updater.");
}

const file = join(out, "signing.json");
writeFileSync(file, JSON.stringify(overlay));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `config=${file}\nfeatures=${withUpdater ? "updater" : ""}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
console.log(summary.join("\n"));

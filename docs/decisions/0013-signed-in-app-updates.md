# ADR 0013: Signed in-app updates (UX-05)

Status: accepted (owner request, 2026-10-14). Active in a release only once the owner has created
the update signing key and configured it in the repository (see "What the owner sets up").

## Context

The owner asked for Tyrminal to update itself from its releases. The specification allows it with
conditions: update checking is manual, and optional automatic checks require opt-in (§1.3);
updates require trusted artifact verification, and invalid or replayed metadata cannot silently
downgrade (INV-14); signing private keys never belong in the repository, client or tests; and
production update URLs stay absent until an authorized endpoint and trust root exist (§9.7).
Release policy (`scripts/check-release.mjs`) also keeps any HTTP client out of the default build.

## Decision

1. **Plugin.** `tauri-plugin-updater` 2.13.3 (Apache-2.0 OR MIT), without default features:
   `rustls-tls` (rustls with ring; no system TLS) and `zip`; no proxy autodetection. It verifies
   every downloaded artifact against a minisign public key built into the app before installing.
   Dev-dependency `serde_json` 1 (already in the graph through Tauri) for the adapter's tests.
2. **Only in signed releases.** The plugin is behind the adapter's `updater` cargo feature, which
   only the release workflow enables, and only when the update signing key is configured. The
   default build graph keeps no HTTP client, and release policy still enforces that. The
   updater's configuration (public key, feed URL, `requireSignedVersion`) is never in
   `tauri.conf.json`; the release workflow adds it as an overlay, and release policy checks the
   overlay: exactly the one feed URL over HTTPS, a public key, `requireSignedVersion: true`, and
   none of `allowDowngrades` or the `dangerous*` options.
3. **No downgrade.** Only a version greater than the running one is offered (the plugin's
   default comparator). `requireSignedVersion` makes the version signed into each artifact's
   signature decide, so a manifest that pairs a new version number with an older, validly signed
   artifact is refused. The pinned Tauri CLI (2.12.1) records that version when signing.
4. **The feed.** One file, `latest.json`, kept on the repository's `updater` release and replaced
   by the release workflow after each published release (`scripts/ci/updater-feed.mjs`, from the
   `.sig` files the bundler wrote). It lists the macOS (arm64) app archive, the Windows NSIS
   installer and the Linux AppImage of that release. The release's version is set from its tag so
   the comparison uses real versions.
5. **The user decides.** Checking happens when the user presses Check now (Settings → Privacy →
   Updates) or, if they turn it on (off by default), once a day starting a minute after launch. A
   release found is shown with its notes as plain text (shortened natively, never rendered as
   markup) and a status-strip item points to it. Installing is a press of Install: the vault
   locks (open sessions end, which the button's hint says), the artifact is verified and
   installed, and the app restarts. Nothing downloads or installs on its own.
6. **Renderer.** No updater permission. Three app commands (`update_status`, `update_check`,
   `update_install`), main window only, take no arguments: no URL, key or file comes from the
   renderer. A build without the updater answers that it has none.

## What the owner sets up (not done by an agent: signing is the owner's)

1. Generate the key pair once, on a trusted machine: `pnpm --filter @tyrminal/desktop tauri signer
   generate -w ~/.tauri/tyrminal-updates.key`, with a password. Keep the private key and its
   password backed up offline: losing them means installed copies can no longer be updated.
2. Repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the private key file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; repository variable `TYRMINAL_UPDATER_PUBKEY` (the public
   key it printed).
3. The first release made after that carries the updater; copies installed earlier have none and
   are updated by hand once.

## Not verified

The updater has not run against a real feed: that needs the signing key, a published release and
the platform builds, none of which an agent may create. The release workflow changes have not run
in CI. Covered here: the adapter's unit tests (with and without the feature), release policy for
the overlay (`scripts/ci/updater.test.mjs`, `check-release.mjs --overlay`), and the renderer flow
against a mock (`tests/ui/updates.spec.ts`). Windows installers with a pre-release version
(`0.3.0-beta.1`) need checking in the first signed release.

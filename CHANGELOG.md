# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/);
pre-releases are not stable and have not been independently security reviewed.

## Unreleased

## 0.2.0-beta.2 — pre-release

Release notes: [docs/releases/v0.2.0-beta.2.md](docs/releases/v0.2.0-beta.2.md).

### Added
- Signed in-app updates (Settings → Privacy → Updates) in releases built with the update
  signing key; daily checks are opt-in.
- A changed server key can be replaced from its warning; the new key goes through the
  first-time trust prompt.
- The vault's idle lock time is a setting (1 minute to 8 hours, 5 minutes by default).

### Fixed
- With quick unlock off, macOS no longer asks for the keychain password on the unlock screen
  or in Settings.

## 0.2.0-beta.1 — pre-release

Release notes: [docs/releases/v0.2.0-beta.1.md](docs/releases/v0.2.0-beta.1.md).

### Added
- Redesigned Hosts page (search that also connects, groups as sections, favourites, list and
  card views, OS icons, details side panel, keyboard navigation), browser-style tabs, a
  new-tab page with recent connections, quick connect in its own tab, resizable panels and
  interface scaling.
- Command-finished notifications, unread tab marks, search across sessions, saving a marked
  command's output, notes on hosts and groups, session recordings (off by default), command
  history, workspaces and layout templates.
- Inventory, SFTP, tunnels, jump hosts, proxies, Telnet and serial, agent forwarding and the
  other features listed in the release notes.

### Changed
- Home is removed; its search and recent connections moved to Hosts and the new-tab page.
- Faster start: fewer calls before the first screen and a smaller initial bundle.

### Fixed
- RSA signatures with a leading zero byte are padded to the key size.
- Multi-step sign-in (SSH partial success) is supported.

## 0.1.0-beta.1 — pre-release

### Added
- Local encrypted vault (Argon2id + XChaCha20-Poly1305) with recovery key, passphrase change,
  recovery-key rotation, idle auto-lock; format specified in `docs/crypto-format.md` with
  known-answer vectors.
- SSH sessions (russh) with host-key verification before authentication, known-hosts management
  with reasons for replacement, password, stored-password and key authentication (including
  encrypted keys with optional remembered passphrase), local terminal (PTY / ConPTY).
- Desktop UI: home with recent connections and quick connect, host grid/list with editor,
  keychain, known hosts, command palette, platform shortcuts, tab strip (rename, reorder, close),
  split panes, status bar, light/dark/system themes checked for WCAG 2.2 AA contrast,
  reduced-motion support, bundled fonts and icons, strict CSP.
- Terminal: WebGL renderer with automatic fallback, 14 color schemes with live preview, font,
  size, line height, letter spacing, cursor, padding and scrollback settings, optional
  ligatures, search, zoom, Unicode grapheme widths, confirm-before-open links (http/https only),
  OSC 52 clipboard writes only with per-session consent (reads never answered), review before
  multi-line or large pastes.
- Snippets stored as encrypted vault records, with folders, a library page and a side panel that
  targets the visible session; Run and Paste are sent by the core from the vault; multi-line
  snippets are previewed with the exact target first.
- Owner-only application data directory (Unix 0700; Windows DACL for the user and SYSTEM).
- Test layers: Rust unit/property/known-answer tests, OpenSSH lab (Docker or local sshd),
  native end-to-end tests driving the real application, browser UI and visual regression tests
  in a pinned container, contrast checks, fuzz targets, cargo-deny, secret scanning.
- On request, the password of the identity a host uses can be typed into an SSH session at a
  sudo prompt, after a confirmation that names the identity (never automatically, never with
  Enter).
- Deleting an identity that hosts or groups use asks whether to move them to another identity or
  remove it from them, and shows how each host signs in afterwards.
- Settings for a compromised-password check (off by default; only a 5-character hash prefix
  would be sent). This build cannot make the request yet.

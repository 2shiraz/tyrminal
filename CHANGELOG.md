# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/);
pre-releases are not stable and have not been independently security reviewed.

## Unreleased

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
- Reusable identities (user name, password, key) in the keychain, chosen by hosts and groups and
  followed when they change; on request, an identity's password can be typed into an SSH session
  at a sudo prompt (never automatically, never with Enter).

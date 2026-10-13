<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" alt="Tyrminal" width="112" height="112">

# Tyrminal

**A fast, secure, local-first SSH client for macOS, Windows and Linux.**

Your hosts, keys and passwords live in an encrypted vault on your own device.
No account, no cloud, no telemetry.

[![CI](https://github.com/2shiraz/tyrminal/actions/workflows/ci.yml/badge.svg)](https://github.com/2shiraz/tyrminal/actions/workflows/ci.yml)
[![Native](https://github.com/2shiraz/tyrminal/actions/workflows/native.yml/badge.svg)](https://github.com/2shiraz/tyrminal/actions/workflows/native.yml)
[![Security](https://github.com/2shiraz/tyrminal/actions/workflows/security.yml/badge.svg)](https://github.com/2shiraz/tyrminal/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/2shiraz/tyrminal?include_prereleases&label=pre-release)](https://github.com/2shiraz/tyrminal/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Download](https://github.com/2shiraz/tyrminal/releases) ·
[User guide](docs/user-guide.md) ·
[Architecture](docs/architecture.md) ·
[Security](SECURITY.md) ·
[Contributing](CONTRIBUTING.md)

</div>

> [!WARNING]
> Tyrminal is **pre-release software**. It has not been independently security reviewed and the
> installers are not yet code-signed. Use it with test servers and credentials you can rotate.

## Why Tyrminal

- **Local-first.** Everything stays on your machine in an encrypted vault. Nothing is sent
  anywhere unless you ask for it.
- **Secure by default.** Host keys are verified before authentication, secrets never touch logs
  or command lines, and the UI runs under a strict content security policy with no remote assets.
- **Fast.** A Rust core with a lightweight Tauri shell: cold start in about 200 ms and smooth
  search across thousands of hosts.
- **Open source.** Apache-2.0, with every feature tracked in a public
  [feature matrix](docs/feature-matrix.csv).

## Features

**Vault and credentials**
- Encrypted local vault (Argon2id + XChaCha20-Poly1305) with a recovery key and idle auto-lock
- Keychain for private keys (Ed25519, ECDSA, RSA, including encrypted keys) and saved identities
- Import from OpenSSH config, CSV, PuTTY (PPK), MobaXterm and SecureCRT
- Encrypted backup and restore

**Hosts**
- Hosts and nested groups with tags, search and keyboard navigation
- Quick connect from the search bar: type an address and press Enter
- OS detection, per-host notes, production-host safeguards
- Known-hosts management with reasons for every replacement

**Terminal**
- Browser-style tabs, split panes and saved workspaces
- WebGL renderer, 14 colour schemes, ligatures, search, zoom and full Unicode support
- Snippets with a side panel, multi-host runs and broadcast input
- Paste review for multi-line or risky pastes; OSC 52 clipboard only with consent
- Command history and optional encrypted session recordings (off by default)

**Connections**
- SSH with password, key, agent and multi-step (partial success) authentication
- SFTP file manager with transfers in both directions
- Port forwarding, jump hosts and proxies, with every hop verified
- Local shells (PTY / ConPTY), Telnet and serial connections

**Interface**
- Light, dark and system themes checked for WCAG 2.2 AA contrast
- Command palette, resizable panels, interface scaling for high-resolution displays
- Reduced-motion support and bundled fonts and icons

See the [user guide](docs/user-guide.md) for the full tour.

## Installation

Download the installer for your platform from the
[releases page](https://github.com/2shiraz/tyrminal/releases) and verify it against
`SHA256SUMS.txt`.

| Platform | Package |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows (x64) | `.exe` installer |
| Linux (x64) | `.deb` / `.AppImage` |

Pre-release builds are unsigned, so macOS and Windows show a warning on first launch. The
[user guide](docs/user-guide.md#opening-a-pre-release-build) explains how to open them.

## Building from source

**Requirements:** Rust (version pinned in [`rust-toolchain.toml`](rust-toolchain.toml)),
Node.js 24+, pnpm 11, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
your platform. Docker is optional and only needed for the SSH test lab.

```sh
git clone https://github.com/2shiraz/tyrminal.git
cd tyrminal
pnpm install
pnpm doctor           # checks your toolchain
pnpm dev              # runs the app in development mode
pnpm build:desktop    # builds an installer for your platform
```

## Development

| Command | What it does |
|---|---|
| `pnpm verify:fast` | Format, lint, typecheck, contracts and all Rust unit tests |
| `pnpm test:ui` | Browser UI and visual regression tests (Playwright) |
| `pnpm lab:up` / `pnpm lab:down` | Starts / stops disposable OpenSSH servers on loopback |
| `pnpm test:integration` | Real SSH, SFTP and session tests against the lab |
| `pnpm test:security` | Vault, storage and host-trust negative tests |
| `pnpm build:e2e && pnpm test:native` | Drives the packaged application end to end |
| `pnpm check:release` | CSP, capability and release-binary policy checks |

The full list with prerequisites is in [docs/testing.md](docs/testing.md).

## Project structure

```text
apps/desktop/          React + TypeScript interface
apps/desktop/src-tauri Tauri adapter: validates and dispatches IPC requests
crates/core            Sessions, vault orchestration, tunnels, recordings
crates/ssh             SSH, SFTP and port forwarding (russh)
crates/vault           Vault format and cryptography
crates/storage         Encrypted-at-rest SQLite storage
crates/contracts       IPC contracts, generated into TypeScript
crates/pty, platform   Local terminals and OS integration (keychain, screen lock)
tests/                 UI, native end-to-end, SSH lab and performance tests
docs/                  Architecture, threat model, crypto format, decisions (ADRs)
```

The domain crates have no UI dependencies, and every crate forbids `unsafe` code. See
[docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Security

Security is the core of the project. Read the [threat model](docs/threat-model.md), the
[security invariants](docs/security-invariants.md) and the [vault format](docs/crypto-format.md).

Please **do not** report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for
how to report them privately.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. Changes are recorded in
the [changelog](CHANGELOG.md).

## License

Tyrminal is licensed under the [Apache License 2.0](LICENSE). Third-party notices are in
[NOTICE](NOTICE).

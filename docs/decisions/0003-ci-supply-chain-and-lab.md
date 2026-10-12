# 0003 — CI, supply-chain tooling and the container-free SSH lab

Status: accepted · Date: 2026-10-11

## Context

Everything verified before this record ran on one Apple Silicon Mac. The owner authorized GitHub
Actions for macOS and Windows, pushing, pull requests and a GitHub pre-release. macOS and Windows
runners do not provide Linux containers, so the Docker SSH lab cannot run there.

## Decisions

1. **Container-free lab mode** (`TYRMINAL_LAB_MODE=local`): `scripts/lab.mjs` runs the host's own
   OpenSSH `sshd` once per lab server, on loopback (`127.0.0.1`, `::1`) and random ports, with
   per-run host keys, client keys, password and `sshd_config`. Lab accounts `tyrlab`,
   `tyrlabnofwd`, `tyrlabnosess` are created and removed by the script. Because this changes the
   machine, it refuses to run unless `TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1` (set only in CI).
   - Linux/macOS: sshd runs as root (directly or via `sudo -n`); passwords go through `chpasswd`
     stdin (Linux) or a `dsimport` record file (macOS), never argv.
   - Windows: Win32-OpenSSH needs SYSTEM to log on with a public key, so each lab server is a
     temporary demand-start service; host keys are ACL-restricted to SYSTEM and Administrators;
     `DefaultShell` is Git Bash so fixtures run the same POSIX commands.
   - Lab-only relaxations, never for real servers: `StrictModes no` (files live in the CI
     checkout owned by the runner user) and, from OpenSSH 9.8, `PerSourcePenalties no`.
   - Tests read authentication activity from the sshd `-E` log file instead of `docker logs`.
   The Docker lab remains the default on Linux and gains a `TYRMINAL_LAB_REGISTRY` override (the
   image stays pinned by digest; only the registry host changes).
2. **Linux Secret Service adapter**: `zbus-secret-service-keyring-store` so the integration suite
   can exercise a real OS secret store on Linux (GNOME Keyring in a private D-Bus session in CI).
3. **Workflows**: `ci.yml` (fast checks, every push and PR), `native.yml` (Linux, macOS arm64,
   Windows x64: unit, lab, integration, security, native end to end, release build and binary
   policy), `security.yml` (cargo-deny, `pnpm audit`, gitleaks over full history, fuzz smoke),
   `release.yml` (manual; re-runs all three as reusable workflows, then packages, checksums,
   SBOMs and a GitHub pre-release). Actions are pinned by commit SHA; the default token is
   read-only; only the final publish job gets `contents: write`; no `pull_request_target`.
4. **Signing** switches on only when repository secrets exist (`APPLE_*`, `WINDOWS_CERTIFICATE*`);
   otherwise macOS bundles get an ad-hoc signature and Windows artifacts are unsigned. No keys
   are created or committed. No updater endpoint is configured.

## New tools and dependencies

| Item | Version | License | Reason |
|---|---|---|---|
| `zbus-secret-service-keyring-store` (Linux only) | 1.0.1 | MIT/Apache-2.0 | Linux Secret Service for the OS secret store port |
| cargo-deny | 0.20.2 | MIT/Apache-2.0 | Advisory, license, ban and source policy (`deny.toml`) |
| cargo-fuzz + `libfuzzer-sys` | 0.13.2 / 0.4.10 | MIT/Apache-2.0 | Fuzz targets in `fuzz/` (nightly only, not a workspace member) |
| cargo-cyclonedx | 0.5.9 | Apache-2.0 | Rust SBOMs in the release workflow |
| gitleaks | 8.30.0 (checksum-pinned) | MIT | Secret scan of the full history |
| GitHub actions: checkout 7.0.1, setup-node 7.1.0, pnpm/action-setup 6.1.0, upload-artifact 7.0.2, download-artifact 8.0.2, Swatinem/rust-cache 2.9.2 | SHA-pinned | MIT | CI |
| `tauri-plugin-dialog` (pulls `rfd` 0.16.0, `tauri-plugin-fs` 2.7.0) | 2.8.2 | Apache-2.0 OR MIT | Native open/save dialogs for backup files, called from Rust only; no dialog or fs permission is granted to the renderer (`check:release` enforces this) |
| `open` | 5.4.4 | MIT | Hands a validated http(s) link to the OS browser |
| `russh-sftp` (default features off; pulls `dashmap` 6.2.1, `serde_bytes` 0.11.19, `chrono`, `tokio-util`) | =3.0.1 | Apache-2.0 | SFTP client protocol for Phase 06. Only the raw client is used, so `tyrminal-ssh` bounds listings, keeps a fixed number of requests in flight and times every request out itself |
| `getrandom` in the desktop adapter (already used by `tyrminal-core`) | 0.4.3 | MIT/Apache-2.0 | Opaque tokens for local file grants |
| `lucide-static` (build-time icon source, not shipped as a package) | 1.47.0 | ISC | Inline SVG icons generated into `icons.tsx` |
| Playwright container image (CI/dev only) | `mcr.microsoft.com/playwright:v1.56.1-noble` by digest | Apache-2.0 | Identical fonts and Chromium for visual baselines in CI and locally |
| `Vampire/setup-wsl` (Windows CI only) | v7.0.0, commit d1da7f2c | Apache-2.0 | Debian 12 under WSL 1 as the Windows lab server (same OpenSSH, PAM and TUI apps as the Linux lab; shares Windows loopback) |
| Node.js official Linux build (Windows CI only, inside WSL) | v20.18.1, SHA-256 c6fa75c8…e567 checked before extraction | MIT | Runs `scripts/lab.mjs` inside the WSL distribution; Debian's packaged node does not execute under WSL 1 |
| Ubuntu packages (CI/dev only): WebKitGTK 4.1, GTK 3, xvfb, gnome-keyring, openssh-server | distro | various | Linux build, headless native tests, lab |

## Accepted advisories (reviewed at each release)

- **RUSTSEC-2023-0071** (`rsa`, Marvin timing side channel, medium): reached through russh for RSA
  client keys; no fixed release. Ed25519 is the generated default. Listed as a known issue.
- **RUSTSEC-2024-0370** (`proc-macro-error` unmaintained): build-time proc-macro under gtk-rs on
  Linux; no runtime code.

`deny.toml` limits the graph to desktop targets: Tauri pulls `reqwest` only for Android and iOS.
The release-policy check separately asserts no HTTP client in the desktop feature graph.

## Alternatives considered

- A Rust SSH server as the lab on macOS/Windows: rejected; the spec requires real OpenSSH.
- Docker on macOS runners: not available on Apple Silicon hosted runners.
- WSL on Windows runners: would test a Linux sshd, not the Windows behavior we need.

## Addendum (2026-10-12)

| Item | Version | License | Reason |
|---|---|---|---|
| `@axe-core/playwright` (pulls `axe-core` 4.13.x), UI tests only | =4.13.0 | MPL-2.0 | Automated WCAG 2.2 A/AA audit of the main screens (`tests/ui/accessibility.spec.ts`); never shipped |
| `sha1` in `tyrminal-core` (already in the tree through `ssh-key`; same `digest` 0.11 as `sha2`) | 0.11.0 | MIT OR Apache-2.0 | Compromised-password check (SEC-11): the k-anonymity range protocol is defined over SHA-1, so this is a protocol requirement, not a security choice (ADR 0009) |

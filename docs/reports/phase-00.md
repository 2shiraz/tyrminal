# Phase 00 — Repository discovery and execution baseline

Date: 2026-10-12 · Host: macOS 27.0.1, Apple M5, 10 cores, 24 GiB · Verdict: **gate met**

## What was found

The working directory was empty and not a git repository; there were no existing instructions or
user changes to preserve.

| Tool | Result |
|---|---|
| Rust | 1.98.1 (pinned in `rust-toolchain.toml`) |
| Node / pnpm | 24.19.0 / 11.22.0 |
| Docker | 29.7.2; Docker Desktop was installed but stopped, and was started for the lab |
| OpenSSH client tools | 10.3p1 (used only for lab key generation and a reference-client check) |
| Xcode | Command Line Tools only; no full Xcode |
| Android SDK, Windows machine | Absent |

## What was done

- `git init`; BUILD_SPEC.md preserved byte-for-byte from the supplied prompt.
- AGENTS.md, architecture and threat-model outlines, blocker register, progress tracking.
- ADR 0001: name Tyrminal, provisional Apache-2.0, provisional identifier `app.tyrminal.desktop`.
- `docs/feature-matrix.csv`: 302 rows (249 research + 26 requested + 5 historical + 22 product
  additions) generated from the spec, with a checker that fails on missing IDs, invalid statuses
  or VERIFIED without evidence.
- `pnpm doctor`: toolchain probe that never reads user SSH files or keychain items.
- `pnpm lab:up`: two pinned OpenSSH 10.0p1 containers on random loopback ports with per-run
  generated host keys, client keys and password.

## Commands and results

| Command | Exit | Result |
|---|---|---|
| `node scripts/feature-matrix.mjs && node scripts/feature-matrix.mjs --check` | 0 | 302 rows |
| `node scripts/doctor.mjs` | 0 | Windows, iOS and Android gates reported BLOCKED |
| `node scripts/lab.mjs up` | 0 | Servers a and b up with distinct fingerprints |
| Reference `ssh` client with an isolated config and a lab-only key | 0 | `lab-ok`, user `tyr` |

## Decisions

- Targets: macOS Apple Silicon (tested on this machine only) and Windows x64 (BLOCKED, B-01).
  Intel macOS is undecided. **No minimum supported OS version has been declared**; it will come
  from the pinned Tauri release's documented prerequisites plus real test coverage.
- Distribution channels: undecided. Nothing is published, signed or deployed.

## Unavailable environments

Recorded in `docs/blockers.md` (B-01 Windows, B-02 Xcode, B-03 Android, B-04 signing identity,
B-05 independent reviewer, B-06 cargo-deny/cargo-fuzz, B-07 hardware keys and adapters).

## Known gaps

- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, CHANGELOG.md, `deny.toml`, `.env.example` and
  CI workflows are not written yet.
- SECURITY.md needs a reporting contact from the owner; none will be invented.

# Phases 02 and 03 — Vault foundation and secure SSH slice (in progress)

Date: 2026-10-12 · Host: macOS 27.0.1, Apple M5 · Verdict: **neither gate is complete**

Both phases have a working vertical slice in the real application. Each still has required items
that are not built, listed below. Windows is entirely unverified (B-01).

## Commands

| Command | Exit | Result |
|---|---|---|
| `pnpm verify:fast` | 0 | 7 steps: format, clippy `-D warnings`, 107 Rust tests, contracts, TypeScript, frontend build, feature matrix |
| `pnpm test:integration` | 0 | 17 SSH lab tests, 10 core session tests, 1 Keychain test |
| `pnpm test:security` | 0 | 6 steps including the release-policy check |
| `pnpm test:native` | 0 | 9 tests against the real application; 25 consecutive runs passed |
| `node scripts/check-release.mjs --require-binary` | 0 | Release binary free of test markers |

## Phase 02 — what exists

- Crypto format v1 specified (`docs/crypto-format.md`) and implemented, with known-answer vectors
  from an independent implementation.
- Encrypted record store on a dedicated SQLite worker; owner-only files; optimistic concurrency.
- Vault service: create, unlock by passphrase or recovery key, lock with generations, passphrase
  change (rewrap) and recovery-key rotation, both atomic.
- Typed IPC contracts generated from Rust, with a staleness check.
- UI: onboarding with typed recovery-key confirmation, unlock, lock, settings.

### Phase 02 required tests

| Test | State |
|---|---|
| Wrong passphrase | Pass |
| Header/ciphertext tampering, swapped records, unsupported versions | Pass |
| Concurrent unlock, lock during unlock, lock during write | Pass |
| Canary search of DB/WAL | Pass. Temp files: none are created (`temp_store=MEMORY`). Logs: none exist yet |
| Interrupted rewrap/migration/restore | **Not done.** Atomicity relies on single SQLite transactions; there is no forced-termination test |
| Unavailable keychain | Adapter-level only (`UnavailableSecretStore`); quick unlock is not wired in |
| Disk full | **Not done.** The error mapping exists; no fault-injection test |

### Phase 02 gate

"Create → store → lock → reopen → recover → backup → restore works against real persisted files.
Fresh local mode makes no vendor network requests."

- Create → store → lock → reopen → recover: **pass** (core tests and the native app).
- Backup → restore: **not built.**
- No vendor requests: supported by static evidence (no HTTP client in the dependency graph, no
  remote URLs, CSP without remote origins). **No network capture has been taken.**

Also not built: OS quick unlock, migration fixtures beyond schema v1, a core-side idle timer, OS
lock/suspend hooks, and a memory-locking attempt for key material.

## Phase 03 — what exists

- Add a host, verify the server's identity, authenticate (key, stored password, prompted
  password, key passphrase), interactive shell, resize, disconnect; reconnect is a manual button.
- Distinct session states reported to the UI; trust and credential prompts bound to the owning
  window; fixed-text error mapping.

### Phase 03 required tests

| Test | State |
|---|---|
| Two differently keyed servers on one endpoint | Pass (adapter, core, native app) |
| Wrong password, encrypted key, unknown key, non-default port | Pass |
| IPv6 | Pass through an in-test IPv6 listener (the lab publishes IPv4 only) |
| Denied channel | Pass |
| Disconnect during authentication | Pass |
| Zero-length reads, binary output | Pass at the adapter |
| Malformed terminal output | **Not done** (no escape-sequence corpus yet) |
| Reconnect cancellation | **Not applicable yet**: automatic reconnect is not built |

### Phase 03 gate

"Real native application connects to a real disposable server and executes a harmless fixture
command. Changed keys block before credentials are sent. A mock connection does not pass."

- **Pass on macOS**: `tests/native/app.test.mjs` does exactly this against OpenSSH 10.0p1, and
  asserts the impostor server's authentication log is unchanged after a changed-key attempt.
- Windows: BLOCKED (B-01).

Also not built: automatic reconnect with backoff, keyboard-interactive authentication, RSA/ECDSA
key generation, key import from a file, safe copy/paste review for multi-line pastes, a
click-to-confirm link opener, and display of the negotiated algorithms.

## Screenshots

WebView snapshots with synthetic data are written to `docs/reports/raw/native/` by the native
suite (git-ignored): onboarding, recovery key, empty hosts, keychain, host editor, trust prompt,
terminal, locked, known hosts, changed host key.

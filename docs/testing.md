# Testing

## Commands

All commands run from the repository root. Only the commands listed here exist.

| Command | What it runs | Needs |
|---|---|---|
| `pnpm doctor` | Toolchain/SDK probe; which gates this machine can run | — |
| `pnpm verify:fast` | `cargo fmt --check`, clippy with warnings denied, all Rust unit/property/known-answer tests, contract freshness, TypeScript, frontend build, feature-matrix check | Rust, Node, pnpm |
| `pnpm lab:up` / `pnpm lab:down` | Start/stop the SSH lab (`TYRMINAL_LAB_MODE=local` runs host OpenSSH instead of Docker) | Docker, or OpenSSH server |
| `pnpm test:ui` | Browser UI behavior and visual regression (Playwright, mock backend; never native evidence) | Chromium for Playwright 1.56.1 |
| `pnpm test:ui:container` / `pnpm test:ui:update:container` | The same inside the pinned Playwright image CI uses; the only place visual baselines are recorded | Docker |
| `node scripts/check-contrast.mjs` | WCAG 2.2 AA contrast for every theme token pair and terminal scheme | Node |
| `pnpm test:integration` | SSH adapter and core session flows against the lab; LAN discovery against a DNS-SD responder on loopback; OS secret store round trip | lab |
| `pnpm test:security` | Vault, storage and core negative tests; host-trust and session-ownership lab tests; release-policy check | lab |
| `pnpm build:e2e` | Test build of the application with the embedded WebDriver server (`target/e2e`) | — |
| `pnpm test:native` | Drives the real application end to end | lab, e2e build |
| `pnpm check:release` | CSP, capabilities, feature graph, UI sources, and the release binary if built | — |
| `pnpm build:desktop` | Unsigned release build for the current platform | — |
| `pnpm contracts` / `pnpm contracts:check` | Regenerate / verify generated TypeScript contracts | — |
| `node tests/performance/measure.mjs` | Launch, unlock, idle and stream measurements | `node scripts/build-e2e.mjs --release` |
| `node --experimental-strip-types tests/performance/highlight-bench.mjs` | Output highlighting cost on a full screen of adversarial rows (budget) | Node 22+ |

A suite prints each step with its command, exit code and duration, and writes
`docs/reports/raw/verify-<suite>.json`. A step whose prerequisite is missing is `BLOCKED` and
fails the suite.

Not implemented yet (named in the spec): `test:performance` as a gate, `test:soak`,
`test:sync`, `test:mobile`, `verify:release`, `docs:check` beyond the feature matrix.

## Layers

| Layer | Where | Backend |
|---|---|---|
| Unit and property | `crates/*/src`, `crates/vault/tests` | Pure |
| Known-answer crypto | `crates/vault/tests/known_answer.rs` | Vectors from libsodium and the reference Argon2 (`tests/fixtures/vault-vectors/generate.py`) |
| Integration | `crates/storage/tests`, `crates/core/tests/vault_service.rs` | Real SQLite files |
| Integration (lab) | `crates/ssh/tests/lab.rs`, `crates/core/tests/sessions_lab.rs` | Real OpenSSH servers |
| Browser UI | `tests/ui` | Production frontend build + test-only mock backend (UI tests only) |
| Native end to end | `tests/native` | The real application binary + lab |
| Performance | `tests/performance` | Release-profile application |

Lab tests are `#[ignore]`d so `cargo test` works without Docker. When they are run, a missing lab
is a failure, never a skip. Mocks are used only in the browser UI layer, which never moves a
feature to VERIFIED.

## SSH lab

`scripts/lab.mjs` builds `tests/ssh-lab/Dockerfile` and starts two containers, each with its own
host keys, published on random loopback ports. Client keys and the password are generated per run
into `tests/ssh-lab/.run/` (git-ignored). `lab down` removes only containers labelled
`tyrminal.lab=1` and that directory.

| Item | Value |
|---|---|
| Base image | `alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8` (Alpine 3.22.6) |
| OpenSSH | `openssh-server=10.0_p1-r10` |
| Users | `tyr` (password and keys), `noforward` (forwarding denied), `nosession` (session channel denied) |
| Client keys | Ed25519, Ed25519 with passphrase, RSA 3072, ECDSA P-256, one unauthorized Ed25519 |
| Lab-only relaxation | `PerSourcePenalties no`: all tests share one NAT source address and deliberately fail authentication |

Not in the lab yet: jump host and internal-only destination, SFTP edge cases, keyboard-interactive
banner fixture, certificate-enabled server, slow/flooding server, a network fault proxy. An
in-test TCP forwarder provides "same endpoint, different server" and link cuts.

## Native tests

`pnpm build:e2e` compiles the application with the non-default `e2e` feature, which embeds
`tauri-plugin-wdio-webdriver`. The harness starts that binary with a temporary data directory and
a random loopback port, and drives it with a small W3C WebDriver client. Screenshots are WebView
snapshots saved under `docs/reports/raw/native/` (git-ignored). See ADR 0002 items 9–11 for the
limits of this setup.

## Flake policy

No retries and no blind sleeps. Every intermittent failure so far was investigated to a root
cause, and each is recorded in `docs/progress.md`. Suites were then run repeatedly: the lab suite
12 times, the PTY suite 30 times, the core session suite 6 times and the native suite 25 times,
all passing.

## CI cost

- `ci.yml` runs on pull requests and on `main` (not on every branch push, which ran it twice).
- `native.yml` skips `verify:fast` on Linux (the CI workflow runs it) and, on pull requests,
  checks the release policy statically instead of building the optimized release binary. `main`,
  manual runs and the release workflow still build and inspect the real binary.
- Debug builds keep line tables only (`[profile.dev] debug = "line-tables-only"`): readable
  panics and backtraces with much faster compiling and linking.
- Pull requests into `main` get quick checks only (owner decision): `verify:fast`, the browser
  UI suite, the secret scan and cargo-deny/npm audit. Stacked pull requests are checked once
  they target `main`. Every push to `main` runs everything (native suites on Linux, macOS and
  Windows, fuzzing); a failure there is fixed before other work. Feature rows become VERIFIED
  only from those full runs.
- A pull request that changes only documentation (`docs/`, `.claude/`, Markdown) skips the native
  suites; the job still reports success. Any other file runs everything.
- The integration, security, transfer and end-to-end steps have their own timeouts (15–25 min), so
  a hang fails within minutes instead of holding the runner for the 2-hour job limit.
- The release workflow packages installers alongside its test workflows; publishing waits for
  packaging and every test workflow.

## Upgrades and installers (Phase 09)

- `crates/core/tests/upgrade.rs` opens vaults written by earlier releases
  (`tests/fixtures/upgrade/`, synthetic data) and checks everything is still there; it runs
  with the normal Rust tests. Add a fixture whenever a release changes the schema, a record
  format or the preferences file.
- `scripts/ci/installer-smoke.mjs` runs in the native workflow on `main`, manual runs and releases, on each platform: install the
  package as a user would, start the app, uninstall, and check the user's data folder is kept.
  It refuses to run outside CI.

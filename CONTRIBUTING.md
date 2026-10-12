# Contributing

Thank you for helping. Read [AGENTS.md](AGENTS.md) first: its hard rules apply to every change,
human or automated. [BUILD_SPEC.md](BUILD_SPEC.md) is the implementation baseline.

## Ground rules

- Never weaken host-key verification, encryption, validation, test assertions or capability
  checks to make something pass. A check that cannot run is reported as BLOCKED, not passing.
- Develop with generated keys, the local SSH lab and disposable data only. Never test against real
  servers or real credentials, and never read `~/.ssh` or your keychain from tests.
- Secrets never go into argv, environment variables, URLs, logs, panics, events or test artifacts.
- Mocks are allowed only in the browser UI tests (`tests/ui`) and never count as verification.
- The domain, vault, ssh and storage crates must not depend on Tauri, React or Axum.
- Every crate has `#![forbid(unsafe_code)]`.
- A new dependency needs its version, license and reason recorded in an ADR under
  `docs/decisions/`; lockfiles stay committed.

## Setup

Prerequisites and the commands each check needs are in [docs/testing.md](docs/testing.md).

```sh
pnpm install
pnpm run doctor        # what this machine can run
pnpm verify:fast       # format, lint, types, contracts, Rust tests, feature matrix
```

Before a pull request, also run what your change touches:

| Change | Run |
|---|---|
| UI | `pnpm test:ui:container` (or `pnpm test:ui`), `node scripts/check-contrast.mjs` |
| Visual change on purpose | `pnpm test:ui:update:container`, then review the new baselines |
| SSH, sessions, vault, storage | `pnpm lab:up`, `pnpm test:integration`, `pnpm test:security` |
| Anything the app does end to end | `pnpm build:e2e`, `pnpm test:native` |
| Contracts (`crates/contracts`) | `pnpm contracts` and commit the generated files |
| Capabilities, CSP, release config | `pnpm check:release` |

## Feature matrix

`docs/feature-matrix.csv` tracks every feature. Update the rows you touch with
`node scripts/feature-matrix.mjs set ID key=value …`. `VERIFIED` requires real-backend tests
passing on the declared platforms, with `test_ids`, `platforms` and `verified_commit` filled in.
Never delete rows.

## Pull requests

Keep changes focused, describe what you tested and on which platform, and update
`CHANGELOG.md` under "Unreleased". CI must be green; security-sensitive changes should come with
their negative tests first.

By contributing you agree that your contribution is licensed under the Apache License 2.0.

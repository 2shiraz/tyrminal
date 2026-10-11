# AGENTS.md — Tyrminal execution rules

Condensed from [BUILD_SPEC.md](BUILD_SPEC.md), which stays the implementation baseline. If this file and the
spec disagree, the spec wins. The spec calls the product "LocalSSH"; the owner named it **Tyrminal**
(see [docs/decisions/0001-name-license-identifiers.md](docs/decisions/0001-name-license-identifiers.md)).

## Resume procedure

1. Read [docs/progress.md](docs/progress.md) (current phase, exact next task, checkpoint).
2. Read [docs/blockers.md](docs/blockers.md) and the rows you are about to touch in
   [docs/feature-matrix.csv](docs/feature-matrix.csv).
3. Run `pnpm doctor`, then `pnpm verify:fast`. Fix anything red before starting new work.
4. Pick the next unblocked vertical slice, write its negative tests first when it is security-sensitive,
   implement, run checks, update the matrix/progress/phase report, commit locally, continue.

## Hard rules

- Never weaken host-key verification, encryption, validation, test assertions or capability checks to
  make something pass. A blocked native test is BLOCKED, not passing.
- Development uses generated keys, the local lab (`pnpm lab:up`) and disposable data only. Do not read
  `~/.ssh`, the user's keychain items, or contact real servers or third parties.
- No publishing, pushing, deploying, production signing, emails/invitations or billable resources.
- No plaintext fallback when the OS secret store or filesystem fails.
- Secrets never go into argv, environment variables, URLs, logs, panics, events or test artifacts.
- Mocks are allowed only in UI tests. A mock never moves a feature to VERIFIED.
- Domain/vault/ssh/storage crates must not depend on Tauri, React or Axum.
- No first-party `unsafe` (`#![forbid(unsafe_code)]` in every crate) unless an ADR isolates platform FFI.
- New dependency: record version, license and reason in the relevant ADR; keep lockfiles committed.

## Feature states

`NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, `BLOCKED`, `DEFERRED_BY_SCOPE`.
`VERIFIED` requires real-backend tests passing on the declared platforms, with `test_ids`, `platforms`
and `verified_commit` filled in (`pnpm docs:check` enforces this). Never delete matrix rows.

## Commands

Only commands listed here exist. Others named in the spec (§9.5) are added as their phase lands.

| Command | What it does |
|---|---|
| `pnpm doctor` | Toolchain/SDK probe and which gates this machine can run |
| `pnpm docs:check` | Feature-matrix completeness and status validity against the spec |
| `pnpm lab:up` / `pnpm lab:down` | Start/stop the task-owned SSH lab (loopback only, generated credentials) |

See [docs/testing.md](docs/testing.md) for the growing list as later phases add `verify:fast`,
`test:integration`, `test:security` and the rest.

## Layout

`crates/` Rust core (no UI deps) · `apps/desktop/` React UI + `src-tauri/` adapter ·
`tests/ssh-lab/` lab fixtures · `scripts/` cross-platform tooling · `docs/` specs, ADRs, reports.

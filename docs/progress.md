# Progress

Updated: 2026-10-12. Read this first when resuming (see AGENTS.md).

## Where things stand

| Phase | State | Report |
|---|---|---|
| 00 Repository baseline | Gate met | `docs/reports/phase-00.md` |
| 01 Feasibility spikes | Gate met on macOS; Windows and mobile open | `docs/reports/phase-01.md` |
| 02 Vault foundation | In progress: vault works end to end; backup/restore, quick unlock and fault-injection tests missing | `docs/reports/phase-02-03.md` |
| 03 SSH vertical slice | Gate met on macOS in the real app; reconnect and keyboard-interactive missing | `docs/reports/phase-02-03.md` |
| 04–15 | Not started | |

Feature matrix: 16 rows IMPLEMENTED_UNVERIFIED (tested on macOS, Windows blocked), 15 IN_PROGRESS,
232 NOT_STARTED, 39 DEFERRED_BY_SCOPE. **Nothing is VERIFIED**: Windows is a declared platform and
nothing has been built or run there (B-01).

## What works today (macOS, Apple Silicon)

Launch with no account → create a local encrypted vault → confirm the recovery key → add hosts,
import or generate keys → connect over SSH with an explicit first-use trust decision → interactive
terminal tabs, plus a local terminal → lock (manual, on exit, or after five minutes idle, enforced
in the core) → unlock by passphrase or recovery key. A changed host key blocks the connection
before any credential is sent and can only be replaced by removing trust with a written reason.

## Evidence

| Suite | Command | Result |
|---|---|---|
| Fast | `pnpm verify:fast` | 7 steps pass; 108 Rust tests |
| Integration | `pnpm test:integration` | 17 SSH lab + 10 core session + 1 Keychain test pass |
| Security | `pnpm test:security` | 6 steps pass |
| Native | `pnpm test:native` | 9 tests on the real application pass; 25 consecutive runs |
| Release policy | `pnpm check:release` | Pass (static and release-binary inspection) |
| Performance | `node tests/performance/measure.mjs` | See phase-01 report; idle memory misses its target, unlock is faster than the target range |

## Findings worth keeping

1. russh reports a link that drops mid-authentication as an auth failure; mapped to a disconnect.
2. OpenSSH 9.8+ `PerSourcePenalties` throttles a source after failed auth; disabled in the lab
   only. Automatic reconnect (not built yet) must respect it.
3. macOS discards unread PTY output when the last slave descriptor closes; `tyrminal-pty` holds
   the slave until exit and drain.
4. GNU readline (macOS `/bin/sh`) can overwrite a resize; the session re-checks the size.
5. xterm.js 6 cannot load with `Object.prototype` frozen, so Tauri's `freezePrototype` is off.
6. macOS `seq` prints numbers from 1,000,000 in scientific notation; do not use it for
   line-exact workloads on macOS.
7. The Tauri CLI runs cargo from `src-tauri`, so a relative `CARGO_TARGET_DIR` lands elsewhere.
   A stale test binary caused a long false trail; `scripts/build-e2e.mjs` uses an absolute path.
8. `canonical_host` has no IDNA mapping yet (fails closed).

## Next tasks, in order

1. **Phase 02 gate:** specify (in `docs/crypto-format.md`) and build the encrypted portable
   backup and the validated restore with preview; add the file dialog plugin with scoped grants.
2. Quick unlock: device key slot + OS secret store, with the "store unavailable" path tested.
3. Fault injection: forced termination during header swap and record writes; disk-full.
4. OS lock/suspend hooks (lock and disconnect); single-instance guard.
5. Install cargo-deny and cargo-fuzz (B-06); write `deny.toml`; first fuzz targets for the vault
   header and record decoders.
6. Phase 03 remainder: reconnect with capped backoff, keyboard-interactive auth, negotiated
   algorithm display, escape-sequence corpus tests.
7. Idle memory: per-process footprint breakdown to explain the 212–278 MiB reading.
8. Repository hygiene: SECURITY.md (needs a contact from the owner), CONTRIBUTING.md,
   CODE_OF_CONDUCT.md, CHANGELOG.md, CI workflows, `docs/ipc-contract.md`, `docs/design-system.md`.
9. Phase 04: groups, tags, inheritance, identities, OpenSSH/CSV import, 10,000-host search.

## Questions for the owner (none block current work)

- Confirm Apache-2.0, and whether the sync server should share it.
- A security contact for SECURITY.md.
- Whether a Windows machine or CI runner will be available; every Windows claim depends on it.
- Whether the Argon2id cost should be raised given a 0.11 s unlock on this hardware.

## Resume commands

```sh
pnpm doctor
pnpm lab:up            # Docker Desktop must be running
pnpm verify:fast && pnpm test:integration && pnpm test:security
pnpm build:e2e && pnpm test:native
pnpm dev               # run the app in development
```

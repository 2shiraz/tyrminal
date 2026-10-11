# Progress

Updated: 2026-10-12. Read this first when resuming (see AGENTS.md).

## Where things stand

| Phase | State | Notes |
|---|---|---|
| 00 Repository baseline | Done | Spec preserved, feature matrix (302 rows), doctor, Docker SSH lab, blockers recorded |
| 01 Feasibility spikes | In progress | Backend spikes done and tested; Tauri window + xterm + binary stream + measurements remain |
| 02 Vault foundation | In progress | Crypto format v1 and storage implemented and tested; core services, IPC and UI remain |
| 03 SSH vertical slice | In progress | `tyrminal-ssh` adapter passes 17 real-server tests; not yet wired into an application |
| 04–15 | Not started | |

No feature in `docs/feature-matrix.csv` is VERIFIED: nothing has been exercised through a real
packaged application yet, which is what the spec requires for SSH workflows.

## Evidence so far (macOS 27.0.1, Apple M5, debug builds)

| Area | Command | Result |
|---|---|---|
| Vault crypto | `cargo test -p tyrminal-vault` | 33 passed, incl. 4 known-answer tests against libsodium/reference Argon2 vectors |
| Storage | `cargo test -p tyrminal-storage` | 13 passed (real files, CAS, atomic batches, 0600 permissions, foreign/newer refusal) |
| SSH unit | `cargo test -p tyrminal-ssh` | 9 passed |
| SSH lab | `pnpm lab:up && cargo test -p tyrminal-ssh --test lab -- --ignored` | 17 passed, 12 consecutive runs, against OpenSSH 10.0p1 containers |
| OS secret store | `cargo test -p tyrminal-platform -- --ignored` | macOS Keychain round trip passed; no item left behind |
| Local PTY | `cargo test -p tyrminal-pty` | 9 passed, 30 consecutive runs (9,600 short-lived processes) |

Windows: nothing has been built or run (blocker B-01).

## Findings worth keeping

1. **russh reports a link that drops mid-authentication as an auth failure** with no remaining
   methods. `tyrminal-ssh` maps that to `Disconnected(Authenticating)` so it is never shown as a
   wrong password.
2. **OpenSSH 9.8+ `PerSourcePenalties`** throttles a source address after failed/abandoned auth. The
   lab disables it (all tests share one NAT address). Real users can hit this after repeated
   failures; reconnect backoff (Phase 03) must respect it.
3. **macOS discards unread PTY output when the last slave descriptor closes.** Short-lived local
   programs lost their final bytes about 1 run in 40 until `tyrminal-pty` kept the slave open
   until exit and drain.
4. **GNU readline (macOS `/bin/sh`) can overwrite a resize** with the previous size (non-atomic
   get-then-set), about 1 in 150 under stress. `PtyHandle::ensure_size` re-applies it; the session
   layer must call it after a resize settles.
5. `canonical_host` does not do IDNA mapping yet. This fails closed (extra prompt, never a false
   match) and is tracked for Phase 03.

## Next task

Phase 01 remainder: create `apps/desktop` (Tauri 2.12 + React + xterm), stream PTY/SSH bytes to the
renderer over a per-session channel with acknowledgement-based backpressure, then record startup,
idle and stream measurements in `docs/reports/phase-01.md` and write ADR 0002 (dependency versions,
licenses, limitations).

Then Phase 02: `tyrminal-core` (vault state machine with lock generations, record codec with
authenticated tombstones, serialized unlock), typed IPC contracts, onboarding/unlock/lock UI,
backup/restore, canary-plaintext scan of DB/WAL files.

## Resume commands

```sh
pnpm doctor
cargo test --workspace
pnpm lab:up && cargo test -p tyrminal-ssh --test lab -- --ignored
```

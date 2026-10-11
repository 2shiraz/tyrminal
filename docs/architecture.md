# Architecture

Outline as of Phase 00–01. Sections are filled in as the code they describe lands; anything not yet
built is marked *planned*.

## Shape

```
React UI (WebView)            renders display models, sends intent
      │  typed IPC (commands + per-session channels)
Tauri adapter (src-tauri)     validates requests, checks window/handle ownership, dispatches
      │
tyrminal-core                 vault/session orchestration, jobs, lock generations
      │
domain · vault · storage · ssh · pty · platform      ports and adapters, no UI dependencies
```

Dependency direction is one-way: UI → IPC contract → application services → domain/storage/crypto/
transport ports. Platform adapters implement ports. `domain`, `vault`, `storage`, `ssh` and `pty` do not
import Tauri, React or Axum.

## Crates

| Crate | Owns | State |
|---|---|---|
| `tyrminal-vault` | Key hierarchy, KDF profiles, key slots, record envelopes, vault state machine | Phase 01–02 |
| `tyrminal-storage` | Dedicated SQLite worker thread, migrations, encrypted record rows | Phase 01–02 |
| `tyrminal-ssh` | russh adapter: host trust before auth, auth, PTY channel, bounded output | Phase 01/03 |
| `tyrminal-pty` | Local shell via portable-pty with structured argv | Phase 01/05 |
| `tyrminal-platform` | OS secret store and app-data paths | Phase 01–02 |
| `tyrminal-domain` | Host/group/identity types and inheritance | Phase 04 (planned) |
| `tyrminal-contracts` | IPC DTOs, limits, generated TypeScript | Phase 02 |
| `tyrminal-core` | Application services, session registry, lock orchestration | Phase 02–03 |

Later crates (`sftp`, `tunnels`, `automation`, `session-log`, `import-export`, `sync`, `sharing`,
`integrations`, `ai`, `diagnostics`) are created when their phase starts, not before.

## Data flow: opening an SSH session

1. UI calls `session_open(host_id, cols, rows, output_channel, event_channel)`.
2. Adapter checks the vault is unlocked and captures the vault generation.
3. Core resolves the host record (decrypted in Rust), connects, and stops in `VERIFYING_HOST`.
4. The presented host key is compared with the known-hosts records. Unknown or changed keys raise a
   prompt event; no credential or signature is produced until trust succeeds (INV-02, INV-03).
5. After authentication a PTY channel opens. Output flows through a bounded queue to the renderer's
   channel; the renderer acknowledges written bytes so the core can apply backpressure (INV-12).
6. Lock, close or a stale generation cancels the session task (INV-07).

## Secrets

Private keys, vault keys and stored passwords live only in Rust memory (zeroized on drop/lock) and OS
storage. A password typed into a prompt crosses IPC once, as a command argument, never as an event.
JavaScript memory cannot be reliably zeroized and the docs do not claim otherwise.

## Platform matrix

| Platform | Status |
|---|---|
| macOS Apple Silicon | Primary development and test host (macOS 27.0.1, Apple M5). Only this exact OS version has been exercised. |
| Windows x64 | Target. BLOCKED: no machine/runner (B-01). Nothing is claimed. |
| macOS Intel | Undecided; no runner (B-07). |
| Android, iOS/iPadOS | Phase 14. BLOCKED: B-02, B-03. |

A minimum supported OS version has **not** been declared. It will be set from the pinned Tauri release's
documented prerequisites plus actual test coverage, not guessed.

## Decisions

See `docs/decisions/`. Formats: `docs/crypto-format.md`. Threats: `docs/threat-model.md`.

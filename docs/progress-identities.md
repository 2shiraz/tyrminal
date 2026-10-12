# Progress — reusable identities (KEY-15..18)

Branch `claude/importers` (started from `claude/agent-d-inventory-snippets` at `070e13f`).
Assigned by the coordinating session on 2026-10-12; agent D's PR #5 covers PPK and the
PuTTY/MobaXterm/SecureCRT importers. Design: `docs/decisions/0008-reusable-identities.md`.

## Done

| Slice | Evidence (Linux sandbox, local lab OpenSSH 9.6p1) | Rows |
|---|---|---|
| Identity records, references from hosts and groups, resolution at use, refusals | `core:inventory::tests identities_are_read_at_use_and_the_nearest_setting_wins`; `crates/core/tests/identities.rs` 4/4 against a real vault | KEY-15, KEY-16 |
| Host and group editors pick an identity; Keychain lists and edits identities | `tests/ui/identities.spec.ts` 5/5 (mock, UI evidence only); full UI suite 88/88 locally, Keychain and Known hosts baselines re-recorded in the pinned container | KEY-17 |
| Sudo assistance: explicit, confirmed, no Enter, identity checked, no control characters | `core:vault::identity_tests` (conflict, control characters, lock); `crates/core/tests/identities_lab.rs` 2/2 (3 consecutive runs): sign-in by key then by password after one identity edit; a fake prompt receives nothing, a control shows the check counts bytes; the explicit insert reaches a real no-echo `read` and is submitted only by Enter | KEY-18 |
| Native: identity created in the real UI, host signs in with it, password typed after the shortcut and confirmation | `tests/native/identities.test.mjs` | KEY-15, KEY-17, KEY-18 |

## Notes for other owners

- AUT-05 (agent B's row) describes the same behaviour as KEY-18; it is not edited here.
- `docs/work-split.md` still lists identities in agent D's "Working on" column; the coordinator
  reassigned them. D's column is D's to edit.
- Shared files touched, each in a block marked `identities (KEY-15..18)`: `crates/contracts/src/lib.rs`,
  `dto.rs` (`HostAuth`/`HostAuthInput` variant, `GroupSummary`/`GroupInput.identity_id`),
  `crates/core/src/{records,inventory,vault,sessions}.rs`, Tauri `build.rs`, `lib.rs`,
  `commands/mod.rs`, `capabilities/main.json`, `lib/ipc.ts`, `lib/shortcuts.ts`, `app/vaultData.tsx`,
  `app/AppShell.tsx`, `palette/CommandPalette.tsx`, host/group editors, `HostsView.tsx`,
  `KeychainView.tsx`, `tests/ui/mock-backend.js`, `scripts/verify.mjs`.

## Not done / limits

- Identities from other vaults (KEY-17 "accessible vaults") wait for shared vaults.
- Signing in with a key's certificate is not wired up yet (KEY-07, tunnels owner); an identity
  using such a key signs in with the key alone until then.
- Nothing is VERIFIED: macOS/Windows CI pending.

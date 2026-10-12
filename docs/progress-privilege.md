# Progress — privilege-prompt assistance (KEY-18) and password checks (SEC-11)

Branch `claude/importers`, on top of `claude/agent-d-inventory-snippets` (PR base). Assigned by
the coordinating session on 2026-10-12. Identities (KEY-15..17) are agent D's (`ad5f7bc`); an
earlier parallel identities implementation on this branch was reverted (commits `8976f2a`,
`89a89eb`, `b98137f`) before D's branch was merged in.

## Done

| Slice | Evidence (Linux sandbox, local lab OpenSSH 9.6p1) | Rows |
|---|---|---|
| KEY-18: explicit, confirmed insertion of the host's identity password, no Enter | `core:vault::privilege_tests` (identity checked at insert time, host identity beats group identity, control characters refused, no password, nothing after a lock); `crates/core/tests/privilege_lab.rs` (fake prompt receives nothing, with a control proving the check counts bytes; wrong identity and other window refused; the insert reaches a real no-echo `read`, submitted only by Enter); `tests/ui/privilege.spec.ts` 2/2 (mock); `tests/native/privilege.test.mjs` | KEY-18 |

## Next

- SEC-11: compromised-password check (opt-in, k-anonymity, configurable endpoint, local stub
  server in tests only).

## Notes for other owners

- AUT-05 (agent B's row) describes the same behaviour as KEY-18 and is not edited here.
- Shared files, each in a block marked `privilege prompts (KEY-18)`: `crates/contracts/src/lib.rs`,
  `crates/core/src/{vault,sessions}.rs`, Tauri `build.rs`, `lib.rs`, `commands/mod.rs`,
  `capabilities/main.json`, `lib/ipc.ts`, `lib/shortcuts.ts`, `app/AppShell.tsx`,
  `palette/CommandPalette.tsx`, `tests/ui/mock-backend.js`, `scripts/verify.mjs`.

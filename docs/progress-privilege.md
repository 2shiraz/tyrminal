# Progress — privilege-prompt assistance (KEY-18) and password checks (SEC-11)

Branch `claude/importers`, on top of `claude/agent-d-inventory-snippets` (PR base). Assigned by
the coordinating session on 2026-10-12. Identities (KEY-15..17) are agent D's (`ad5f7bc`); an
earlier parallel identities implementation on this branch was reverted (commits `8976f2a`,
`89a89eb`, `b98137f`) before D's branch was merged in.

## Done

| Slice | Evidence (Linux sandbox, local lab OpenSSH 9.6p1) | Rows |
|---|---|---|
| KEY-18: explicit, confirmed insertion of the host's identity password, no Enter ([ADR 0010](decisions/0010-privilege-prompt-assistance.md)) | `core:vault::privilege_tests` (identity checked at insert time, host identity beats group identity, control characters refused, no password, nothing after a lock); `crates/core/tests/privilege_lab.rs` (fake prompt receives nothing, with a control proving the check counts bytes; wrong identity and other window refused; the insert reaches a real no-echo `read`, submitted only by Enter); `tests/ui/privilege.spec.ts` 2/2 (mock); `tests/native/privilege.test.mjs` | KEY-18 |

| Identity deletion safety (BUILD_SPEC §10.2): refused while in use unless reassigned or removed, with a preview of each host's fallback (ADR 0010 addendum) | `crates/core/tests/identity_deletion.rs` (real vault: preview, refusal, reassign, remove, reload); D's `core:inventory` updated for the explicit choice; `tests/ui/identity-deletion.spec.ts` 2/2 (mock). D's `inventory_lab` already covers sign-in following an identity edit, and `tests/native/privilege.test.mjs` signs in with an identity through the real UI | KEY-15, KEY-16 |

| SEC-11 local part: SHA-1 prefix only to a pluggable range source, padding-aware strict parser, opt-in (off by default), https-only configurable endpoint, settings UI stating what is sent | `core:password_check::tests` 3/3; `crates/core/tests/password_check.rs` 3/3 against a stub range server on loopback (requests carry only `/range/<5 hex>` and `Add-Padding`; duplicates looked up once; garbled, 500 and unreachable answers fail the check; locked vault sends nothing); `tests/ui/password-check.spec.ts` 2/2 (mock) | SEC-11 (BLOCKED: transport) |

## Blocked

- SEC-11 transport: needs an HTTPS client in the release graph, which `check-release.mjs`
  forbids. Owner decision pending: (A) off-by-default cargo feature or (B) one allowed client
  (ADR 0009).

## Notes for other owners

- AUT-05 (agent B's row) describes the same behaviour as KEY-18 and is not edited here.
- Shared files, each in a block marked `privilege prompts (KEY-18)`: `crates/contracts/src/lib.rs`,
  `crates/core/src/{vault,sessions}.rs`, Tauri `build.rs`, `lib.rs`, `commands/mod.rs`,
  `capabilities/main.json`, `lib/ipc.ts`, `lib/shortcuts.ts`, `app/AppShell.tsx`,
  `palette/CommandPalette.tsx`, `tests/ui/mock-backend.js`, `scripts/verify.mjs`.

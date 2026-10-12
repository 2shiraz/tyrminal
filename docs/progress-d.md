# Progress — agent D (inventory, keys, importers, snippets, algorithms)

Branch `claude/agent-d-inventory-snippets`, started from `f404100` (see `docs/work-split.md`).
Agent A's `docs/progress.md` stays the project-wide checkpoint; this file covers agent D's rows:
`HST-*`, `KEY-*`, `IMP-*`, `SNP-*`, `SEC-03`, `SEC-08`, `SEC-09`, `SEC-10`.

## Checkpoint

Updated: 2026-10-12.

| Slice | State |
|---|---|
| 1. Inventory presentation (HST-13) and group-wide connection (HST-06) | Done, tested (core + UI mock) |
| 2. PuTTY / MobaXterm / SecureCRT importers (IMP-04..06), known-host conversion (SEC-03) | Next |
| 3. Key generation (ECDSA, RSA), PuTTY PPK v3 (KEY-14), certificates (KEY-07), algorithm controls (SEC-08..10) | Queued |
| 4. Snippets: multi-host execution, saved targets, existing sessions, organization (SNP-05/06/07/10) | Queued |
| 5. After agent B merges: identities (KEY-15..17), environment variables (SNP-11..14), startup scripts (SNP-08), IMP-02, HST-05 | Waiting on B |

## Design notes

- **Record kinds 200+** belong to agent D (B uses 100+), so parallel branches never pick the same
  number. `200` = host appearance (the OS icon), one record per host, kept apart from the host's
  connection record so `HostRecord`/`HostInput` stay untouched until agent B's host fields land.
  Deleting a host (alone or in bulk) tombstones its appearance record in the same transaction;
  duplicating a host copies it.
- **OS icons** are chosen by the user (bulk bar, host menu). They are generic letter marks with a
  per-OS hue, not vendor logos. Nothing is detected from the server: russh exposes the server's
  identification string only inside handler callbacks that are not reliably called, and that
  path belongs to agent B.
- **Group-wide connection** lists every host of the group and its subgroups (or the selection)
  before anything connects. If they do not fit in the free panes (16 at most) the dialog refuses
  instead of opening only some. Each host opens in its own tab through the normal connect path,
  so host-key and password decisions happen per host as usual.

## Evidence

- `cargo test -p tyrminal-core --test inventory` — includes
  `host_os_is_set_in_bulk_follows_duplicates_and_goes_with_deleted_hosts` (real vault, reopened
  from disk).
- `node scripts/ui-container.mjs` — 62 passed, including `inventory-presentation.spec.ts` (5).
- `pnpm verify:fast` 7/7; `cargo test -p tyrminal-core --test sessions_lab -- --ignored --skip two_gib` 20/20 against the local lab (OpenSSH 9.6p1).

## Next commands

```sh
pnpm verify:fast
node scripts/ui-container.mjs            # needs Docker (start dockerd if it is not running)
cargo test -p tyrminal-core --test inventory
TYRMINAL_LAB_MODE=local TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 pnpm lab:up
cargo test -p tyrminal-core --test sessions_lab -- --ignored --skip two_gib
```

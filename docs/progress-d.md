# Progress — agent D (inventory, keys, importers, snippets, algorithms)

Branch `claude/agent-d-inventory-snippets`, started from `f404100` (see `docs/work-split.md`).
Agent A's `docs/progress.md` stays the project-wide checkpoint; this file covers agent D's rows:
`HST-*`, `KEY-*`, `IMP-*`, `SNP-*`, `SEC-03`, `SEC-08`, `SEC-09`, `SEC-10`.

## Checkpoint

Updated: 2026-10-12.

| Slice | State |
|---|---|
| 1. Inventory presentation (HST-13) and group-wide connection (HST-06) | Done, tested (core + UI mock) |
| 2. PuTTY / MobaXterm / SecureCRT importers (IMP-04..06), known-host conversion (SEC-03) | Done, tested (core, lab, UI mock); cloud discovery IMP-07..13 BLOCKED (third-party APIs) |
| 3. Key generation (ECDSA, RSA), PuTTY PPK v3 (KEY-14), certificates (KEY-07), algorithm controls (SEC-08..10) | Done except certificate sign-in and the per-host PQ switch (after B); hardware keys and SEC-09 BLOCKED |
| 4. Snippets: multi-host execution, saved targets, existing sessions, organization (SNP-05/06/07/10) | Done, tested (lab, real vault, UI mock) |
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

- **Importers** (`crates/core/src/importers.rs`, ADR 0006): PuTTY `.reg` exports, MobaXterm
  `.ini`/`.mxtsessions`, SecureCRT XML exports and session `.ini`. Parse only; saved passwords are
  never imported (so encrypted exports need no decryption); key files, tunnels and proxies are
  listed per host. SecureCRT XML with a DOCTYPE is refused; only predefined entities are accepted.
  Synthetic fixtures: `tests/fixtures/import/`.
- **Known-host conversion** offers hosts for trusted records without a host entry, through the
  same preview and transactional import.

- **Keys** (ADR 0006): ECDSA/RSA generation, PPK v2/v3 import with the file's Argon2 cost bounded,
  key files chosen in the page, OpenSSH user certificates checked and stored per key (record kind
  201). Fixtures made with puttygen 0.81 in `tests/fixtures/keys/` (passphrase
  `fixture passphrase`); certificates in tests are signed by the real `ssh-keygen`.
- **SEC-08:** the lab test asserts `mlkem768x25519-sha256` with OpenSSH ≥ 9.9. The Docker lab
  (10.0p1) cannot be built in this sandbox (no trusted route to the Alpine mirror from the image
  build), so only the 9.6 fallback branch has run here.

- **Snippet runs** (`crates/core/src/snippet_runs.rs`): one exec channel per chosen host on that
  host's open session in this window, so trust and sign-in already happened interactively. No PTY:
  a password prompt fails rather than being answered. Per-host exit status, signal and output
  (64 KiB per stream, control characters removed); cancellable per run (owner window only); 30 min
  and 64 MiB read caps. The dialog reviews the exact text and every target first, skips and
  reports hosts without a session, and can open sessions for them. Saved targets are record kind
  202; deleted hosts drop out and are counted.
- **Organization:** move/copy a snippet to a folder, rename a folder with its subfolders, each in
  one transaction.

- **Key files (KEY-01, owner request):** picked in a native dialog and read natively; the page only
  sees the file name. Native test `tests/native/keys.test.mjs` (added to `test:native`).
- **VERIFIED from agent A's native CI run 38232479810 (4130b7a, all three platforms):** HST-03,
  HST-04, HST-07, HST-08, HST-09, HST-10, HST-12, IMP-03, KEY-05. IMP-01 stays IN_PROGRESS:
  its scope includes key and known-host import, which is not built.

## Evidence

- `cargo test -p tyrminal-core --test inventory` — includes
  `host_os_is_set_in_bulk_follows_duplicates_and_goes_with_deleted_hosts` (real vault, reopened
  from disk).
- `cargo test -p tyrminal-core --test inventory_lab -- --ignored` (lab): known-host conversion, PQ check, snippet runs.
- `pnpm build:e2e` then `node --test tests/native/keys.test.mjs tests/native/snippets.test.mjs` under xvfb: 4/4.
- `node scripts/ui-container.mjs` — full suite green, including `inventory-presentation.spec.ts`.
- `pnpm verify:fast` 7/7; `cargo test -p tyrminal-core --test sessions_lab -- --ignored --skip two_gib` 20/20 against the local lab (OpenSSH 9.6p1).
- `cargo test -p tyrminal-ssh --test lab -- --ignored`: 16/17; `ipv6_loopback_endpoint_…` cannot bind `[::1]` in this sandbox (EAFNOSUPPORT, no IPv6 in the container), unrelated to these changes.

## Next commands

```sh
pnpm verify:fast
node scripts/ui-container.mjs            # needs Docker (start dockerd if it is not running)
cargo test -p tyrminal-core --test inventory
TYRMINAL_LAB_MODE=local TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 pnpm lab:up
cargo test -p tyrminal-core --test sessions_lab -- --ignored --skip two_gib
```

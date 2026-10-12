# Parallel work split (two agents)

Two Claude sessions build Tyrminal at the same time. This file says who owns what so their
branches merge without conflicts, and what to do when one happens anyway. AGENTS.md and
BUILD_SPEC.md §0.1 bind both agents unchanged (no weakened checks, lab and synthetic data only,
no secrets in logs or artifacts, a blocked check is BLOCKED).

| | Agent A (first session) | Agent B (second session) |
|---|---|---|
| Branch | `claude/blissful-brown-7h9l18` (PR 2shiraz/tyrminal#2) | `claude/agent-b-tunnels-logs` |
| Started from | — | commit `1fad2ce` of agent A's branch |
| Scope | Phase 06 remainder (SFTP), Phase 05 remainder (workspaces, layouts, tabs), Phase 02 remainder (screen-lock hook), snippets (Phase 08 SNP rows), Phase 09 release-candidate work | Phase 07 (port forwarding, jump hosts, proxies, agent forwarding, advanced auth) and Phase 08 history, logs and session recording |
| Feature-matrix rows | every other row (`FIL`, `WSP`, `TRM`, `HST`, `IMP`, `KEY`, `SNP`, `UX`, `VLT`, `SEC`, `P` except `P-14`/`P-16`, `CON` except those listed for B, and the later-phase `ACC`, `COL`, `MOB`, `VID`, `Q`, `H` rows) | `FWD-*`, `LOG-*`, `AUT-*`, `CON-09`, `CON-10`, `CON-11`, `CON-15`, `P-14`, `P-16` |

Each agent edits only its own rows of `docs/feature-matrix.csv` (never deletes a row).

## File ownership

**Agent B owns these new files** (agent A does not create or edit them):

- `crates/ssh/src/forward.rs`, `crates/ssh/src/jump.rs`, `crates/ssh/src/proxy.rs`, `crates/ssh/src/agent.rs`
- `crates/core/src/tunnels.rs`, `crates/core/src/history.rs`, `crates/core/src/recording.rs`
- `crates/contracts/src/tunnels.rs`, `crates/contracts/src/history.rs` (new contract modules; B does
  not add to `dto.rs`)
- `crates/core/tests/tunnels_lab.rs`, `crates/core/tests/history.rs`
- `apps/desktop/src-tauri/src/commands/tunnels.rs`, `apps/desktop/src-tauri/src/commands/history.rs`
- `apps/desktop/src/features/tunnels/`, `apps/desktop/src/features/history/`
- `apps/desktop/src/lib/messages-b.ts` (B's UI strings, exported as `msgB`)
- `tests/ui/tunnels.spec.ts`, `tests/ui/history.spec.ts`
- `docs/decisions/0004-*.md` (B's dependency and design decisions), `docs/progress-b.md`

**Agent B also owns, inside shared files:**

- `crates/core/src/sessions.rs`: the connection path — `run_ssh`, `connect`/authentication helpers
  and anything jump hosts, proxies or agent forwarding need there. Agent A does not change these
  functions while B is active (A's part of this file is the `files (SFTP)` section).
- Host connection settings for jump/proxy/agent: new fields in `crates/core/src/records.rs`
  (`HostRecord`), `HostInput`/`HostSummary` in `crates/contracts/src/dto.rs` (only those fields),
  `crates/core/src/vault.rs` `connection_plan`, and an "Advanced" section in
  `apps/desktop/src/features/hosts/HostEditor.tsx`. Agent A does not change host fields or
  `HostEditor.tsx` while B is active (reusable identities, KEY-15..17, wait until B is merged).

**Agent A owns everything else**, notably `crates/core/src/files.rs`, `crates/ssh/src/sftp.rs`,
`apps/desktop/src/features/{files,terminal,snippets,palette,home,settings,vault,credentials}/`,
`apps/desktop/src/app/workspace.ts`, `apps/desktop/src/lib/messages.ts`, `docs/progress.md`,
`docs/releases/`, `.github/workflows/`, `scripts/`.

## Shared files: append-only, in a marked block

Both agents may add to these, never reorder or rewrite the other's lines. Agent B puts its
additions in one contiguous block at the end of the relevant list, opened with a comment
`// agent B: tunnels and history` (or `#`/`/* */` as the syntax needs; JSON has no comments, so in
`capabilities/main.json` B appends its entries at the end of the `permissions` array).

| File | What goes there |
|---|---|
| `apps/desktop/src-tauri/build.rs` | command names (`COMMANDS`) |
| `apps/desktop/src-tauri/capabilities/main.json` | `allow-*` permissions |
| `apps/desktop/src-tauri/src/lib.rs` | `generate_handler!` entries |
| `apps/desktop/src-tauri/src/commands/mod.rs` | `pub mod` lines |
| `crates/contracts/src/lib.rs`, `crates/core/src/lib.rs`, `crates/ssh/src/lib.rs` | `mod`/`pub use` lines |
| `crates/contracts/src/limits.rs` | new constants at the end |
| `apps/desktop/src/lib/ipc.ts` | B adds `export const tunnels`/`history` at the end of the file |
| `apps/desktop/src/lib/shortcuts.ts` | new action ids at the end of the union and of each binding map |
| `apps/desktop/src/features/palette/CommandPalette.tsx` | one `list.push(...)` per action |
| `apps/desktop/src/app/AppShell.tsx` | the smallest hook-up possible (a destination or panel); no refactors |
| `apps/desktop/src/components/layout/Sidebar.tsx`, `StatusBar.tsx` | one entry each |
| `apps/desktop/src/components/ui/icons.list` + regenerated `icons.tsx` | new names at the end |
| `apps/desktop/src/styles/global.css` | B's rules at the end of the file, under its comment |
| `tests/ui/mock-backend.js` | B's handlers in one block at the start of `handlers` |
| `scripts/verify.mjs` | B's new suites in one block |

Neither agent refactors, renames or reformats a shared file beyond its own lines. A change that
needs more (for example moving code both use) is written down under "Requests" below and done by
the owner.

## Generated files and lockfiles

Never merge these by hand; regenerate them after resolving the sources:

- `packages/contracts/src/generated/*` → `pnpm contracts`
- `apps/desktop/src-tauri/permissions/autogenerated/*` and `gen/schemas/*` → `cargo build -p tyrminal-desktop`
- `Cargo.lock` → take either side, then `cargo build --workspace` (`cargo update -w` if needed)
- `pnpm-lock.yaml` → take either side, then `pnpm install`
- `apps/desktop/src/components/ui/icons.tsx` → `python3 scripts/gen-icons.py …` with the merged `icons.list`
- visual baselines → `node scripts/ui-container.mjs visual.spec.ts --update-snapshots=all -g <test>` for the tests whose screens changed

## Merge protocol

1. Each agent commits small, runs `pnpm verify:fast` plus the lab suites it touched before every
   push, and pushes only its own branch. No force-push, no rebase of pushed commits.
2. Agent A's PR (2shiraz/tyrminal#2) merges into `main` when its CI is green.
3. Agent B then merges `main` into its branch (a merge commit, not a rebase), resolves conflicts
   with the rules above, regenerates generated files, runs `pnpm verify:fast`, the UI suite and the
   lab suites, pushes, and opens its own PR into `main`.
4. Whichever PR merges second is responsible for a green `main` after it: CI on the merge result
   must pass before merging.
5. Agent A does the final integration pass on `main` after both are in (full native CI on all
   three platforms) and updates `docs/progress.md` from `docs/progress-b.md`.
6. Neither agent dispatches the release workflow or creates tags; that stays with agent A.

### Resolving a conflict

- In an append-only list: keep both sides' lines (A's block, then B's block).
- In a row of the feature matrix: the row's owner (table above) wins.
- In a file one agent owns: the owner's version wins; re-apply the other side's change only if
  it was a listed shared addition.
- Anything else: keep both behaviours, run the tests of both sides, and record what was done in
  the merge commit message.

## Status (each agent edits only its own column)

| | Agent A | Agent B |
|---|---|---|
| Working on | SFTP remainder: folder transfers, large-file and interrupted-link tests, external editing | — |
| Done since split | — | — |
| Blocked | — | — |

## Requests (one agent asking the other for a change in a file it owns)

None yet.

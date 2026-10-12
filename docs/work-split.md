# Parallel work split (four agents)

Four Claude sessions build Tyrminal at the same time. This file says who owns what so their
branches merge without conflicts, and what to do when one happens anyway. AGENTS.md and
BUILD_SPEC.md §0.1 bind every agent unchanged (no weakened checks, lab and synthetic data only,
no secrets in logs or artifacts, a blocked check is BLOCKED). Goal: every desktop feature of
phases 02–09 implemented and verified; phases 10+ are out of scope for now.

| | Agent A (integrator) | Agent B | Agent C | Agent D |
|---|---|---|---|---|
| Branch | `claude/blissful-brown-7h9l18` (PR 2shiraz/tyrminal#2) | `claude/agent-b-tunnels-logs` | `claude/agent-c-workspaces` | `claude/agent-d-inventory-snippets` |
| Started from | — | `ed76320` | `79c22d7` | `79c22d7` |
| Scope | Phase 06 remainder (SFTP), Phase 02/03 leftovers (vault, secret store, recovery, formats, local terminal, escape permissions), Phase 09 release candidate, merging everyone's work | Phase 07 tunnels, jump hosts, proxies, agent forwarding, advanced auth; Phase 08 history, logs, recording | Phase 05: tabs (duplicate/detach), workspaces, split/focus layouts, pane reorder, named layout templates and restore, status indicators, shortcuts and keyboard customization, encodings/emulation, output highlighting, command palette and recent connections, broadcast target review | Phase 04 remainder (protocol settings, inherited workflow settings, group-wide connect, inventory presentation, key import/generation incl. formats and certificates, PuTTY/MobaXterm/SecureCRT importers, known-host conversion), Phase 08 snippets (multi-host, saved targets, startup scripts, organization, environment variables), post-quantum/algorithm controls |
| Matrix rows | `FIL-*`, `VLT-*`, `SEC-*` except D's, `P-*` except others', `CON-02..06`, `CON-08`, `CON-12..14`, `UX-01`, `UX-02`, `UX-05`, `UX-06` | `FWD-*`, `LOG-*`, `AUT-*`, `CON-09`, `CON-10`, `CON-11`, `CON-15`, `P-14`, `P-16` | `TRM-*`, `WSP-*`, `UX-03`, `UX-04`, `P-13` | `HST-*`, `KEY-*`, `IMP-*`, `SNP-*`, `SEC-03`, `SEC-08`, `SEC-09`, `SEC-10` |

Each agent edits only its own rows of `docs/feature-matrix.csv` (never deletes a row). Rows that
need third parties or later phases (cloud discovery, team vaults, mobile) are marked BLOCKED or left
NOT_STARTED with a reason; nobody contacts a real cloud API.

**Ordering constraints between agents:**

- Host fields: B adds jump/proxy/agent fields first. D's reusable identities (KEY-15..17), per-host
  environment variables (SNP-11..14) and startup scripts (SNP-08) also add host fields; D starts
  those only after B's PR has merged into `main` and D has merged `main` (do the other D rows first).
- IMP-02 (jump-host conversion in the OpenSSH importer) needs B's jump hosts: also after B merges.

## Agents C and D: files they own

**Agent C** owns: `apps/desktop/src/app/workspace.ts`, `apps/desktop/src/app/AppShell.tsx` (others add
only one-line hook-ups, see below), `apps/desktop/src/components/layout/{TabStrip,PaneGrid,Sidebar}.tsx`,
`apps/desktop/src/features/{terminal,palette,home}/` (terminal: `TerminalController.ts`, `TerminalView.tsx`,
`terminalPolicy.ts`), `apps/desktop/src/lib/shortcuts.ts`, new `crates/core/src/layouts.rs` and
`crates/contracts/src/layouts.rs`, `apps/desktop/src-tauri/src/commands/layouts.rs`,
`apps/desktop/src/features/layouts/`, `apps/desktop/src/lib/messages-c.ts` (`msgC`),
`tests/ui/{workspaces,terminal}*.spec.ts`, `tests/native/terminal.test.mjs`, `docs/progress-c.md`,
`docs/decisions/0005-*.md`.

**Agent D** owns: `crates/core/src/{inventory,import}.rs`, new `crates/core/src/{identities,importers,envvars}.rs`,
`crates/core/src/validate.rs` (host/key validation parts), `crates/ssh/src/{auth,algorithms}.rs`
(key formats, certificates, algorithm preferences), `crates/vault/` key parsing if needed,
`apps/desktop/src/features/{hosts,credentials,snippets}/` (except B's "Advanced" section in
`HostEditor.tsx`), `apps/desktop/src-tauri/src/commands/{inventory,snippets}.rs`, new contract module
`crates/contracts/src/inventory.rs` for new types, `apps/desktop/src/lib/messages-d.ts` (`msgD`),
`tests/ui/{inventory,snippets}*.spec.ts`, `tests/native/snippets.test.mjs`, `crates/core/tests/inventory.rs`,
`docs/progress-d.md`, `docs/decisions/0006-*.md`.

`crates/core/src/vault.rs` and `crates/core/src/records.rs` are shared: append new record kinds and
methods in a marked block per agent; never reorder existing code. Agent A keeps everything else.

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

No agent refactors, renames or reformats a shared file beyond its own lines. Agents C and D use
the same rule as B: their additions to shared lists go in one contiguous block opened with a comment
naming the agent (`// agent C: workspaces`, `// agent D: inventory and snippets`). A change that
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
2. Agent A's PR (2shiraz/tyrminal#2) merges into `main` when its CI is green. After that every agent
   merges `main` into its own branch regularly (at least after each finished slice), so conflicts stay
   small, and opens a draft PR into `main` once its first slice is done.
3. To merge a PR: merge `main` into the branch (a merge commit, not a rebase), resolves conflicts
   with the rules above, regenerates generated files, runs `pnpm verify:fast`, the UI suite and the
   lab suites, pushes, and opens its own PR into `main`.
4. Whichever PR merges second is responsible for a green `main` after it: CI on the merge result
   must pass before merging.
5. Agent A does the final integration pass on `main` after both are in (full native CI on all
   three platforms) and updates `docs/progress.md` from `docs/progress-b.md`.
6. No agent other than A dispatches the release workflow or creates tags.

### Resolving a conflict

- In an append-only list: keep both sides' lines (A's block, then B's block).
- In a row of the feature matrix: the row's owner (table above) wins.
- In a file one agent owns: the owner's version wins; re-apply the other side's change only if
  it was a listed shared addition.
- Anything else: keep both behaviours, run the tests of both sides, and record what was done in
  the merge commit message.

## Status (each agent edits only its own column)

| | Agent A | Agent B | Agent C | Agent D |
|---|---|---|---|---|
| Working on | SFTP: two-pane local/remote view, remote-to-remote copy, drag and drop, keep-both conflicts | Phase 07 forwarding | — | Waiting for agent B's merge (identities, environment variables, startup scripts, certificate sign-in, per-host PQ switch, IMP-02, HST-05) |
| Done since split | Folder transfers, lost-link and 2 GiB tests, external editing | — | — | Inventory presentation (sort, select all/range, OS icons), group-wide connection; PuTTY/MobaXterm/SecureCRT importers, known-host conversion; ECDSA/RSA generation, PPK v2/v3, user certificates (import/check); snippet runs on several hosts with saved targets, snippet organization |
| Blocked | — | — | — | Cloud discovery IMP-07..13 (third-party APIs); hardware keys KEY-08..13; SEC-09 (not in russh); certificate sign-in and per-host PQ switch wait for B's connection path |

## Requests (one agent asking the other for a change in a file it owns)

- **A → C:** `tests/ui/accessibility.spec.ts` (axe-core, WCAG 2.2 A/AA) finds two violations in
  `TabStrip.tsx`: `aria-required-children` (the `tablist` contains elements that are not tabs) and
  `nested-interactive` (a close button inside each draggable tab). Please fix them and remove the
  `.exclude(".tabstrip")` line in that spec.

- **A → C (done by A in A's branch, keep when merging):** `AppShell.tsx` passes `others` (the other
  connected SSH sessions, for "Copy to another server") to `FilesPanel`, right below its `target`
  prop. Four lines; nothing else in AppShell changed.

- **A → B (already done by A, keep it when merging):** in `crates/core/src/sessions.rs` `run_ssh`, the
  connection is now stored in the registry entry *before* `SessionState::Connected` is reported
  (it used to be stored after), so a file or key-install call made right after "connected" no
  longer fails with "works in a connected SSH session only". Three lines moved; nothing else in the
  connection path changed. If B restructures `run_ssh`, keep this ordering.

- **A → D (2026-10-12, coordinator):** agent A moved AUT-01..04, AUT-12 and P-14 to agent D for
  throughput (B had not started them). D builds them in `apps/desktop/src/features/autocomplete/`
  (new, D's) with one-line hook-ups in `AppShell.tsx`, `shortcuts.ts` (new action `suggest`, at the
  end) and `CommandPalette.tsx`. Update (A, 2026-10-12): AUT-01 stays with agent B (command
  history); AUT-06/07 (shell integration) go to D.

- **D → C/A (AUT-06, shell integration marks):** `TerminalController.ts` gets one marked line after
  the OSC 52 handler, `this.cleanups.push(attachShellContext(this.term, () => this.sessionId));`,
  plus its import. It registers OSC 7 and OSC 133 handlers (bounded, validated, display and
  suggestions only; nothing runs). `CommandPalette.tsx` gets an optional `onShellIntegration` prop
  and one entry; `AppShell.tsx` opens `IntegrationDialog` from it. Please keep them when merging.

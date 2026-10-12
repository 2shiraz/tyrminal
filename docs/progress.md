# Progress

Updated: 2026-10-12. Read this first when resuming (see AGENTS.md).

## Where things stand

Work is split between four agents (A: files, platform, protocols, release; B: tunnels, jump
hosts, proxies, logs; C: workspaces, tabs, terminal; D: inventory, keys, importers, snippets,
suggestions), see `docs/work-split.md`. Owner requests are logged in `docs/requests.md`.

| Phase | State |
|---|---|
| 00–03 | Gate met (reports in `docs/reports/`); screen-lock hook done (ADR 0007) |
| 04 Inventory | Groups, tags, search, bulk, duplicate, imports, key deployment on main; presentation, PuTTY/MobaXterm/SecureCRT, keys (ECDSA/RSA, PPK, certificates, key files) in PR #5 (D) |
| 05 Workspace | Tabs, splits, broadcast on main; layouts, detach-to-window (handoff core done by A) in PR #7 (C) |
| 06 Files | SFTP browser, transfers, folders, two panes, copy between servers, edit sessions, desktop drop on main; Files panel keeps its place per session (#14) on main; SFTP tab with files-only connections on `claude/sftp-tab` |
| 07 Connections | Forwarding, jump hosts, proxies in PR #6 (B); Telnet, serial, protocol per host, encodings and terminal type on A's branch; Mosh deferred (ADR 0008) |
| 08 Automation | Multi-host snippet runs, suggestions, shell integration on main; the shell's folder opens the files panel and carries into duplicated tabs, mark events for history (PR #10); logs and history next (B) |
| 09 Release candidate | Diagnostics consent, update controls, user guide, upgrade test from beta.1, installer smoke test on A's branch |
| 10–15 | Not started (sync, teams, mobile) |

Pre-release v0.1.0-beta.1 is published; v0.1.0-beta.2 follows once PR #6 and PR #5 merge.

## Findings worth keeping

1. russh reports a link that drops mid-authentication as an auth failure; mapped to a disconnect.
2. OpenSSH 9.8+ `PerSourcePenalties` throttles a source after failed auth; disabled in the lab only.
   Auto-reconnect backs off exponentially with jitter, which also respects it.
3. macOS discards unread PTY output when the last slave descriptor closes; `tyrminal-pty` holds the
   slave until exit and drain.
4. GNU readline (macOS `/bin/sh`) can overwrite a resize; the session re-checks the size.
5. xterm.js 6 cannot load with `Object.prototype` frozen, so Tauri's `freezePrototype` is off.
6. macOS `seq` prints numbers from 1,000,000 in scientific notation; tests use an awk counter.
7. A relative `CARGO_TARGET_DIR` lands in `src-tauri`; `scripts/build-e2e.mjs` uses an absolute path.
8. `canonical_host` has no IDNA mapping yet (fails closed).
9. Closing a session cancels its task: any vault write in that task must run in its own task, or
   the in-memory revision falls behind the database (fixed for recent-connection marks).
10. GitHub runners: macOS limits Remote Login to `com.apple.access_ssh`; Linux home is 750 so
    `authorized_keys` must live elsewhere; Win32-OpenSSH loads host keys only if SYSTEM or
    Administrators own them, and elevated processes leave an explicit Administrators ACE.
11. Visual baselines are only stable in one pinned image (fonts); record them with
    `pnpm test:ui:update:container`.
12. A session state change must not steal focus from a field the user moved to (tab rename).
13. russh ends a channel stream with `ChannelMsg::Close` when the server closes it and with
    nothing when the connection is gone; only the second is a lost link (auto-reconnect).
14. Debian's packaged node does not execute under WSL 1; CI uses the official build there.
    Git Bash rewrites POSIX-looking environment values into Windows paths, so paths for the
    WSL side are chosen inside WSL, and `wsl.exe -e` avoids a login shell re-parsing arguments.
15. macOS: text typed through WebDriver must be ASCII (CJK and emoji never reached the shell);
    after an interrupt zsh continues a `;` list where bash abandons it.

## Next tasks, in order

1. Merge PR #6 (B), then PR #5 (D) after it merges main; run the release workflow for
   v0.1.0-beta.2 (notes in `docs/releases/v0.1.0-beta.2.md`).
2. Open agent A's PR (handoff, desktop drop, diagnostics, updates, protocols, encodings,
   Phase 09 tests) after those merges; mark rows VERIFIED from its three-platform native run.
3. Merge PR #7 (C).
4. Keep every agent's queue full (`docs/work-split.md`); everything before Phase 10 is assigned.

## Questions for the owner (none block current work)

- Confirm Apache-2.0, and whether the sync server should share it.
- A security contact for SECURITY.md and CODE_OF_CONDUCT.md (placeholders say so).
- Whether the Argon2id cost should be raised given a 0.11 s unlock on Apple Silicon.

## Resume commands

```sh
pnpm doctor
pnpm lab:up            # Docker, or TYRMINAL_LAB_MODE=local TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 (disposable machines)
pnpm verify:fast && pnpm test:integration && pnpm test:security
pnpm build:e2e && pnpm test:native
pnpm dev               # run the app in development
```

# Progress

Updated: 2026-10-12. Read this first when resuming (see AGENTS.md).

## Where things stand

| Phase | State | Report |
|---|---|---|
| 00 Repository baseline | Gate met | `docs/reports/phase-00.md` |
| 01 Feasibility spikes | Gate met on macOS; Linux in this sandbox; Windows via CI in progress | `docs/reports/phase-01.md` |
| 02 Vault foundation | Backup/restore (format §10, vectors, native test), quick unlock via the OS secret store, lock on system sleep, single instance per data directory, kill-the-writer and disk-full fault injection: done. An OS screen-lock hook remains | `docs/reports/phase-02-03.md` |
| 03 SSH vertical slice | Keyboard-interactive, negotiated-algorithm display, auto-reconnect done (native test kills the server process; passes on Linux) | `docs/reports/phase-02-03.md` |
| UX track (§3 of the 2026-10 brief) | UI redesign, first-class terminal, snippets: done and tested on Linux; CI on macOS/Windows in progress | this file |
| 04–15 | Not started | |

Feature matrix: see `node scripts/feature-matrix.mjs --check` (29 IMPLEMENTED_UNVERIFIED,
18 IN_PROGRESS, 216 NOT_STARTED, 39 DEFERRED_BY_SCOPE on 2026-10-12). **Nothing is VERIFIED**
until the native suites pass in CI on macOS arm64 and Windows x64 (the declared platforms).

## Evidence (2026-10-12)

Linux x64 sandbox (Ubuntu 24.04, 4 cores, local lab = host OpenSSH 9.6p1, WebKitGTK under
xvfb): `verify:fast` 7/7; ssh lab 16/17 (IPv6 loopback absent in this sandbox only); core lab
14/14; native app 9/9, terminal 12/12, snippets 3/3, backup 3/3; browser UI 38/38 in the
pinned Playwright image. Measurements: `docs/reports/performance/2026-10-12-linux-x64-sandbox.json`.

CI (PR https://github.com/2shiraz/tyrminal/pull/1), native workflow run 38205380325 on commit
03d906f: **macOS arm64 (macos-15) and Linux x64 (ubuntu-24.04) fully green**: fast 7/7,
integration 3/3, security 6/6, native 4/4 suites (app, terminal with vim/nano/tmux/htop/mc,
snippets, backup), 0 blocked; unsigned release build and the release policy check against the
built binary pass on both. Linux has been green on four runs in a row. Windows x64: fast
checks pass; the WSL lab server is being brought up (Node inside WSL fixed in 0723e73).

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

1. Windows native job green (lab server in WSL 1, Debian 12, official Node 20 inside WSL).
   macOS and Linux are green (see Evidence).
2. Windows lab = Linux OpenSSH in WSL 1, so tmux/htop/mc and PAM keyboard-interactive run there
   too; the local Win32-OpenSSH mode remains for developers without WSL.
3. When all three are green: mark matrix rows VERIFIED with `verified_commit`, merge the PR,
   write `docs/releases/v0.1.0-beta.1.md`, run the release workflow (pre-release, unsigned).
4. Phase 02 remainder: OS screen-lock hook (needs platform APIs and an ADR for any FFI);
   verify sleep-lock on a real suspend.
5. Phases 04–09 (groups/tags/identities/imports, workspaces/broadcast, SFTP, tunnels, logs).

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

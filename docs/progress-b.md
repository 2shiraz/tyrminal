# Progress — agent B (Phase 07 tunnels/connections, Phase 08 history/logs)

Updated: 2026-10-12. Agent B's checkpoint; agent A's is `docs/progress.md`. Scope, file ownership
and the merge protocol are in `docs/work-split.md`. Branch `claude/agent-b-tunnels-logs`.

## Done

| Slice | Evidence (Linux sandbox, local lab OpenSSH 9.6p1) | Matrix |
|---|---|---|
| SSH forwarding adapter: local, remote, SOCKS5; loopback-only binds; limits; lifecycle | `crates/ssh/src/forward.rs` unit tests 6/6; `crates/ssh/tests/forward_lab.rs` 9/9, 5 consecutive runs | FWD-01/02/03/05/07 |
| Server-opened channels refused unless requested (agent, X11, session, …) | `client.rs` additive block; existing `crates/ssh/tests/lab.rs` 16/17 (the one failure is B-09, no IPv6 loopback here) | — |
| Saved rules in the vault (kind 100), validation, duplicate, auto-start, session-scoped runs, cleanup on every session end | `crates/core/src/tunnels.rs` unit tests 4/4; `crates/core/tests/tunnels_lab.rs` 6/6, 8 consecutive runs; `sessions_lab` 17/17 | FWD-04/05/08 |
| Tunnels page: rules, start on a connected session, active list with counters, stop, exposure confirmation | `tests/ui/tunnels.spec.ts` (mock backend, UI evidence only); full UI suite 59/59 in the pinned container | FWD-06 |
| Jump hosts: per-host jump host (chains by pointing hosts at each other, ≤ 8 hosts, no loops); every hop verified and authenticated in order over the previous hop's `direct-tcpip` channel; tunnels over chained sessions | `crates/core/tests/tunnels_lab.rs` 10/10, 5 consecutive runs (changed bastion key blocks before any credential reaches the impostor or the inner host; refusing bastion; trust order; loops); `sessions_lab` 17/17; UI Advanced section | CON-09 |
| Proxies: HTTP CONNECT and SOCKS5 with authentication for the first hop; write-only proxy password; tunnels over proxied sessions | `crates/ssh/src/proxy.rs` unit tests 9/9 (refusals, auth required/rejected, oversized/malformed replies, timeouts, redacted `Debug`); `crates/ssh/tests/proxy_lab.rs` 3/3 (in-test proxies, real sshd, impostor proxy refused by the host-key check); `tunnels_lab` 11/11 | CON-10, FWD-09 |
| Prompts name the jump-chain hop ("Jump host 1 of 2: bastion") | `tunnels_lab` asserts each hop's position and label; UI tests (mock) | CON-09 |
| Recording format: `crates/session-log`, STREAM-BE32 over XChaCha20-Poly1305 (`aead-stream` 0.6.0), per-file key from `K_logs`, header bound as AAD, padded chunks, size limit, Complete/Incomplete/Damaged reading | `crates/session-log/tests/format.rs` 14/14: a cut at every byte and a flipped bit at every byte never read as complete and show only original events; reordered, dropped, repeated, spliced and foreign chunks; flag flips; trailing data; wrong key/identity; limit never exceeded; proptest round trip; mutation (no AAD) fails 8 tests | LOG-01 |
| Recording in core: output-only tee on the session sink (typed input cannot reach it), per-vault switch (off by default; off stops running recordings and keeps them; delete one/all separate), per-host retention plus bookmarks, comments, lock ends and later completes the record, owner-only files | `crates/core/tests/history.rs` 7/7, 3 runs (hidden `stty -echo` answer never recorded, mutation that records input fails it; no plaintext output/title/answer anywhere on disk; 0700/0600; cut/damaged/missing files; size limit; lock); `tunnels_lab` 12/12 incl. SSH recording without the hidden answer | LOG-01/02/03/04/10, P-16 |
| Recordings page: switch and limits, storage indicator, newest-first list, search, bookmark filter, comment dialog, delete/delete all with confirmation, read-only player (replay at 1–8×, find, OSC 8/52/title/input inert) | `tests/ui/history.spec.ts` 6/6 incl. axe WCAG 2.2 AA in both themes; mutation (default link handler) fails the read-only test; full UI suite 78/78 | LOG-05/06/07 |
| Post-quantum key exchange per host: prefer (default, `mlkem768x25519-sha256` first, X25519 fallback), require (refused during key exchange, before trust or sign-in), off (compatibility) | `algorithms` unit test; `crates/ssh/tests/kex_lab.rs` 3/3 ×3 against OpenSSH 9.6 (fallback, off, require refused with no authentication in the server log); the ML-KEM end-to-end test is BLOCKED here (needs OpenSSH ≥ 9.9; container image pull rate-limited); `tunnels_lab` 13/13 ×3, a mutant that ignores the setting fails; UI (mock) | SEC-08, SEC-10 |

Design decisions: `docs/decisions/0004-tunnels-and-connection-path.md`.

## Next tasks, in order

1. Tunnel runs follow their session when it moves to another window (after the handoff change lands).
2. Sign-in with a user certificate (KEY-07, lab CA), OpenSSH `ProxyJump` import as jump hosts
   (IMP-02), jump host and proxy inherited from groups (HST-05).

## Known limits

- Recordings: a backup carries recording records but not their files, so a restored vault lists
  them as "File missing"; playback shows at most 16 MiB of output; search inside recordings works
  in the open recording only; resizes are recorded, typed input never is (so a remote program that
  echoes a password it reads would still show it, as on screen).

- Lab proof of routing through the bastion is behavioural (the inner server sees no traffic
  before the bastion is trusted; a bastion with `AllowTcpForwarding no` stops the chain): in the
  local lab every sshd shares this machine's loopback, so the inner server is not unreachable
  directly.

## Resume

```sh
TYRMINAL_LAB_MODE=local TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 pnpm lab:up
cargo test -p tyrminal-ssh --test forward_lab -- --ignored
cargo test -p tyrminal-core --test tunnels_lab -- --ignored
cargo test -p tyrminal-core --test sessions_lab -- --ignored
cargo test -p tyrminal-core --test history
cargo test -p tyrminal-session-log
pnpm verify:fast
dockerd &  # if needed
node scripts/ui-container.mjs tunnels.spec.ts
```

# Progress — agent B (Phase 07 tunnels/connections, Phase 08 history/logs)

Updated: 2026-10-12. Agent B's checkpoint; agent A's is `docs/progress.md`. Scope, file ownership
and the merge protocol are in `docs/work-split.md`. Branch `claude/agent-b-tunnels-logs`.

## Done

| Slice | Evidence (Linux sandbox, local lab OpenSSH 9.6p1) | Matrix |
|---|---|---|
| SSH forwarding adapter: local, remote, SOCKS5; loopback-only binds; limits; lifecycle | `crates/ssh/src/forward.rs` unit tests 6/6; `crates/ssh/tests/forward_lab.rs` 9/9, 5 consecutive runs | FWD-01/02/03/05/07 |
| Server-opened channels refused unless requested (agent, X11, session, …) | `client.rs` additive block; existing `crates/ssh/tests/lab.rs` 16/17 (the one failure is B-09, no IPv6 loopback here) | — |
| Saved rules in the vault (kind 100), validation, duplicate, auto-start, session-scoped runs, cleanup on every session end | `crates/core/src/tunnels.rs` unit tests 4/4; `crates/core/tests/tunnels_lab.rs` 6/6, 8 consecutive runs; `sessions_lab` 17/17 | FWD-04/05/08 |
| Tunnels page: rules, start on a connected session, active list with counters, stop, exposure confirmation | `tests/ui/tunnels.spec.ts` 3/3 (mock backend, UI evidence only); full UI suite 58/58 in the pinned container | FWD-06 |

Design decisions: `docs/decisions/0004-tunnels-and-connection-path.md`.

## Next tasks, in order

1. Jump hosts (CON-09, FWD-09): chain through `connect_stream` over a `direct-tcpip` channel;
   every hop's host key through the same trust prompt (with the hop named); lab needs a second
   sshd reachable only through the first (`PermitOpen`), plus a changed-bastion-key negative test.
2. Proxies (CON-10): HTTP CONNECT and SOCKS5 client with authentication; in-test proxy servers;
   auth rejection test.
3. Agent forwarding (CON-11): built-in agent over vault keys, off by default, approval scoped to
   host/chain; refuse unrequested agent channels (already refused).
4. Connection diagnostics (CON-15).
5. Phase 08 history/logs/recording (LOG-*, P-16).

## Resume

```sh
TYRMINAL_LAB_MODE=local TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 pnpm lab:up
cargo test -p tyrminal-ssh --test forward_lab -- --ignored
cargo test -p tyrminal-core --test tunnels_lab -- --ignored
cargo test -p tyrminal-core --test sessions_lab -- --ignored
pnpm verify:fast
dockerd &  # if needed
node scripts/ui-container.mjs tunnels.spec.ts
```

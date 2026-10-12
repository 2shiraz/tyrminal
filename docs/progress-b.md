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

Design decisions: `docs/decisions/0004-tunnels-and-connection-path.md`.

## Next tasks, in order

1. Agent forwarding (CON-11): built-in agent over vault keys, off by default, approval scoped to
   host/chain; refuse unrequested agent channels (already refused).
2. Connection diagnostics (CON-15).
3. Phase 08 history/logs/recording (LOG-*, P-16).

## Known limits

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
pnpm verify:fast
dockerd &  # if needed
node scripts/ui-container.mjs tunnels.spec.ts
```

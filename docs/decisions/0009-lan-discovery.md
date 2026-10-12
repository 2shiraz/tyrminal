# ADR 0009: LAN discovery of SSH servers (DNS-SD)

Status: accepted, 2026-10-12

## Context

Matrix row HST-14 (reference: an Android client's network/service discovery) asks for finding SSH
servers on the local network. BUILD_SPEC §4 allows LAN discovery only with "a user-selected scope
and explicit start", and providers/imports never scan arbitrary networks. Port scanning is out of
the question; DNS-SD over multicast DNS (RFC 6762/6763) is how servers announce themselves
(`_ssh._tcp`, as Avahi, macOS Remote Login and many NAS systems do).

## Decision

- **Opt-in and scoped.** Hosts → "Find on network…" opens a dialog that sends nothing. The user picks one
  network interface (listed from the local interface table, loopback and point-to-point links
  excluded) and presses Start. Only then does the core browse `_ssh._tcp.local.` on that interface,
  for 30 seconds, after which it stops by itself. Stop and closing the dialog end it sooner; a
  closed window's browse is dropped. Starting needs an unlocked vault, so the lock screen never
  causes network traffic.
- **Shown, never acted on.** Results are listed as text. "Add host" closes the dialog and opens the
  normal host editor prefilled with the name, the first usable address (else the host name) and
  the port. Nothing is saved until Save, and connecting verifies the host key like any other host.
  Discovery never grants trust, never connects and never stores what it saw.
- **Untrusted input.** Any machine on the network can announce anything. The core (`discovery.rs`):
  - removes control, zero-width and bidirectional-override characters from instance names and keeps
    at most 63 characters;
  - accepts host names only as plain DNS names;
  - keeps at most four unicast, non-link-local addresses, IPv4 first;
  - drops port 0 and announcements with nowhere to connect;
  - keeps at most 64 services per browse (more are reported as truncated).

  TXT records are ignored.
- **Commands:** `discovery_networks`, `discovery_start`, `discovery_status` (polled once a second
  while listening) and `discovery_stop`. All are per window. `start` accepts only an interface from
  the current list.

## Dependencies

| Crate | Version | License | Why |
|---|---|---|---|
| `mdns-sd` | 0.21.5 (default features off) | Apache-2.0 OR MIT | Pure-Rust mDNS/DNS-SD querier with its own thread, no async runtime; per-interface selection |
| `if-addrs` | 0.15.0 | MIT OR BSD-3-Clause | Interface list for the network choice (already required by `mdns-sd`) |
| `flume` | 0.12.0 | Apache-2.0 OR MIT | Channel used by `mdns-sd` (transitive) |
| `socket-pktinfo` | 0.4.1 | MIT | Receives the arrival interface of multicast packets (transitive) |
| `spin` | 0.9.9 | MIT | Used by `flume` (transitive) |

None of them is an HTTP client; the release policy's network-client check is unchanged. They
live in `tyrminal-core`, which still has no Tauri, React or Axum dependency.

## Limitations

- `mdns-sd` binds its sockets on every interface when its daemon is created. The interface
  selection (all off, then the chosen one on) is applied immediately after, before the browse
  starts. So the only traffic on other interfaces is the operating system's multicast
  group-membership report (IGMP/MLD) for 224.0.0.251/ff02::fb. No query is sent there.
- `.local` names need the operating system's mDNS resolver at connect time (built in on macOS and
  Windows 10+; `nss-mdns` on Linux). That is why the editor is prefilled with an address when one
  was announced.
- IPv6 link-local addresses are not offered: a saved host cannot carry the interface scope they
  need.

## Tests

- Unit tests (`discovery::tests`) cover cleaning, bounds and refusal of unknown networks.
- `crates/core/tests/discovery_lab.rs` (integration suite) starts a real DNS-SD responder in the
  test. The responder and the browse both use the loopback interface only, so nothing leaves the
  machine. The test checks:
  - plain and hostile announcements are found and cleaned;
  - other service types are not listed;
  - Stop works and time-limited browses end.
- `tests/ui/discovery.spec.ts` (mock) covers:
  - no traffic before Start;
  - markup-looking names stay text;
  - Add host only prefills the editor;
  - Stop, time-out, the no-network state and an accessibility scan.

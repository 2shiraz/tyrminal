# 0008: Telnet and serial hosts; Mosh deferred

Status: accepted (2026-10-12, agent A)

## Context

The feature list asks for Telnet (CON-05), serial connections (CON-06), Mosh (CON-04) and
protocol-specific host settings (HST-01). Tyrminal's security model is built around SSH: host
keys are verified before any credential is sent, and secrets come from the vault.

## Decisions

**A host has a protocol** (`HostProtocol`: SSH, Telnet, or Serial with line settings), stored
in the host record; records written before this change read as SSH. Opening a host goes through
the same session API, owner checks, vault-generation checks, flow control and window handoff as
SSH; only the transport differs.

**Telnet** (`crates/core/src/telnet.rs`) is a small RFC 854/855 implementation in the core:
- The first thing every Telnet session shows is a warning that nothing is encrypted, and the
  host editor says the same. Telnet hosts store no credentials and never send one: the user
  types them at the server's own prompt. There is no host identity to verify.
- Only echo and suppress-go-ahead (from the server) and window size and terminal type (from us)
  are agreed to; every other option is refused once. Subnegotiations are bounded (64 bytes).
- Replies are sent without blocking the session task, so negotiation cannot stall the terminal.

**Serial** (`crates/core/src/serial.rs`) uses `serialport` 4.10.1 without libudev (ADR 0003
addendum). Only character devices (Unix) or `COMn` names (Windows) are opened, so a stored path
cannot point the terminal at an ordinary file. Line settings are validated when saved; the
device is checked when opened (adapters can be unplugged). One blocking reader thread per port
feeds the session task.

**Mosh is deferred.** Mosh needs its own client: the State Synchronization Protocol over UDP with
AES-128-OCB, prediction and a server process started over SSH. No maintained, reviewed Rust
implementation exists; writing one is a protocol-security project of its own. CON-04 stays
DEFERRED_BY_SCOPE until such a client exists or the project funds one with an external review.

## Testing

- Telnet: `crates/core/tests/protocols.rs` runs a real TCP Telnet server that negotiates window
  size and echo, asks for an option the client must refuse, checks CR NUL and doubled IAC in
  input, a resize report, and the session ending when the server hangs up; plus unit tests of
  the codec (split sequences, floods, repeated requests).
- Serial: settings validation; a byte exchange through a `socat` pseudo-terminal pair on Linux
  and macOS (integration suite). Windows serial is not exercised in CI (no virtual COM port on
  the runner); the matrix says so.

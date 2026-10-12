# 0004 — Port forwarding, record kinds and the connection path (agent B)

Status: accepted · Date: 2026-10-12

Agent B's design decisions for Phase 07 and Phase 08 (see `docs/work-split.md`). New
dependencies, if any, are recorded here with version, license and reason. **None so far:**
forwarding uses `russh` 0.64.1 (ADR 0002) and `tokio`, both already in the workspace.

## Decisions

1. **Forwards run on a session's verified connection.** A saved rule belongs to a host and runs
   on a connected SSH session to that host. The host key was checked and the user authenticated
   exactly as for the terminal (INV-02/03); there is no second connection path to keep in step.
   A forward never outlives its session: the session supervisor stops every forward of a session
   on every way it can end (closed, lost link, vault lock, window closed) and waits until the
   listeners are closed. Independently, each listener re-checks its connection twice a second
   and closes when it is gone. Rules marked *auto-start* start with every connection to the host,
   which is what makes them survive a reconnect.

2. **Loopback by default, external binds need an explicit approval.** A local or SOCKS listener
   must be an IP literal or `localhost` (mapped to `127.0.0.1` without DNS), so a name cannot
   resolve past the check. A non-loopback listener (or, for remote rules, a server address other
   than `localhost`/loopback) is saved only with `allow_external`, which the UI sets after a
   separate confirmation naming the exposure. The SSH adapter enforces the same rule again at
   bind time, before any socket or server request. Loopback rules never carry the flag.

3. **Server-opened channels are refused unless asked for.** `russh` accepts every channel a
   server opens by default (agent, X11, session, direct-tcpip, forwarded-tcpip, stream-local).
   The connection handler now accepts only `forwarded-tcpip` channels for a port this connection
   asked the server to forward, and refuses everything else. This is an additive block in
   `crates/ssh/src/client.rs` (agent A's file), noted under "Requests" in `docs/work-split.md`.

4. **Limits.** 64 simultaneous connections per forward (`MAX_TUNNEL_CONNECTIONS`), 32 running
   forwards (`MAX_ACTIVE_TUNNELS`), 32 ended runs kept for display. Excess connections are
   accepted and closed at once and counted. SOCKS5 handshakes are bounded to 10 s and the
   protocol's own field sizes; only `CONNECT` with the "no authentication" method is accepted.
   Remote-forward destinations get 10 s to accept.

5. **Record kinds from 100.** Agent B's vault record kinds start at 100 (`KIND_TUNNEL = 100`) so
   the two parallel branches never pick the same number. Older builds refuse a vault containing
   an unknown kind (by design, `vault.rs`), so a vault with tunnels needs this build to open.

6. **One race fixed in the connection path.** `run_ssh` reported *Connected* before registering
   the connection, so a side operation requested on that event (a tunnel, a key install) could
   be refused as "not connected". The connection is now registered first.

7. **Jump hosts.** A host names a saved jump host; chains form by pointing hosts at each other
   (at most 8 hosts, loops refused before anything is written). Each hop's SSH session runs over a
   `direct-tcpip` channel of the previous hop, with its own key exchange, host-key decision and
   authentication, strictly in order (INV-02/03 per hop). The settings are saved by their own
   command so editing a host's basics keeps them.

8. **Proxies.** HTTP `CONNECT` (Basic) and SOCKS5 (RFC 1929 username/password), for the
   connection that leaves this computer (the first hop's own setting). The destination name goes
   to the proxy unresolved. With credentials, a SOCKS5 client offers only username/password, so a
   proxy cannot downgrade to "no authentication"; an HTTP response head is read byte by byte and
   bounded to 8 KiB, so no tunnel byte is consumed. The proxy password is a vault secret, write-
   only towards the renderer (a summary says only whether one is stored), dropped when the user
   name changes, and never in an error, log or `Debug` output. The server's host key is still
   verified end to end, so a proxy cannot impersonate the server (lab test). No new dependency:
   base64 for Basic is twelve lines, checked against RFC 4648 vectors.

9. **Session recordings: own crate, maintained STREAM, output only.** `crates/session-log` holds the
   recording format (docs/crypto-format.md §11) with no file-system or UI code. Chunks use STREAM-BE32
   from RustCrypto's `aead-stream` **0.6.0** (Apache-2.0 OR MIT; same maintainers and `aead` 0.6 as the
   `chacha20poly1305` we already use), as BUILD_SPEC §5 asks for "established authenticated-stream
   machinery" rather than an ad hoc chunk cipher. It binds chunk order and the final chunk, so a cut,
   reordered or extended file is detected, and a damaged file shows only an authenticated prefix. Each
   file has its own key from `K_logs` and its id. The recorder taps the session's output sink only, so
   typed input can never be recorded (BUILD_SPEC §8 "never log raw keystrokes").

## Limits, stated plainly

- A loopback listener is reachable by other accounts on the same computer, as with OpenSSH's
  `-L`/`-D`. The SOCKS proxy has no credentials (common clients cannot send SOCKS5 passwords).
- Counters are live; the byte counts are of data read from each side.
- An HTTP proxy receives its credentials in base64, which is not encryption; the UI warns.
- Remote-forward tests need the container-free lab (the server's listener must be on this
  machine's loopback); the container lab cannot run them.

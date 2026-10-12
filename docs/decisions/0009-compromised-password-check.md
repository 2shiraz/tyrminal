# ADR 0009: Compromised-password check with a hash-prefix range query (SEC-11)

Status: accepted for the local part; the network transport waits on an owner decision. 2026-10-12

## Context

SEC-11 asks for a breach check of stored passwords using a hash-prefix lookup. The established
protocol (k-anonymity range query): send the first five hexadecimal characters of the password's
SHA-1 hash, receive every known suffix with that prefix and a count, compare locally. Responses
can be padded with count-0 decoys so their size does not reveal the prefix's popularity.

BUILD_SPEC §1.1 keeps vendor network activity out of default local mode, and
`scripts/check-release.mjs` fails a build whose default dependency graph contains an HTTP client
(`reqwest`, `hyper`, `ureq`, `isahc`). There is no TLS stack in the tree. The check cannot reach
an HTTPS endpoint without changing that policy, which is the owner's decision.

## Decision

1. **Local logic in the core** (`crates/core/src/password_check.rs`), no network:
   - SHA-1 of each stored password (host passwords, identity passwords, proxy passwords,
     remembered key passphrases) is computed on the device. A range source receives a
     `HashPrefix`, a type that can only hold the 5-character prefix of a hash; passwords, full
     hashes, suffixes and labels never reach it.
   - One request per distinct prefix; duplicates are looked up once.
   - Responses are parsed strictly: `SUFFIX:COUNT` lines (35 hex digits, decimal count, optional
     CR), at most 1 MiB and 20,000 lines; count-0 lines are padding and never match. A garbled or
     failed answer fails the whole check with a fixed message. It is never read as "not found".
2. **Opt-in.** `Preferences.passwordCheck { enabled: false, endpoint }`. The core refuses a run
   while it is off; the UI turns it on and saves at once, and enables the run button from the
   core's status. The settings text says exactly what is sent (the 5 characters, to the
   address shown) and what is not.
3. **Configurable endpoint.** `https://` only, no user info, query, fragment, backslash,
   whitespace or control characters, at most 512 bytes; validated when preferences are saved.
4. **Transport.** `RangeSource` is pluggable. This build ships `NoRangeSource`: the status says
   the check is unavailable and why, and a run is refused. Tests use a stub range server
   started inside the test on loopback, with a test-only HTTP client; the real service is never
   contacted.

## Open (owner decision)

A real transport needs an HTTPS client: either (A) behind an off-by-default cargo feature, so
release builds stay client-free, or (B) one named client allowed in the release graph by
`check-release.mjs` with this ADR as the reason. Matrix row SEC-11 is BLOCKED until then.

# Threat model

Living document. Phase 00 establishes assets, attackers and stated limits; mitigations are linked to
tests in `docs/security-invariants.md` as they are implemented. Nothing here has been independently
reviewed.

## Assets

Private keys and passphrases · stored passwords · host inventory (names, addresses, usernames, tags) ·
known-host trust decisions · command history and terminal output · transferred files · snippets and
environment values · provider credentials and identity tokens · vault keys and recovery keys · backups ·
release signing keys.

## Attackers and primary mitigations

| # | Attacker | Primary mitigations | Status |
|---|---|---|---|
| T1 | Malicious SSH/SFTP server or network intermediary | Host key verified before any credential or signature; changed keys fail closed; terminal output treated as untrusted data; agent forwarding off | Phase 01/03 |
| T2 | Stolen device or copied vault database | Argon2id-wrapped vault key, XChaCha20-Poly1305 record envelopes, no plaintext sensitive columns, idle/OS lock | Phase 02 |
| T3 | Compromised renderer or frontend dependency | No remote scripts, strict CSP, narrow typed IPC, no decrypt/secret-read commands, handles bound to window + vault generation | Phase 02–03 |
| T4 | Malicious import file, escape sequence, filename or link | Bounded non-executing parsers, OSC 52 denied by default, link scheme allowlist, path confinement | Phase 03–06 |
| T5 | Untrusted sync operator / stolen server database | Client-side encryption, per-object authorization, replay checkpoints | Phase 10 |
| T6 | Removed team member or unauthorized device | Authenticated membership changes, key rotation for future data | Phase 11 |
| T7 | Local process racing file operations | User-only permissions, private temp directories, atomic rename | Phase 02/06 |
| T8 | Compromised update endpoint or CI dependency | Signed updates with downgrade protection, pinned dependencies and actions | Phase 09/15 |
| T9 | Resource exhaustion (output floods, reconnect storms, hostile KDF parameters) | Central limits, bounded queues, allowlisted KDF profiles, capped backoff | Phase 01 onward |

## Stated limits

These cannot be fully defeated by this design and the product must not claim otherwise:

- An already compromised OS, or an attacker with administrator/root access.
- A compromised renderer **while the vault is unlocked** can drive active sessions.
- A malicious authorized recipient who keeps plaintext they legitimately received.
- Offline copies of data already obtained cannot be remotely erased.
- Secrets may reach swap or hibernation images; memory locking is best effort.
- JavaScript memory holding a transiently typed password cannot be reliably zeroized.
- A local attacker with write access to the database file can roll an individual record back to an
  older valid ciphertext, or delete records. Envelopes prevent forging and swapping, not rollback
  (see `docs/crypto-format.md`, "Known limits").
- Changing the passphrase rewraps the vault key; it does not protect a database copy taken earlier
  from someone who knows the earlier passphrase.

## Risk register (initial)

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| russh lacks an auth method or algorithm a user needs | Medium | Medium | Adapter boundary; record negotiated list; evaluate alternative backend rather than weakening checks |
| No Windows validation (B-01) | Certain today | High for the Windows target | Keep Windows rows unverified; never infer from cross-compilation |
| Self-designed crypto composition has a flaw | Medium | High | Small documented format, independent test vectors, review packet, no stable release before review (B-05) |
| Dependency versions newer than widely reviewed | Medium | Medium | Lockfiles, cargo-deny advisories, pnpm minimum release age |
| Terminal renderer as attack surface | Medium | High | Minimal addons, CSP, no HTML rendering of remote text |
| Scope size (302 catalogue rows) outruns verification | High | Medium | Stable-scope metric tracked separately from total coverage; vertical slices |

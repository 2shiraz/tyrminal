# Vault cryptographic format — version 1

**Review status: NOT independently reviewed.** This is an application-level composition of maintained
primitives. Library audits do not cover this composition. Public stable release is gated on external
review (blocker B-05).

All integers are unsigned big-endian. All lengths are fixed unless stated. `||` is byte concatenation.
Labels are ASCII without a terminator unless a `\0` is written. Renaming the product must not change
any label.

## 1. Primitives and libraries

| Purpose | Algorithm | Crate (pinned in Cargo.lock) |
|---|---|---|
| AEAD | XChaCha20-Poly1305, 256-bit key, 192-bit nonce, 128-bit tag | `chacha20poly1305` 0.11 |
| Passphrase KDF | Argon2id v1.3 (0x13) | `argon2` 0.6 |
| Key derivation | HKDF-SHA-256 (RFC 5869) | `hkdf` 0.13, `sha2` 0.11 |
| Header MAC | HMAC-SHA-256, constant-time verification (`Mac::verify_slice`) | `hmac` 0.13 |
| Randomness | OS CSPRNG | `getrandom` 0.4 |

No cipher, hash or KDF primitive is implemented in this repository.

## 2. Key hierarchy

```
passphrase ──Argon2id(profile, slot salt)────────────► KEK_passphrase ─┐
recovery key (32 random bytes) ──HKDF(slot salt)─────► KEK_recovery   ─┼─ each unwraps ─► VRK
device secret (32 random bytes, OS keystore) ──HKDF──► KEK_device     ─┘

VRK (vault root key, 32 random bytes, generation = key_version)
 ├─ HKDF info "tyrminal.subkey.v1.records"     ► K_records     record envelopes
 ├─ HKDF info "tyrminal.subkey.v1.header-mac"  ► K_header_mac  header integrity
 ├─ HKDF info "tyrminal.subkey.v1.backup"      ► K_backup      portable backups (§10)
 ├─ HKDF info "tyrminal.subkey.v1.logs"        ► K_logs        session recordings (Phase 08)
 └─ HKDF info "tyrminal.subkey.v1.sync-auth"   ► K_sync_auth   sync authentication (Phase 10)
```

- Subkeys: `HKDF-SHA-256(ikm = VRK, salt = vault_id, info = label)`, 32 bytes each.
- `KEK_recovery = HKDF-SHA-256(ikm = recovery key, salt = slot salt, info = "tyrminal.kek.recovery.v1")`.
- `KEK_device   = HKDF-SHA-256(ikm = device secret, salt = slot salt, info = "tyrminal.kek.device.v1")`.
- `KEK_passphrase` is the 32-byte Argon2id output, used directly.

A key is used for exactly one purpose. Changing the passphrase replaces the passphrase slot (rewrap);
records are not re-encrypted. Rotating the VRK (`key_version + 1`) re-encrypts records and is a
separate migration that is **not yet implemented**.

## 3. KDF profiles (allowlist)

The header stores a profile identifier, never raw cost values. Unknown identifiers are rejected
before any KDF work, so a hostile file cannot demand arbitrary memory or CPU.

| ID | Applies to | Parameters |
|---|---|---|
| `0x0001` | passphrase slot | Argon2id v0x13, m = 65536 KiB (64 MiB), t = 3, p = 1, output 32 bytes |
| `0x0100` | recovery and device slots | HKDF-SHA-256 as in §2 |

Bounds: passphrase 1..=1024 bytes at unlock, 8..=1024 bytes at creation/change; salt exactly 32 bytes.
A header has exactly one passphrase slot, at most one recovery slot and at most four device slots, so
one unlock attempt performs at most one Argon2id evaluation. Unlock attempts are serialized by the
caller (`tyrminal-core`) so concurrent attempts cannot multiply memory use. Strength is never lowered
automatically on slow devices.

## 4. Vault header

```
magic           8   "TYRVAULT"
format_version  2   0x0001
vault_id       16   random
key_version     4   starts at 1
slot_count      1   1..=6
slot × slot_count (123 bytes each):
    slot_kind    1   1 = passphrase, 2 = recovery, 3 = device
    slot_id     16   random
    kdf_profile  2   see §3; must match slot_kind
    salt        32   random
    nonce       24   random
    wrapped     48   XChaCha20-Poly1305(KEK, nonce, VRK, aad = slot AAD) → 32-byte ciphertext || 16-byte tag
header_mac     32   HMAC-SHA-256(K_header_mac, every preceding byte)
```

Total length is exactly `31 + 123 × slot_count + 32` bytes; any other length is rejected.

Slot AAD:

```
"tyrminal.keyslot.v1\0" || format_version(2) || vault_id(16) || key_version(4)
    || slot_kind(1) || slot_id(16) || kdf_profile(2) || salt(32)
```

Unlock: parse strictly → select the slot for the presented credential kind → derive KEK → AEAD-open →
derive `K_header_mac` → verify `header_mac` in constant time. A failed AEAD open reports
`WrongCredential` (a wrong passphrase and a modified slot are indistinguishable by design). A valid
slot with a bad MAC reports `HeaderTampered`. No key material or partial plaintext is returned on any
failure.

A format version other than `0x0001` is rejected as `UnsupportedVersion`: an older client never
opens a newer vault.

## 5. Record envelope

Stored per record: `record_id(16)`, `kind(2)`, `revision(8)`, `key_version(4)`, `nonce(24)`,
`ciphertext(variable)`.

```
aad = "tyrminal.record.v1\0" || format_version(2) || vault_id(16) || record_id(16)
        || kind(2) || revision(8) || key_version(4)

framed     = payload_len(4) || payload || zero padding to the next multiple of 256 bytes
ciphertext = XChaCha20-Poly1305(K_records, nonce, framed, aad)      (includes the 16-byte tag)
```

- A fresh random 192-bit nonce is drawn for every encryption. A nonce is never supplied by callers.
- `payload` is at most 1 MiB (1,048,576 bytes). `revision` must be ≥ 1.
- On open, after authentication: `payload_len ≤ len(framed) − 4`, `len(framed)` is a multiple of 256,
  and every padding byte is zero; otherwise `MalformedRecord`.
- The payload is an application-defined versioned document. It is opaque to this layer and is never
  used as a canonical form for authentication.

The AAD binds a ciphertext to its vault, record, kind, revision and key generation. Moving a
ciphertext to another row, vault, kind or revision fails authentication.

## 6. Recovery key

32 random bytes. Displayed as Crockford base32 of `key(32) || check(2)` where
`check = SHA-256("tyrminal.recovery.check.v1" || key)[0..2]`: 55 characters in groups of five.
Parsing ignores case, spaces and hyphens and maps `O→0`, `I/L→1`. The check detects typing errors;
it adds no security. The recovery key is shown once and never stored in plaintext by the application.

## 7. Cleartext metadata and leakage

Stored in clear: vault id, format/key versions, slot kinds and count, salts and nonces, and per record
its random id, kind, revision, key version and padded size. An observer of the database learns the
number of records per kind, sizes rounded up to 256 bytes, and write timing/frequency. Names,
addresses, usernames, tags, snippet text, environment values and credentials are inside `payload`.

## 8. Known limits

- **Rollback and deletion:** someone who can write the database can restore an older valid row for a
  record (same id, older revision) or delete rows. Detecting this needs an authenticated vault-wide
  state root, which version 1 does not have.
- **Passphrase change is a rewrap:** it does not protect an earlier database copy from someone who
  knows the earlier passphrase. That requires VRK rotation.
- **Memory:** keys are zeroized on drop and lock. The OS may still have paged them; no claim is made
  that secrets never reach swap.
- **Header MAC is checked after unwrap**, so header integrity is only established for someone who can
  unlock. An attacker without credentials can still corrupt the header (denial of service).

## 9. Test vectors

Known-answer vectors are produced by an **independent implementation** (the reference Argon2 C code
via argon2-cffi 25.1.0, libsodium via PyNaCl 1.6.2 for XChaCha20-Poly1305, and Python's standard
library for HKDF/HMAC/base32) by
`tests/fixtures/vault-vectors/generate.py`, committed as `vectors.json`, and checked by
`crates/vault/tests/known_answer.rs`. The vector keys are public test values and must never be used
for real data.

## 10. Portable backup (version 1)

A backup is a single file that restores a vault on any device with the vault's own passphrase or
recovery key. It contains the vault header and every live record envelope exactly as stored (still
sealed under `K_records`), and an HMAC over the whole file under `K_backup`. Writing a backup
decrypts nothing.

```
magic           8   "TYRBACKP"
backup_version  2   0x0001
created_at      8   seconds since the Unix epoch (cleartext, informational)
header_len      4   ≤ 801 (the largest valid header)
header          header_len   the vault header (§4), byte for byte
record_count    4   ≤ 100,000 (the vault's own listing bound)
record × record_count, strictly increasing by record_id (no duplicates):
    record_id   16
    kind         2
    revision     8   ≥ 1
    key_version  4   must equal the header's key_version
    nonce       24
    ct_len       4   272 ≤ ct_len ≤ 1,048,848 and (ct_len − 16) a multiple of 256
    ciphertext  ct_len   the record envelope (§5)
backup_mac     32   HMAC-SHA-256(K_backup, every preceding byte)
```

The whole file is at most 256 MiB. Tombstones are not included.

Restore: parse strictly and within the bounds above before any cryptography (a hostile count or
length is rejected before allocation) → unlock the embedded header with the presented credential
(§4; a wrong credential is `WrongCredential`) → verify the header MAC → verify `backup_mac` in
constant time (`BackupTampered`) → open every record (§5), which re-checks each record's binding to
its vault, id, kind, revision and key generation. Only a backup that passes every step can replace
a vault, and it replaces the vault as a whole.

What this protects: any change to any byte, truncation, trailing data, a dropped, added, duplicated
or reordered record, a header from another vault, and records from another key generation are all
rejected. What it does not: the cleartext metadata of §7 (plus `created_at` and the record count) is
visible to whoever holds the file, and someone who knows the passphrase or recovery key at the time
of the backup can always open it. A backup made before a passphrase change still opens with the old
passphrase (rewrap, §8).

Vector: `tests/fixtures/vault-vectors/generate_backup.py` (Python standard library only) packs the
§9 vector vault into `backup.json`; `crates/vault/tests/known_answer.rs` checks that the Rust code
verifies it and re-encodes it byte for byte.


## 11. Session recording (version 1)

A recording is what one terminal session **printed**, in one file. Typed input is never part of
it: the recorder only sees the output stream (`crates/core/src/recording.rs` wraps the session's
output sink), so keystrokes, and passwords typed at prompts that do not echo them, cannot be
recorded. Implemented by `crates/session-log`.

### 11.1 Keys

```
K_logs   = HKDF-SHA-256(ikm = VRK, salt = vault_id, info = "tyrminal.subkey.v1.logs")   (§2)
K_file   = HKDF-SHA-256(ikm = K_logs, salt = log_id, info = "tyrminal.log.v1.file")
```

Every recording has its own random 16-byte `log_id` and so its own key.

### 11.2 File layout

```
magic          8   "TYRSLOG\0"
format_version 2   0x0001
vault_id      16
log_id        16
key_version    4   the VRK generation K_logs came from
nonce_prefix  19   random
frame × n:
    flags      1   0 = ordinary chunk, 1 = final chunk
    ct_len     4   1,040 ≤ ct_len ≤ 66,576
    ciphertext ct_len
```

Chunks use STREAM-BE32 (Hoang, Reyhanitabar, Rogaway and Vizár, "Online Authenticated-Encryption
and its Nonce-Reuse Misuse-Resistance") over XChaCha20-Poly1305 with key `K_file`, the 19-byte
`nonce_prefix`, a 32-bit big-endian chunk counter and the last-block flag, as implemented by the
RustCrypto `aead-stream` 0.6.0 crate. The associated data of every chunk is the 65-byte header, so
each chunk is bound to its file, its position, and whether it is the final one.

Chunk plaintext: `payload_len(4) || payload || zero padding to a multiple of 1,024 bytes`, with
`payload_len ≤ 65,536`. The payload is a sequence of events:

```
kind(1) || at_ms(4) || body_len(4) || body
  1 start   body = started_unix_ms(8) || cols(2) || rows(2); at_ms = 0; first event of chunk 0 only
  2 output  body = bytes the terminal printed
  3 resize  body = cols(2) || rows(2)
  4 end     body = reason(1): 0 closed, 1 size limit reached, 2 vault locked, 3 stopped
```

`at_ms` counts milliseconds from the start. The first chunk holds only the start event and is
written immediately. The end event is the last event of the final chunk and nowhere else.

### 11.3 Writing

Events are buffered and written as a chunk when the buffer would exceed 65,536 bytes or the caller
flushes (the recorder flushes every few seconds and on close). The writer keeps room for the final
chunk under its size limit: when an event would not fit, it writes the final chunk with reason
"size limit reached" instead, and the session continues unrecorded.

### 11.4 Reading

Parse the header strictly; a wrong magic is `NotALog`, another version `UnsupportedVersion`, and a
header whose `vault_id`, `log_id` or `key_version` differs from the record that points at the file
is `WrongLog`. Open chunks in order. If the first chunk does not authenticate (or does not start
with the start event) the file is `Unreadable`. After that, the reader returns every event that
authenticated, plus one of:

- **Complete** — the final chunk authenticated, ended with the end event, and nothing follows it.
- **Incomplete** — the file stops before a final chunk (at a chunk boundary or inside a chunk), as
  after a crash while recording.
- **Damaged** — a chunk failed authentication or was malformed, a final-chunk flag was changed, an
  end event appears early, or bytes follow the final chunk. Nothing after that point is trusted.

What this protects: a changed byte anywhere, reordered, dropped, repeated or foreign chunks, a cut
anywhere, and trailing data are all detected; a damaged recording never shows altered content, only
an authenticated prefix. What it does not: the header is cleartext (vault id, log id, key version),
and the file's size and write times show roughly how much the session printed and when (sizes are
rounded up to 1,024 bytes per chunk). Which host a recording belongs to, when it started and its
title are in an encrypted record (`SessionLog`), not in the file.

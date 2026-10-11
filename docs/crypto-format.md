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
 ├─ HKDF info "tyrminal.subkey.v1.backup"      ► K_backup      portable backups   (Phase 02)
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

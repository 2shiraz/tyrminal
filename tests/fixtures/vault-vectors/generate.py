#!/usr/bin/env python3
"""Independent known-answer vectors for docs/crypto-format.md (vault format version 1).

This script deliberately shares no code with the Rust implementation:
  - Argon2id      -> argon2-cffi (reference C implementation)
  - XChaCha20-Poly1305 -> PyNaCl (libsodium)
  - HKDF / HMAC / SHA-256 / base32 -> Python standard library, written out below

Usage:  python generate.py > vectors.json      (pip install pynacl argon2-cffi)

Every key below is a PUBLIC TEST VALUE. Never use any of them for real data.
"""

import hashlib
import hmac
import json
import struct

import argon2.low_level as argon2
import nacl.bindings as sodium

FORMAT_VERSION = 1
PAD_BLOCK = 256
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def fixed(label: str, n: int) -> bytes:
    """Deterministic, obviously non-secret filler bytes."""
    out = b""
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(f"tyrminal test vector/{label}/{counter}".encode()).digest()
        counter += 1
    return out[:n]


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, block, counter = b"", b"", 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def xchacha_encrypt(key: bytes, nonce: bytes, plaintext: bytes, aad: bytes) -> bytes:
    return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, nonce, key)


def crockford(data: bytes) -> str:
    bits = "".join(f"{b:08b}" for b in data)
    bits += "0" * (-len(bits) % 5)
    return "".join(CROCKFORD[int(bits[i : i + 5], 2)] for i in range(0, len(bits), 5))


def slot_aad(vault_id, key_version, kind, slot_id, profile, salt) -> bytes:
    return (
        b"tyrminal.keyslot.v1\0"
        + struct.pack(">H", FORMAT_VERSION)
        + vault_id
        + struct.pack(">I", key_version)
        + bytes([kind])
        + slot_id
        + struct.pack(">H", profile)
        + salt
    )


def slot(kind, profile, label, kek_for_salt, root, vault_id, key_version):
    slot_id, salt, nonce = fixed(f"{label}/id", 16), fixed(f"{label}/salt", 32), fixed(f"{label}/nonce", 24)
    kek = kek_for_salt(salt)
    wrapped = xchacha_encrypt(kek, nonce, root, slot_aad(vault_id, key_version, kind, slot_id, profile, salt))
    assert len(wrapped) == 48
    return bytes([kind]) + slot_id + struct.pack(">H", profile) + salt + nonce + wrapped, kek


def main() -> None:
    passphrase = "correct horse battery staple"
    vault_id = fixed("vault-id", 16)
    key_version = 1
    root = fixed("root-key", 32)
    recovery = fixed("recovery-key", 32)
    device = fixed("device-secret", 32)

    pass_slot, kek_pass = slot(
        1, 0x0001, "slot/passphrase",
        lambda salt: argon2.hash_secret_raw(
            secret=passphrase.encode(), salt=salt, time_cost=3, memory_cost=64 * 1024,
            parallelism=1, hash_len=32, type=argon2.Type.ID, version=0x13,
        ),
        root, vault_id, key_version,
    )
    rec_slot, kek_rec = slot(
        2, 0x0100, "slot/recovery",
        lambda salt: hkdf_sha256(recovery, salt, b"tyrminal.kek.recovery.v1"), root, vault_id, key_version,
    )
    dev_slot, kek_dev = slot(
        3, 0x0100, "slot/device",
        lambda salt: hkdf_sha256(device, salt, b"tyrminal.kek.device.v1"), root, vault_id, key_version,
    )

    k_records = hkdf_sha256(root, vault_id, b"tyrminal.subkey.v1.records")
    k_header_mac = hkdf_sha256(root, vault_id, b"tyrminal.subkey.v1.header-mac")

    slots = [pass_slot, rec_slot, dev_slot]
    unsigned = (
        b"TYRVAULT" + struct.pack(">H", FORMAT_VERSION) + vault_id + struct.pack(">I", key_version)
        + bytes([len(slots)]) + b"".join(slots)
    )
    header = unsigned + hmac.new(k_header_mac, unsigned, hashlib.sha256).digest()

    records = []
    payloads = [b"", b'{"label":"db-1","address":"192.0.2.10"}', fixed("payload/long", 1000), fixed("payload/edge", 252)]
    for i, payload in enumerate(payloads):
        record_id, nonce = fixed(f"record/{i}/id", 16), fixed(f"record/{i}/nonce", 24)
        kind, revision = i + 1, 10**i
        framed = struct.pack(">I", len(payload)) + payload
        framed += b"\0" * (-len(framed) % PAD_BLOCK)
        aad = (
            b"tyrminal.record.v1\0" + struct.pack(">H", FORMAT_VERSION) + vault_id + record_id
            + struct.pack(">H", kind) + struct.pack(">Q", revision) + struct.pack(">I", key_version)
        )
        records.append({
            "record_id": record_id.hex(), "kind": kind, "revision": revision, "key_version": key_version,
            "nonce": nonce.hex(), "aad": aad.hex(), "payload": payload.hex(),
            "ciphertext": xchacha_encrypt(k_records, nonce, framed, aad).hex(),
        })

    check = hashlib.sha256(b"tyrminal.recovery.check.v1" + recovery).digest()[:2]
    flat = crockford(recovery + check)
    recovery_text = "-".join(flat[i : i + 5] for i in range(0, len(flat), 5))

    print(json.dumps({
        "warning": "PUBLIC TEST VECTORS. Never use these keys for real data.",
        "format_version": FORMAT_VERSION,
        "generated_with": "argon2-cffi (reference Argon2), PyNaCl/libsodium (XChaCha20-Poly1305), Python stdlib (HKDF, HMAC, SHA-256)",
        "passphrase": passphrase,
        "recovery_key_text": recovery_text,
        "device_secret": device.hex(),
        "vault_id": vault_id.hex(),
        "key_version": key_version,
        "header": header.hex(),
        "intermediate": {
            "root_key": root.hex(),
            "kek_passphrase": kek_pass.hex(),
            "kek_recovery": kek_rec.hex(),
            "kek_device": kek_dev.hex(),
            "k_records": k_records.hex(),
            "k_header_mac": k_header_mac.hex(),
        },
        "records": records,
    }, indent=2))


if __name__ == "__main__":
    main()

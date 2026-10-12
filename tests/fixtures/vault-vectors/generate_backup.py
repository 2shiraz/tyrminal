"""Known-answer vector for the portable backup format (docs/crypto-format.md §10).

Independent of the Rust code: Python standard library only (HKDF and HMAC per RFC 5869/2104,
struct layout written from the specification). It packs the public vector vault from
vectors.json (header and record envelopes produced with libsodium and reference Argon2 by
generate.py) into a backup file.

Usage:  python generate_backup.py < vectors.json > backup.json
"""

import hashlib
import hmac
import json
import struct
import sys

CREATED_AT = 1_760_000_000


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, block, counter = b"", b"", 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def main() -> None:
    v = json.load(sys.stdin)
    root = bytes.fromhex(v["intermediate"]["root_key"])
    vault_id = bytes.fromhex(v["vault_id"])
    header = bytes.fromhex(v["header"])
    k_backup = hkdf_sha256(root, vault_id, b"tyrminal.subkey.v1.backup")

    records = sorted(v["records"], key=lambda r: bytes.fromhex(r["record_id"]))
    body = b"TYRBACKP" + struct.pack(">HQI", 1, CREATED_AT, len(header)) + header + struct.pack(">I", len(records))
    for r in records:
        ct = bytes.fromhex(r["ciphertext"])
        body += (
            bytes.fromhex(r["record_id"]) + struct.pack(">HQI", r["kind"], r["revision"], r["key_version"])
            + bytes.fromhex(r["nonce"]) + struct.pack(">I", len(ct)) + ct
        )
    backup = body + hmac.new(k_backup, body, hashlib.sha256).digest()

    print(json.dumps({
        "warning": "PUBLIC TEST VECTORS. Never use these keys for real data.",
        "generated_with": "Python stdlib (HKDF-SHA-256, HMAC-SHA-256, struct)",
        "created_at": CREATED_AT,
        "k_backup": k_backup.hex(),
        "record_ids_in_order": [r["record_id"] for r in records],
        "backup": backup.hex(),
    }, indent=2))


if __name__ == "__main__":
    main()

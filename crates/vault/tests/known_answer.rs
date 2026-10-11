//! Known-answer tests against vectors produced by an independent implementation
//! (tests/fixtures/vault-vectors/generate.py: reference Argon2, libsodium, Python stdlib).
//! These prove the Rust code implements docs/crypto-format.md, not merely that it agrees with itself.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::Value;
use tyrminal_vault::{
    Credential, Passphrase, RecordContext, RecoveryKey, SealedRecord, SecretKey, VaultHeader,
};

const VECTORS: &str = include_str!("../../../tests/fixtures/vault-vectors/vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors.json parses")
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("valid hex")
}

fn array<const N: usize>(v: &Value) -> [u8; N] {
    bytes(v).try_into().expect("expected length")
}

fn header(v: &Value) -> VaultHeader {
    VaultHeader::decode(&bytes(&v["header"])).expect("independent header decodes")
}

#[test]
fn header_fields_decode_and_reencode_byte_for_byte() {
    let v = vectors();
    let h = header(&v);
    assert_eq!(h.vault_id(), array::<16>(&v["vault_id"]));
    assert_eq!(
        u64::from(h.key_version()),
        v["key_version"].as_u64().unwrap()
    );
    assert_eq!(h.encode(), bytes(&v["header"]));
}

#[test]
fn argon2id_passphrase_slot_from_reference_implementation_unlocks() {
    let v = vectors();
    let passphrase = Passphrase::new(v["passphrase"].as_str().unwrap().to_owned());
    let unlocked = header(&v)
        .unlock(&Credential::Passphrase(&passphrase))
        .expect("passphrase unlocks");
    assert_eq!(unlocked.vault_id(), array::<16>(&v["vault_id"]));
}

#[test]
fn recovery_text_and_device_secret_unlock() {
    let v = vectors();
    let recovery =
        RecoveryKey::parse(v["recovery_key_text"].as_str().unwrap()).expect("recovery text parses");
    assert_eq!(
        recovery.to_display_string().as_str(),
        v["recovery_key_text"].as_str().unwrap()
    );
    header(&v)
        .unlock(&Credential::Recovery(&recovery))
        .expect("recovery unlocks");

    let device = SecretKey::from_bytes(array::<32>(&v["device_secret"]));
    header(&v)
        .unlock(&Credential::Device(&device))
        .expect("device secret unlocks");
}

#[test]
fn libsodium_record_ciphertexts_open_to_the_expected_payloads() {
    let v = vectors();
    let recovery = RecoveryKey::parse(v["recovery_key_text"].as_str().unwrap()).unwrap();
    let unlocked = header(&v).unlock(&Credential::Recovery(&recovery)).unwrap();
    let records = v["records"].as_array().unwrap();
    assert_eq!(records.len(), 4);
    for r in records {
        let ctx = RecordContext {
            record_id: array::<16>(&r["record_id"]),
            kind: r["kind"].as_u64().unwrap() as u16,
            revision: r["revision"].as_u64().unwrap(),
        };
        let sealed = SealedRecord {
            key_version: r["key_version"].as_u64().unwrap() as u32,
            nonce: array::<24>(&r["nonce"]),
            ciphertext: bytes(&r["ciphertext"]),
        };
        assert_eq!(
            &*unlocked.open(&ctx, &sealed).expect("record opens"),
            &bytes(&r["payload"])
        );

        // And what Rust seals for the same context, Rust opens (encrypt direction consistency).
        let resealed = unlocked.seal(&ctx, &bytes(&r["payload"])).unwrap();
        assert_eq!(resealed.ciphertext.len(), sealed.ciphertext.len());
        assert_eq!(
            &*unlocked.open(&ctx, &resealed).unwrap(),
            &bytes(&r["payload"])
        );
    }
}

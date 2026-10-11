//! Record payloads: what is inside a record's ciphertext.
//!
//! Plaintext layout (before the vault crate frames, pads and encrypts it):
//!
//! ```text
//! byte 0      marker: 0x00 = tombstone, 0x01 = live record, JSON schema v1
//! bytes 1..   UTF-8 JSON document (absent for a tombstone)
//! ```
//!
//! The marker is authenticated with the rest of the payload, so a tombstone cannot be turned
//! back into a live record (or the reverse) by flipping the cleartext `deleted` column: that
//! column is an index hint that must agree with the marker, and disagreement fails the load.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tyrminal_contracts::IpcError;
use zeroize::Zeroizing;

use crate::error::{err, internal};
use tyrminal_contracts::ErrorCode;

pub(crate) const KIND_HOST: u16 = 1;
pub(crate) const KIND_KEY: u16 = 2;
pub(crate) const KIND_KNOWN_HOST: u16 = 3;
/// Append-only notes about trust decisions (why a known host was removed).
pub(crate) const KIND_TRUST_EVENT: u16 = 4;

const MARKER_TOMBSTONE: u8 = 0x00;
const MARKER_LIVE_V1: u8 = 0x01;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum StoredAuth {
    AskPassword,
    Password { password: Zeroizing<String> },
    Key { key_id: String },
}

#[derive(Serialize, Deserialize)]
pub(crate) struct HostRecord {
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: StoredAuth,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct KeyRecord {
    pub label: String,
    /// OpenSSH private key text, possibly itself passphrase-encrypted.
    pub private_key: Zeroizing<String>,
    pub passphrase: Option<Zeroizing<String>>,
    pub passphrase_protected: bool,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct KnownHostRecord {
    pub host: String,
    pub port: u16,
    pub public_key: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub added_at: u64,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct TrustEventRecord {
    pub host: String,
    pub port: u16,
    pub removed_fingerprint: String,
    pub reason: String,
    pub at: u64,
}

/// A writer that never reallocates: the buffer is sized up front, so serializing a secret does
/// not leave partial copies behind in freed heap blocks.
struct FixedWriter {
    buffer: Zeroizing<Vec<u8>>,
    overflowed: bool,
}

impl std::io::Write for FixedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buffer.len() + data.len() > self.buffer.capacity() {
            self.overflowed = true;
            return Err(std::io::Error::other("record exceeds its reserved size"));
        }
        self.buffer.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Serializes a live record. `content_len` is the total byte length of the record's strings; JSON
/// escaping can expand a string at most six-fold (`\u00XX`), which bounds the reservation.
pub(crate) fn encode<T: Serialize>(record: &T, content_len: usize) -> Result<Zeroizing<Vec<u8>>, IpcError> {
    let reserve = content_len.saturating_mul(6).saturating_add(1024);
    let mut writer = FixedWriter { buffer: Zeroizing::new(Vec::with_capacity(reserve)), overflowed: false };
    writer.buffer.push(MARKER_LIVE_V1);
    match serde_json::to_writer(&mut writer, record) {
        Ok(()) => Ok(writer.buffer),
        Err(_) if writer.overflowed => Err(err(ErrorCode::LimitExceeded, "That is larger than the vault allows.")),
        Err(_) => Err(internal()),
    }
}

pub(crate) fn tombstone() -> Zeroizing<Vec<u8>> {
    Zeroizing::new(vec![MARKER_TOMBSTONE])
}

pub(crate) enum Decoded<T> {
    Live(T),
    Tombstone,
}

/// Parses an authenticated payload. Unknown markers and malformed documents are reported as a
/// damaged vault; they can only come from a different or buggy writer, never from tampering.
pub(crate) fn decode<T: DeserializeOwned>(payload: &[u8]) -> Result<Decoded<T>, IpcError> {
    let damaged = || err(ErrorCode::VaultDamaged, "The vault contains a record this version cannot read.");
    match payload.split_first() {
        Some((&MARKER_TOMBSTONE, [])) => Ok(Decoded::Tombstone),
        Some((&MARKER_LIVE_V1, json)) => serde_json::from_slice(json).map(Decoded::Live).map_err(|_| damaged()),
        _ => Err(damaged()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_records_round_trip_and_tombstones_are_distinct() {
        let host = HostRecord {
            label: "db \"quoted\" \u{1F5A5}".into(),
            address: "db.example".into(),
            port: 2222,
            username: "deploy".into(),
            auth: StoredAuth::Password { password: Zeroizing::new("p\u{0}ss\nword\\".into()) },
        };
        let bytes = encode(&host, 64).unwrap();
        assert_eq!(bytes[0], MARKER_LIVE_V1);
        let Decoded::Live(back) = decode::<HostRecord>(&bytes).unwrap() else { panic!("expected live") };
        assert_eq!(back.label, host.label);
        assert!(matches!(back.auth, StoredAuth::Password { ref password } if password.as_str() == "p\u{0}ss\nword\\"));

        assert!(matches!(decode::<HostRecord>(&tombstone()).unwrap(), Decoded::Tombstone));
    }

    #[test]
    fn unknown_markers_and_malformed_documents_are_rejected() {
        for bad in [
            &[][..],
            &[0x02, b'{', b'}'],
            &[MARKER_TOMBSTONE, 1],
            &[MARKER_LIVE_V1],
            &[MARKER_LIVE_V1, b'{'],
            b"\x01[]",
        ] {
            let result = decode::<HostRecord>(bad);
            assert!(matches!(result, Err(ref e) if e.code == ErrorCode::VaultDamaged), "{bad:?}");
        }
    }

    #[test]
    fn worst_case_escaping_fits_the_reservation_and_never_reallocates() {
        // Every byte a control character: the largest possible JSON expansion.
        let nasty = "\u{1}".repeat(4000);
        let record = TrustEventRecord {
            host: nasty.clone(),
            port: 1,
            removed_fingerprint: String::new(),
            reason: nasty.clone(),
            at: 0,
        };
        let bytes = encode(&record, 8000).unwrap();
        assert!(bytes.len() <= bytes.capacity());
        let Decoded::Live(back) = decode::<TrustEventRecord>(&bytes).unwrap() else { panic!() };
        assert_eq!(back.reason, nasty);
        // An understated content length is caught rather than silently reallocating.
        let result = encode(&record, 10);
        assert!(matches!(result, Err(ref e) if e.code == ErrorCode::LimitExceeded));
    }
}

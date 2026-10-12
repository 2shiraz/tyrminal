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
pub(crate) const KIND_SNIPPET: u16 = 5;
pub(crate) const KIND_GROUP: u16 = 6;

const MARKER_TOMBSTONE: u8 = 0x00;
const MARKER_LIVE_V1: u8 = 0x01;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum StoredAuth {
    /// Use the nearest group's key, else ask.
    Inherit,
    AskPassword,
    Password {
        password: Zeroizing<String>,
    },
    Key {
        key_id: String,
    },
}

#[derive(Serialize, Deserialize)]
pub(crate) struct HostRecord {
    pub label: String,
    pub address: String,
    /// 0: inherit from the group chain (default 22).
    pub port: u16,
    /// Empty: inherit from the group chain.
    pub username: String,
    pub auth: StoredAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Unix seconds of the last connection that reached the shell. Absent in older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<u64>,
    // agent A: protocols
    /// SSH, Telnet or a serial device. Absent (SSH) in older records.
    #[serde(default, skip_serializing_if = "tyrminal_contracts::HostProtocol::is_ssh")]
    pub protocol: tyrminal_contracts::HostProtocol,
    /// Encoding and terminal type. Absent (UTF-8, xterm-256color) in older records.
    #[serde(default, skip_serializing_if = "tyrminal_contracts::HostTerminal::is_default")]
    pub terminal: tyrminal_contracts::HostTerminal,
    /// Agent forwarding to this host (off, and absent, unless the user turned it on).
    #[serde(default, skip_serializing_if = "core::ops::Not::not")]
    pub forward_agent: bool,
    // agent B: tunnels and history
    /// Jump host and other advanced connection settings. Absent in older records.
    #[serde(default, skip_serializing_if = "StoredConnection::is_default")]
    pub connection: StoredConnection,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct GroupRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct SnippetRecord {
    pub name: String,
    pub folder: String,
    pub text: String,
    pub updated_at: u64,
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

// agent B: tunnels and history
/// How a host is reached beyond address and credentials (`tunnels.rs` validates it).
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
pub(crate) struct StoredConnection {
    /// Host id of the jump host (`ProxyJump`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<StoredProxy>,
}

/// An outbound proxy. The password is a secret held in a zeroizing buffer, like host passwords.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub(crate) struct StoredProxy {
    pub kind: tyrminal_contracts::ProxyType,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<Zeroizing<String>>,
}

impl StoredConnection {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    /// Bytes of strings this adds to a host record (for the record's size reservation).
    pub fn content_len(&self) -> usize {
        self.jump_host.as_ref().map_or(0, String::len)
            + self
                .proxy
                .as_ref()
                .map_or(0, |p| p.host.len() + p.username.len() + p.password.as_ref().map_or(0, |s| s.len()))
    }
}

// Agent B's record kinds start at 100 so the two parallel branches never pick the same number.
pub(crate) const KIND_TUNNEL: u16 = 100;

/// A saved port-forwarding rule (`tunnels.rs` validates every field before it is stored).
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct TunnelRecord {
    pub name: String,
    pub host_id: String,
    pub kind: tyrminal_contracts::TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
    #[serde(default)]
    pub allow_external: bool,
    #[serde(default)]
    pub auto_start: bool,
    pub updated_at: u64,
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
            group: None,
            tags: Vec::new(),
            last_connected_at: None,
            protocol: tyrminal_contracts::HostProtocol::Ssh,
            terminal: tyrminal_contracts::HostTerminal::default(),
            forward_agent: false,
            connection: StoredConnection::default(),
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

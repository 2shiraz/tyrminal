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
// agent C: workspaces (kinds 20-29)
/// Named layout templates (`crate::layouts`).
pub(crate) const KIND_LAYOUT: u16 = 20;

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
    /// The host's own route, even when it sets neither a jump host nor a proxy (connect
    /// directly). Without it, a host that sets neither uses its nearest group's route (HST-05).
    /// Absent in older records, where a host that set neither was direct and no group had a route.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub own: bool,
    /// Post-quantum key exchange; the default (prefer) is not stored.
    #[serde(default, skip_serializing_if = "is_default_key_exchange")]
    pub key_exchange: tyrminal_contracts::KeyExchangeMode,
    /// Quick port forward suggestions are off for this host (P-24).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_port_suggestions: bool,
}

fn is_default_key_exchange(mode: &tyrminal_contracts::KeyExchangeMode) -> bool {
    *mode == tyrminal_contracts::KeyExchangeMode::default()
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

// agent D: inventory and snippets
// Agent D's record kinds start at 200 so parallel branches never pick the same number.
pub(crate) const KIND_HOST_APPEARANCE: u16 = 200;

/// Presentation settings of a host (its OS icon), apart from its connection settings. At most
/// one per host; deleting the host deletes it in the same transaction.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct HostAppearanceRecord {
    pub host_id: String,
    pub os: tyrminal_contracts::HostOs,
}

pub(crate) const KIND_KEY_CERTIFICATE: u16 = 201;
pub(crate) const KIND_EXECUTION_TARGET: u16 = 202;

/// A saved selection of hosts to run snippets on. Host ids may outlive their hosts; readers
/// skip the missing ones and report how many.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct ExecutionTargetRecord {
    pub name: String,
    pub host_ids: Vec<String>,
}

/// An OpenSSH user certificate for a key in the keychain (public data), checked against the key
/// when attached. At most one per key; deleting the key deletes it in the same transaction.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct KeyCertificateRecord {
    pub key_id: String,
    /// The certificate line (`<type> <base64> [comment]`).
    pub certificate: String,
    pub algorithm: String,
    pub cert_key_id: String,
    pub principals: Vec<String>,
    pub valid_after: u64,
    pub valid_before: u64,
    pub ca_fingerprint: String,
}

pub(crate) const KIND_IDENTITY: u16 = 203;
pub(crate) const KIND_WORKFLOW: u16 = 204;

/// A reusable identity: user name plus a password and/or a key reference. Hosts and groups refer
/// to it by id, so changing it changes every host that uses it.
#[derive(Serialize, Deserialize)]
pub(crate) struct IdentityRecord {
    pub label: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<Zeroizing<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

/// Settings a host or group carries apart from its connection record (identity, environment,
/// startup snippet). Exactly one of `host_id` / `group_id` is set; at most one record per target.
/// It is deleted with its host or group, and copied with a duplicated host.
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkflowRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<String>,
    /// Environment variables sent with sessions, in order. Values are sensitive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<StoredEnv>,
    /// Snippet ids typed into the shell once it is open (SNP-08). `None` inherits the nearest
    /// group's list; `Some([])` runs nothing. Absent in older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup: Option<Vec<String>>,
    /// Group defaults for its hosts' route and appearance (HST-05); never set on a host's record,
    /// whose own values live in its host and appearance records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<StoredProxy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<tyrminal_contracts::HostOs>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct StoredEnv {
    pub name: String,
    pub value: Zeroizing<String>,
}

impl WorkflowRecord {
    pub fn is_empty(&self) -> bool {
        self.identity_id.is_none()
            && self.env.is_empty()
            && self.startup.is_none()
            && self.jump_host.is_none()
            && self.proxy.is_none()
            && self.os.is_none()
    }

    pub fn content_len(&self) -> usize {
        self.host_id.as_ref().map_or(0, String::len)
            + self.group_id.as_ref().map_or(0, String::len)
            + self.identity_id.as_ref().map_or(0, String::len)
            + self.env.iter().map(|e| e.name.len() + e.value.len() + 8).sum::<usize>()
            + self.startup.as_ref().map_or(0, |ids| ids.iter().map(|id| id.len() + 4).sum())
            + StoredConnection {
                jump_host: self.jump_host.clone(),
                proxy: self.proxy.clone(),
                own: false,
                ..Default::default()
            }
            .content_len()
            + 16
    }
}

// command history
// Kinds 60–69 belong to command history.
/// The commands of one host, or of local terminals (one record each).
pub(crate) const KIND_HISTORY: u16 = 60;
/// Whether history is on (one record).
pub(crate) const KIND_HISTORY_SETTINGS: u16 = 61;

/// Remembered commands of one scope, least recently used first.
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct HistoryRecord {
    /// A host id, or `local` for local terminals.
    pub scope: String,
    pub commands: Vec<HistoryEntryRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct HistoryEntryRecord {
    pub command: String,
    pub last_used: u64,
    pub uses: u32,
}

impl HistoryRecord {
    pub fn content_len(&self) -> usize {
        self.scope.len() + self.commands.iter().map(|c| c.command.len() + 48).sum::<usize>()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Default)]
pub(crate) struct HistorySettingsRecord {
    #[serde(default)]
    pub enabled: bool,
}

// server at a glance
// Kinds 70–79 belong to server at a glance.
/// Hosts whose server panel is turned off (one record).
pub(crate) const KIND_GLANCE_SETTINGS: u16 = 70;

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct GlanceSettingsRecord {
    /// Ids of saved hosts with the panel off. Ids of deleted hosts are dropped on the next change.
    #[serde(default)]
    pub off_hosts: Vec<String>,
}

impl GlanceSettingsRecord {
    pub fn content_len(&self) -> usize {
        self.off_hosts.iter().map(|h| h.len() + 4).sum::<usize>() + 8
    }
}

// Session recordings
pub(crate) const KIND_SESSION_LOG: u16 = 101;
pub(crate) const KIND_RECORDING_SETTINGS: u16 = 102;

/// What the vault knows about one session recording. The recording itself is a separate encrypted
/// file named by this record's id (docs/crypto-format.md §11); everything identifying is here.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct SessionLogRecord {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub kind: tyrminal_contracts::SessionLogKind,
    /// Unix milliseconds.
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub size_bytes: u64,
    /// How it ended, once it has (`None` while recording, or if the application stopped first).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<LogEnd>,
    #[serde(default)]
    pub bookmarked: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub comment: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LogEnd {
    Closed,
    SizeLimit,
    Locked,
    Stopped,
}

/// The vault's recording settings (one record).
#[derive(Serialize, Deserialize, Clone, Copy)]
pub(crate) struct RecordingSettingsRecord {
    pub enabled: bool,
    pub keep_per_host: u32,
    pub max_log_mib: u32,
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

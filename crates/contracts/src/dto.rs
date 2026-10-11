use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::IpcError;

// ---------- vault ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocking,
    Unlocked,
    Locking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultStatus {
    pub state: VaultState,
    /// Increases every time the vault locks. Handles minted under an older generation are dead.
    pub generation: u32,
}

/// Returned once, by vault creation and by recovery-key rotation. The recovery key is shown to
/// the user and is not retrievable again.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecoveryKeyIssued {
    pub recovery_key: String,
}

impl core::fmt::Debug for RecoveryKeyIssued {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("RecoveryKeyIssued(<redacted>)")
    }
}

// ---------- hosts ----------

/// How a host authenticates. Never contains the secret itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum HostAuth {
    /// Ask for the password on every connection.
    AskPassword,
    /// A password is stored in the vault for this host.
    StoredPassword,
    /// Use a key from the keychain.
    Key {
        #[serde(rename = "keyId")]
        key_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostSummary {
    pub id: String,
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: HostAuth,
}

/// Authentication part of a host edit. `StoredPassword { password: None }` keeps the password
/// already stored; the UI never receives a stored password to echo back.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum HostAuthInput {
    AskPassword,
    StoredPassword {
        password: Option<String>,
    },
    Key {
        #[serde(rename = "keyId")]
        key_id: String,
    },
}

impl core::fmt::Debug for HostAuthInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::AskPassword => f.write_str("AskPassword"),
            Self::StoredPassword { .. } => f.write_str("StoredPassword(<redacted>)"),
            Self::Key { key_id } => f.debug_struct("Key").field("key_id", key_id).finish(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostInput {
    /// `None` creates a host; `Some` edits that host.
    pub id: Option<String>,
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: HostAuthInput,
}

// ---------- keys ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeySummary {
    pub id: String,
    pub label: String,
    /// SSH algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// `SHA256:` fingerprint of the public key.
    pub fingerprint: String,
    /// `<algorithm> <base64> <label>`: safe to show and copy.
    pub public_key: String,
    /// The private key text is itself passphrase-encrypted inside the vault record.
    pub passphrase_protected: bool,
    /// A passphrase is stored alongside so connecting does not prompt.
    pub passphrase_stored: bool,
    /// Number of hosts that reference this key.
    pub used_by: u32,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyImportInput {
    pub label: String,
    /// OpenSSH or PEM private key text. Secret: crosses IPC once, in this request only.
    pub private_key: String,
    /// Passphrase for an encrypted key. Needed to validate the key at import time.
    pub passphrase: Option<String>,
    /// Store the passphrase in the vault so connecting does not prompt.
    pub remember_passphrase: bool,
}

impl core::fmt::Debug for KeyImportInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("KeyImportInput").field("label", &self.label).finish_non_exhaustive()
    }
}

// ---------- known hosts ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KnownHostSummary {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    /// Unix seconds when trust was recorded.
    #[ts(type = "number")]
    pub added_at: u64,
}

// ---------- sessions ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionState {
    Resolving,
    Connecting,
    VerifyingHost,
    Authenticating,
    OpeningChannel,
    Connected,
    Closing,
    Closed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrustDecision {
    /// Abandon the connection.
    Cancel,
    /// Trust for this connection only; nothing is stored.
    Once,
    /// Trust and remember this key for the endpoint.
    Always,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthPromptKind {
    Password,
    KeyPassphrase,
}

/// Events for one session, delivered only on that session's own channel (never broadcast).
/// Text fields that originate from the server are untrusted: render as plain text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionEvent {
    State {
        state: SessionState,
    },
    /// First contact with this endpoint: the user must decide before anything else happens.
    #[serde(rename_all = "camelCase")]
    TrustPrompt {
        prompt_id: String,
        host: String,
        port: u16,
        resolved_address: Option<String>,
        algorithm: String,
        fingerprint: String,
    },
    /// The endpoint presented a different key than the trusted one. The connection is already
    /// closed and no credential was sent.
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        host: String,
        port: u16,
        algorithm: String,
        presented_fingerprint: String,
        trusted_fingerprints: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    AuthPrompt {
        prompt_id: String,
        kind: AuthPromptKind,
        username: String,
        /// 1-based attempt number.
        attempt: u32,
        max_attempts: u32,
    },
    /// Pre-authentication banner from the server. Untrusted.
    Banner {
        text: String,
    },
    /// Terminal: the session is over. `error` is `None` for a normal end.
    #[serde(rename_all = "camelCase")]
    Closed {
        error: Option<IpcError>,
        exit_status: Option<u32>,
    },
}

/// Returned when a session is opened. The id is an opaque handle bound to the calling window and
/// the vault generation; knowing it does not grant another window access (INV-06).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionOpened {
    pub session_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_bearing_inputs_do_not_print_their_secrets() {
        let key = KeyImportInput {
            label: "work".into(),
            private_key: "-----BEGIN CANARY-PRIVATE-KEY".into(),
            passphrase: Some("canary-passphrase".into()),
            remember_passphrase: true,
        };
        let auth = HostAuthInput::StoredPassword { password: Some("canary-password".into()) };
        let issued = RecoveryKeyIssued { recovery_key: "CANARY-RECOVERY".into() };
        let rendered = format!("{key:?} {auth:?} {issued:?}");
        assert!(!rendered.to_lowercase().contains("canary"), "{rendered}");
    }

    #[test]
    fn wire_format_is_stable() {
        let event = SessionEvent::TrustPrompt {
            prompt_id: "p1".into(),
            host: "h".into(),
            port: 22,
            resolved_address: None,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:x".into(),
        };
        // Field names are part of the contract with the generated TypeScript.
        let json = format!("{:?}", serde_json_like(&event));
        assert!(json.contains("trust_prompt") && json.contains("promptId") && json.contains("resolvedAddress"));
    }

    fn serde_json_like<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap_or_default()
    }
}

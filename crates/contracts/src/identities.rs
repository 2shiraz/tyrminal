//! Reusable identities (KEY-15..18): a user name, a password and a key from the keychain, saved
//! once and referenced by hosts and groups. A referencing host or group always uses the
//! identity's current values, so changing the identity changes every place that uses it.
//!
//! The password is write-only: no response type carries it, and inserting it into a terminal
//! (sudo and similar prompts) happens inside the core on an explicit user action.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A saved identity, as the renderer may see it (never the password).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentitySummary {
    pub id: String,
    pub label: String,
    /// Empty when the identity names no user (hosts then use their own or their group's).
    pub username: String,
    /// Whether a password is stored. The password itself never leaves the core.
    pub has_password: bool,
    /// A key from the keychain. Its attached certificate, if any, comes with it.
    pub key_id: Option<String>,
    /// Hosts that choose this identity themselves.
    pub used_by_hosts: u32,
    /// Groups that give this identity to their hosts.
    pub used_by_groups: u32,
}

/// What happens to an identity's stored password when it is saved.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum IdentityPasswordInput {
    /// Keep the stored password (or none, for a new identity).
    Keep,
    /// Remove the stored password.
    Clear,
    /// Store this password. A secret: redacted from `Debug`.
    Set { password: String },
}

impl core::fmt::Debug for IdentityPasswordInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Keep => f.write_str("Keep"),
            Self::Clear => f.write_str("Clear"),
            Self::Set { .. } => f.write_str("Set(<redacted>)"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentityInput {
    /// `None` creates an identity; `Some` edits that identity.
    pub id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub username: String,
    pub password: IdentityPasswordInput,
    #[serde(default)]
    pub key_id: Option<String>,
}

/// The identity whose password a terminal session can insert (KEY-18): the one its host uses,
/// directly or through its group. `None` from the query means there is nothing to insert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionIdentity {
    pub identity_id: String,
    pub label: String,
    /// Whether the identity has a stored password to insert.
    pub has_password: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_passwords_are_redacted_and_the_wire_format_is_stable() {
        let input = IdentityInput {
            id: None,
            label: "ops".into(),
            username: "deploy".into(),
            password: IdentityPasswordInput::Set { password: "canary-identity".into() },
            key_id: None,
        };
        assert!(!format!("{input:?}").contains("canary"));
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["password"]["kind"], "set");
        assert_eq!(json["keyId"], serde_json::Value::Null);
        let keep: IdentityInput =
            serde_json::from_str(r#"{"id":null,"label":"x","password":{"kind":"keep"}}"#).unwrap();
        assert!(matches!(keep.password, IdentityPasswordInput::Keep));
        assert!(keep.username.is_empty() && keep.key_id.is_none());
    }
}

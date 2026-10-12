//! Quick connect: a session to an address typed on Home that matches no saved host. Nothing is
//! saved: the address, user and sign-in are used for this one session (a typed password is used
//! once and dropped). Saving is a separate, explicit step (the host editor's normal save).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QuickProtocol {
    Ssh,
    /// Not encrypted; the device's own login prompt asks for credentials.
    Telnet,
}

/// How an SSH quick connection signs in.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum QuickAuth {
    /// Ask for the password when the server wants it (the normal sign-in prompt).
    Ask,
    /// Used for this session only, never stored.
    Password { password: String },
    Key {
        #[serde(rename = "keyId")]
        key_id: String,
    },
    /// A saved identity's credentials (and its user name when the input leaves it empty).
    Identity {
        #[serde(rename = "identityId")]
        identity_id: String,
    },
}

impl core::fmt::Debug for QuickAuth {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Ask => f.write_str("Ask"),
            Self::Password { .. } => f.write_str("Password(<redacted>)"),
            Self::Key { key_id } => f.debug_struct("Key").field("key_id", key_id).finish(),
            Self::Identity { identity_id } => f.debug_struct("Identity").field("identity_id", identity_id).finish(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuickConnectInput {
    pub protocol: QuickProtocol,
    /// A host name or an IP address (IPv6 with or without brackets); no scheme, user or path.
    pub address: String,
    pub port: u16,
    /// Required for SSH (unless the identity supplies one); ignored for Telnet.
    #[serde(default)]
    pub username: String,
    /// SSH only.
    pub auth: QuickAuth,
}

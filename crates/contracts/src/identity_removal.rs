//! Deleting an identity that hosts or groups still use (spec §10.2): refused unless the
//! user explicitly chooses to reassign its users to another identity or to remove it from them,
//! after seeing what each affected host will sign in with.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::SettingsTarget;

/// What to do with the hosts and groups that use an identity being deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum IdentityReferences {
    /// Every host and group that names the identity names this one instead.
    Reassign {
        #[serde(rename = "identityId")]
        identity_id: String,
    },
    /// The identity is removed from them; each then signs in as `IdentityUse::after_removal` says.
    Remove,
}

/// How a host signs in once an identity no longer applies to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SignInAfter {
    /// Another identity, from a group further up.
    Identity {
        #[serde(rename = "identityId")]
        identity_id: String,
        label: String,
    },
    /// A key (the host's own or a group's).
    Key {
        #[serde(rename = "keyId")]
        key_id: String,
        label: String,
    },
    /// The password stored on the host itself.
    StoredPassword,
    /// The password is asked for on every connection.
    AskPassword,
}

/// One host or group an identity applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentityUse {
    pub target: SettingsTarget,
    pub label: String,
    /// The target names the identity itself (false: a host that gets it from a group).
    pub direct: bool,
    /// For hosts: how the host signs in if the identity is removed. `None` for groups.
    pub after_removal: Option<SignInAfter>,
}

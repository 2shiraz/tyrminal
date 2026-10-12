//! Privilege-prompt assistance (KEY-18): which identity's password a terminal session could type.
//! The password itself is never part of the contract: it is read and typed inside the core.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The identity whose password a terminal session can insert: the one its host uses now,
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

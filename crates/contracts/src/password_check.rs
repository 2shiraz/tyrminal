//! Compromised-password check (SEC-11): stored passwords are looked up in a breach corpus with
//! a hash-prefix (k-anonymity) range query. Off by default; only the first five hexadecimal
//! characters of each password's SHA-1 hash leave the device.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The range endpoint used unless the user sets another. The request is `<endpoint><prefix>`.
pub const DEFAULT_PASSWORD_CHECK_ENDPOINT: &str = "https://api.pwnedpasswords.com/range/";

/// Opt-in settings, kept with the other preferences (not secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct PasswordCheckPreferences {
    /// Off until the user turns it on.
    pub enabled: bool,
    /// HTTPS base URL; the 5-character hash prefix is appended.
    pub endpoint: String,
}

impl Default for PasswordCheckPreferences {
    fn default() -> Self {
        Self { enabled: false, endpoint: DEFAULT_PASSWORD_CHECK_ENDPOINT.to_owned() }
    }
}

/// What the settings page shows before anything is checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PasswordCheckStatus {
    pub enabled: bool,
    pub endpoint: String,
    /// Whether this build can make the request at all.
    pub available: bool,
    /// Why not, when it cannot (a fixed sentence).
    pub unavailable_reason: Option<String>,
    /// How many distinct stored passwords a check would look up (one request each).
    pub stored_passwords: u32,
}

/// Where a stored password lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StoredPasswordKind {
    Host,
    Identity,
    Proxy,
    KeyPassphrase,
}

/// One stored password and what the check found. Never the password or its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PasswordCheckItem {
    pub kind: StoredPasswordKind,
    /// The host, identity or key it belongs to.
    pub label: String,
    /// Times the password appears in the corpus; 0 if not found.
    #[ts(type = "number")]
    pub breach_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PasswordCheckReport {
    pub items: Vec<PasswordCheckItem>,
    /// Range requests made (one per distinct hash prefix).
    pub requests: u32,
}

//! Security review (P-27, ADR 0011): weak keys, password sign-in, expiring certificates and
//! stale or RSA-only known hosts, found on the device over the unlocked vault. Public data
//! only: a finding names a record and never carries a secret.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Certificates expiring within this many seconds are reported (30 days).
pub const CERTIFICATE_WARNING_SECS: u64 = 30 * 24 * 60 * 60;

/// RSA keys shorter than this are reported.
pub const MIN_RSA_BITS: u32 = 3072;

/// How much a finding matters, most serious first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FindingSeverity {
    High,
    Medium,
    Low,
}

/// One thing the review found. Each names the record it is about; the fix is always the user's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum SecurityFinding {
    /// A DSA key: limited to 1024 bits and SHA-1, refused by current OpenSSH servers.
    DsaKey { key_id: String, label: String, used_by: u32 },
    /// An RSA key shorter than `MIN_RSA_BITS`.
    ShortRsaKey { key_id: String, label: String, bits: u32, used_by: u32 },
    /// A private key whose only protection is the vault's encryption: it has no passphrase of
    /// its own (keys Tyrminal generates are stored this way), or its passphrase is stored with it.
    KeyWithoutPassphrase { key_id: String, label: String, passphrase_stored: bool, used_by: u32 },
    /// An SSH host that signs in with a password: stored in the vault, or asked each time.
    PasswordSignIn { host_id: String, label: String, stored: bool },
    /// A user certificate that is no longer valid.
    CertificateExpired {
        key_id: String,
        label: String,
        #[ts(type = "number")]
        valid_before: u64,
    },
    /// A user certificate that expires within `CERTIFICATE_WARNING_SECS`.
    CertificateExpiring {
        key_id: String,
        label: String,
        #[ts(type = "number")]
        valid_before: u64,
    },
    /// A trusted host key for an address and port no SSH host in the inventory uses.
    UnusedKnownHost { known_host_id: String, host: String, port: u16, algorithm: String, fingerprint: String },
    /// Every trusted key for an address and port is an RSA (`ssh-rsa`) key. Tyrminal accepts an
    /// RSA host key only with SHA-2 signatures (`rsa-sha2-256`/`-512`), never SHA-1, so this is a
    /// note: an Ed25519 or ECDSA host key on the server would not depend on RSA at all.
    SshRsaOnlyKnownHost { known_host_id: String, host: String, port: u16, fingerprint: String },
}

impl SecurityFinding {
    pub fn severity(&self) -> FindingSeverity {
        match self {
            Self::DsaKey { .. } | Self::CertificateExpired { .. } => FindingSeverity::High,
            Self::ShortRsaKey { bits, .. } if *bits < 2048 => FindingSeverity::High,
            Self::ShortRsaKey { .. } | Self::PasswordSignIn { .. } | Self::CertificateExpiring { .. } => {
                FindingSeverity::Medium
            }
            Self::KeyWithoutPassphrase { .. } | Self::UnusedKnownHost { .. } | Self::SshRsaOnlyKnownHost { .. } => {
                FindingSeverity::Low
            }
        }
    }
}

/// The result of one review, ordered most serious first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecurityReview {
    pub findings: Vec<SecurityFinding>,
    /// How much was looked at, so "no findings" can say over what.
    pub keys: u32,
    pub hosts: u32,
    pub certificates: u32,
    pub known_hosts: u32,
    /// Unix seconds the review was computed at (certificate dates are compared with this).
    #[ts(type = "number")]
    pub reviewed_at: u64,
}

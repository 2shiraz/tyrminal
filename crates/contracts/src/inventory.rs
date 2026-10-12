//! Agent D's contract types: inventory presentation, importers, keys and snippets beyond the
//! original `dto.rs` set.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The operating system a host runs, as the user recorded it. Presentation only: it picks the
/// icon on the host tile and is never used to decide how to connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HostOs {
    Linux,
    Ubuntu,
    Debian,
    Fedora,
    RedHat,
    Centos,
    Alpine,
    Arch,
    Suse,
    RaspberryPi,
    FreeBsd,
    OpenBsd,
    Macos,
    Windows,
    NetworkDevice,
}

/// Presentation settings of one host, kept apart from its connection settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostAppearance {
    pub host_id: String,
    pub os: HostOs,
}

/// Key types Tyrminal generates. RSA is 3072 bits or more; DSA is never offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KeyKind {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    EcdsaP521,
    Rsa3072,
    Rsa4096,
}

/// An OpenSSH user certificate attached to a key in the keychain. Public data only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyCertificate {
    pub key_id: String,
    /// e.g. `ssh-ed25519-cert-v01@openssh.com`.
    pub algorithm: String,
    /// The certificate's own key id (set by the CA).
    pub cert_key_id: String,
    /// Empty: any principal the server accepts.
    pub principals: Vec<String>,
    #[ts(type = "number")]
    pub valid_after: u64,
    /// `null`: never expires.
    #[ts(type = "number | null")]
    pub valid_before: Option<u64>,
    /// `SHA256:` fingerprint of the signing CA key.
    pub ca_fingerprint: String,
}

/// What running a snippet on one host produced. Output is untrusted remote text: control
/// characters other than newline and tab are removed, and each stream keeps its first 64 KiB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnippetExecResult {
    /// `null` when the command ended without a status (killed by a signal, link closed).
    pub exit_status: Option<u32>,
    /// Signal name if the remote command was killed by one (untrusted text).
    pub exit_signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    /// Some output was not kept (over the per-stream limit).
    pub truncated: bool,
}

/// A saved selection of hosts to run snippets on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExecutionTarget {
    pub id: String,
    pub name: String,
    /// Hosts that still exist, in the saved order. Deleted hosts drop out.
    pub host_ids: Vec<String>,
    /// How many saved hosts no longer exist.
    pub missing: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExecutionTargetInput {
    /// `None` creates a target; `Some` replaces that target.
    pub id: Option<String>,
    pub name: String,
    pub host_ids: Vec<String>,
}

/// A private-key file the user picked in the native dialog. Its contents stay on the native side;
/// the renderer only learns its name and whether it needs a passphrase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PickedKeyFile {
    pub file_name: String,
    pub passphrase_protected: bool,
}

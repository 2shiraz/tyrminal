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
    /// The host sets no OS itself; this is its nearest group's default (HST-05).
    #[serde(default)]
    pub inherited: bool,
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
    /// Environment variables of the host that the server refused (SNP-13); names only.
    pub env_rejected: Vec<String>,
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

/// What importing one `known_hosts` entry would do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KnownHostImportStatus {
    /// Trusted after import.
    New,
    /// Exactly this key is already trusted for this host and port.
    AlreadyTrusted,
    /// A different key of the same type is trusted for this host and port. Never replaced by an
    /// import; use the explicit replace-trust flow.
    Conflict,
}

/// One host key from an OpenSSH `known_hosts` file. Public data only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KnownHostImportEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    /// `<algorithm> <base64>`.
    pub public_key: String,
    pub status: KnownHostImportStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KnownHostImportPreview {
    pub entries: Vec<KnownHostImportEntry>,
    pub skipped: Vec<crate::ImportSkipped>,
}

/// Shells the opt-in shell integration supports (AUT-07): Bash locally and over SSH, Zsh locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IntegrationShell {
    Bash,
    Zsh,
}

/// Where shell integration is installed: the server of a connected SSH session (its Bash
/// startup file) or this computer (the chosen shell's startup file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum IntegrationTarget {
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Local {
        shell: IntegrationShell,
    },
}

/// What installing shell integration at a target would do. `script` is the exact block written
/// to `path`; nothing is written until the user asks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IntegrationStatus {
    pub shell: IntegrationShell,
    /// The startup file, as shown to the user (`~/.bashrc`).
    pub path: String,
    pub file_exists: bool,
    /// The version this build installs.
    pub version: u32,
    /// The version found in the startup file, if any.
    pub installed_version: Option<u32>,
    /// The exact block that installing writes, markers included.
    pub script: String,
    /// Where the previous file is kept on install or removal.
    pub backup_path: String,
    /// The account's login shell on a server (`sh`, `bash`), when it reported one. Integration
    /// takes effect where Bash starts interactively and reads `~/.bashrc`.
    pub login_shell: Option<String>,
}

/// A reusable identity (KEY-15): a user name with a password and/or a key from the keychain.
/// The password never leaves the vault; only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentitySummary {
    pub id: String,
    pub label: String,
    pub username: String,
    pub has_password: bool,
    pub key_id: Option<String>,
    /// How many hosts and groups use it directly.
    pub used_by: u32,
}

/// What to do with a stored secret when saving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SecretChange {
    Keep,
    Clear,
    Set { value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentityInput {
    /// `None` creates a new identity.
    pub id: Option<String>,
    pub label: String,
    pub username: String,
    pub password: SecretChange,
    pub key_id: Option<String>,
}

/// A host or a group, for settings that hosts inherit from their groups.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SettingsTarget {
    Host {
        #[serde(rename = "hostId")]
        host_id: String,
    },
    Group {
        #[serde(rename = "groupId")]
        group_id: String,
    },
}

/// Where an effective setting comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SettingOrigin {
    /// Set on the host itself.
    Host,
    /// Inherited from this group (the nearest one that sets it).
    Group {
        #[serde(rename = "groupId")]
        group_id: String,
        name: String,
    },
}

/// The identity a target uses directly (`identity_id`) and, for a host, the one it ends up using
/// with where it comes from. A host's own identity wins; a group's identity applies to hosts in
/// it (and its subgroups) whose sign-in method is "inherit from group".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IdentityAssignment {
    pub target: SettingsTarget,
    pub identity_id: Option<String>,
    pub effective_identity_id: Option<String>,
    pub origin: Option<SettingOrigin>,
}

/// One environment variable a host or group sends with its sessions (SNP-11). Values are
/// sensitive: they are stored encrypted and shown only in the editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A variable a host ends up sending, and where it comes from (SNP-12): group values apply from
/// the outermost group in, nearer groups override them and the host's own override everything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EffectiveEnvVar {
    pub name: String,
    pub value: String,
    pub origin: SettingOrigin,
}

/// One startup snippet of a host (SNP-08). `name` is `None` when the snippet was deleted after it
/// was chosen; connecting skips it and says so in the connection log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StartupSnippet {
    pub snippet_id: String,
    pub name: Option<String>,
}

/// The snippets a host types into its shell once it is open, in order, and where the list comes
/// from: the host's own list, else the nearest group that sets one (`origin: None`: nothing set).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EffectiveStartup {
    pub snippets: Vec<StartupSnippet>,
    pub origin: Option<SettingOrigin>,
}

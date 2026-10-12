use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ErrorCode, IpcError};

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

/// What a backup file contains, shown before anything is restored. Counts only: names and
/// secrets stay encrypted until the restored vault is unlocked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupPreview {
    /// Seconds since the Unix epoch when the backup was written.
    #[ts(type = "number")]
    pub created_at: u64,
    pub hosts: u32,
    pub keys: u32,
    pub known_hosts: u32,
    pub snippets: u32,
}

/// A backup file the user picked in the native dialog. Its bytes stay on the native side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupFile {
    pub file_name: String,
    #[ts(type = "number")]
    pub size: u64,
}

/// Which secret opens a backup: the passphrase or the recovery key it was made with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BackupCredentialKind {
    Passphrase,
    RecoveryKey,
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

/// Which connection settings of a host come from its group chain rather than the host itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InheritedFields {
    pub username: bool,
    pub port: bool,
    pub auth: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostSummary {
    pub id: String,
    pub label: String,
    pub address: String,
    /// Effective port: the host's own, else the nearest group's, else 22.
    pub port: u16,
    /// Effective user name: the host's own, else the nearest group's; empty if neither sets one
    /// (connecting then asks the user to set it).
    pub username: String,
    /// Effective authentication: the host's own, else the nearest group's key, else ask.
    pub auth: HostAuth,
    /// What the effective values above were inherited from the group chain.
    pub inherited: InheritedFields,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    /// Unix seconds of the last connection that reached the shell, if any (recent connections).
    #[ts(type = "number | null")]
    pub last_connected_at: Option<u64>,
    pub protocol: HostProtocol,
    pub terminal: HostTerminal,
    pub forward_agent: bool,
}

/// A host group. Groups nest (no cycles) and give their hosts default connection settings;
/// the nearest group that sets a value wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupInput {
    /// `None` creates a group; `Some` edits that group.
    pub id: Option<String>,
    pub name: String,
    pub parent_id: Option<String>,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub key_id: Option<String>,
}

/// One change applied to several hosts at once, in a single transaction.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum BulkHostChange {
    /// Move to a group (`None`: out of every group).
    MoveToGroup {
        #[serde(rename = "groupId")]
        group_id: Option<String>,
    },
    AddTag {
        tag: String,
    },
    RemoveTag {
        tag: String,
    },
    Delete,
}

/// Where imported host definitions come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ImportFormat {
    /// An OpenSSH client configuration (`~/.ssh/config` syntax). Read as data only: nothing in
    /// it is executed, included or followed.
    OpensshConfig,
    /// CSV with a header row: label, address, port, username, group, tags.
    Csv,
    // agent D: inventory and snippets
    /// A Windows registry export (`.reg`) of PuTTY's saved sessions.
    PuttyReg,
    /// MobaXterm's `MobaXterm.ini` or an exported `.mxtsessions` file.
    Mobaxterm,
    /// SecureCRT's XML settings export, or one session's `.ini` file.
    Securecrt,
}

/// A host the import would create.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportHost {
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    /// Group path (`Parent/Child`), created on import if missing; empty for none.
    pub group: String,
    pub tags: Vec<String>,
    /// Notes for this entry, such as an identity file that was not imported.
    pub notes: Vec<String>,
}

/// Something in the source that was not imported, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportSkipped {
    pub line: u32,
    pub text: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportPreview {
    pub hosts: Vec<ImportHost>,
    pub skipped: Vec<ImportSkipped>,
    /// Hosts whose label already exists in the vault (imported as additional hosts).
    pub duplicates: Vec<String>,
}

/// Authentication part of a host edit. `StoredPassword { password: None }` keeps the password
/// already stored; the UI never receives a stored password to echo back.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum HostAuthInput {
    /// Use the nearest group's key, else ask for the password.
    Inherit,
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
            Self::Inherit => f.write_str("Inherit"),
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
    /// `None`: inherit from the group chain (default 22).
    pub port: Option<u16>,
    /// Empty: inherit from the group chain.
    pub username: String,
    pub auth: HostAuthInput,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// How the host is reached (SSH unless chosen otherwise).
    #[serde(default)]
    pub protocol: HostProtocol,
    /// Encoding and terminal type (UTF-8 and xterm-256color unless chosen otherwise).
    #[serde(default)]
    pub terminal: HostTerminal,
    /// Let the server use this host's sign-in key while the session is open (agent forwarding).
    #[serde(default)]
    pub forward_agent: bool,
}

/// The protocol a host is reached with (HST-01). Telnet is unencrypted; a serial host is a
/// device on this computer (its address and port are not used).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case", tag = "type")]
#[ts(export)]
pub enum HostProtocol {
    #[default]
    Ssh,
    Telnet,
    Serial {
        settings: SerialSettings,
    },
}

impl HostProtocol {
    pub fn is_ssh(&self) -> bool {
        *self == Self::Ssh
    }
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

/// What installing a public key on a server would do (or did), read from the server over an
/// open, verified session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyDeployPreview {
    /// The file on the server, as the server's shell names it.
    pub path: String,
    /// Keys already in that file (other lines are kept as they are).
    pub existing_keys: u32,
    /// The key is already authorized; deploying changes nothing.
    pub already_present: bool,
    /// The exact line that is (or would be) appended.
    pub line: String,
}

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

// ---------- snippets ----------

/// A saved command. The text is shown to the user for editing and preview; it is sent to a
/// session only by an explicit Paste or Run on a session the calling window owns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnippetSummary {
    pub id: String,
    pub name: String,
    /// Slash-separated folder path, e.g. `Deploy/Staging`; empty for the top level.
    pub folder: String,
    pub text: String,
    /// Unix seconds of the last edit.
    #[ts(type = "number")]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnippetInput {
    /// `None` creates a snippet; `Some` edits that snippet.
    pub id: Option<String>,
    pub name: String,
    pub folder: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SnippetSendMode {
    /// Insert the text at the prompt without running it (bracketed when the terminal asks for it).
    Paste,
    /// Send the text followed by Enter.
    Run,
}

// ---------- preferences ----------

/// Non-secret appearance and terminal preferences, stored in plain JSON next to the vault so the
/// lock screen can use them. Validated and clamped natively on every write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CursorStyle {
    #[default]
    Block,
    Bar,
    Underline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RendererPreference {
    /// GPU (WebGL) when available, falling back automatically.
    #[default]
    Auto,
    /// Always the DOM renderer.
    Compatibility,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TerminalPreferences {
    /// Id of a built-in color scheme.
    pub scheme: String,
    /// `jetbrains-mono` (bundled) or `system`.
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    /// Inner padding in CSS pixels.
    pub padding: u16,
    pub scrollback: u32,
    pub ligatures: bool,
    pub renderer: RendererPreference,
    /// Ask before sending a paste with more than one line or more than `paste_warn_bytes` bytes.
    pub confirm_multiline_paste: bool,
    pub copy_on_select: bool,
}

impl Default for TerminalPreferences {
    fn default() -> Self {
        Self {
            scheme: "tyrminal-night".into(),
            font_family: "jetbrains-mono".into(),
            font_size: 14.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            padding: 10,
            scrollback: 5_000,
            ligatures: false,
            renderer: RendererPreference::Auto,
            confirm_multiline_paste: true,
            copy_on_select: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Preferences {
    pub theme: ThemePreference,
    /// Reduce interface motion even if the OS does not ask for it.
    pub reduce_motion: bool,
    pub terminal: TerminalPreferences,
    /// Program for local terminals; one of the shells the system lists. `None`: the login shell.
    pub local_shell: Option<String>,
    /// Applications chosen (in a native dialog) for editing remote files, by extension.
    pub editor_apps: Vec<EditorApp>,
    /// Keep a local, in-memory list of recent failures for a diagnostic report. Off by default;
    /// separate from session recording and command history.
    pub diagnostics: bool,
}

/// One failure for a diagnostic report: which command failed and how, never with what.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiagnosticEntry {
    pub command: String,
    pub code: ErrorCode,
    /// Unix seconds.
    #[ts(type = "number")]
    pub at: u64,
}

/// An application used to edit remote files with a given extension. Added only through the
/// native app picker; the renderer can keep or remove entries but never add or change one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorApp {
    /// Lower-case, without the dot (`conf`, `yml`).
    pub extension: String,
    /// Absolute path of the application (an `.app` bundle on macOS).
    pub app: String,
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
    /// A keyboard-interactive (RFC 4256) prompt; `message` carries the server's question.
    KeyboardInteractive,
}

/// Events for one session, delivered only on that session's own channel (never broadcast).
/// Text fields that originate from the server are untrusted: render as plain text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionEvent {
    State {
        state: SessionState,
        /// During a jump-host chain: which hop this step belongs to (`None` for a direct
        /// connection and for session-level states such as `Connected`).
        #[serde(default)]
        hop: Option<crate::ChainPosition>,
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
        // agent B: tunnels and history
        /// For a jump-host chain: which hop is asking.
        #[serde(default)]
        hop: Option<crate::ChainPosition>,
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
        // agent B: tunnels and history
        #[serde(default)]
        hop: Option<crate::ChainPosition>,
    },
    #[serde(rename_all = "camelCase")]
    AuthPrompt {
        prompt_id: String,
        kind: AuthPromptKind,
        username: String,
        /// 1-based attempt number.
        attempt: u32,
        max_attempts: u32,
        /// Keyboard-interactive only: the server's instructions and question, sanitized but
        /// untrusted (render as plain text, never as markup). `None` for other kinds.
        message: Option<String>,
        /// Keyboard-interactive only: the server allows the answer to be shown while typed.
        echo: bool,
        // agent B: tunnels and history
        #[serde(default)]
        hop: Option<crate::ChainPosition>,
    },
    /// The algorithms the connection uses, after key exchange. Values come from the client's
    /// own offer list, never from server text.
    #[serde(rename_all = "camelCase")]
    Negotiated {
        kex: String,
        host_key: String,
        cipher: String,
        /// Empty for AEAD ciphers.
        mac: String,
        strict_kex: bool,
        /// During a jump-host chain: the hop whose key exchange this is. Sent for every hop as
        /// soon as its key exchange finishes, before its host key is verified.
        #[serde(default)]
        hop: Option<crate::ChainPosition>,
    },
    /// Pre-authentication banner from the server. Untrusted.
    Banner { text: String },
    /// Environment variables were requested for this session (SNP-13). Names only, never values.
    /// `rejected` lists those the server refused (usually not allowed by its `AcceptEnv`); they
    /// are not set in the session.
    Environment { sent: Vec<String>, rejected: Vec<String> },
    /// Terminal: the session is over. `error` is `None` for a normal end.
    #[serde(rename_all = "camelCase")]
    Closed { error: Option<IpcError>, exit_status: Option<u32> },
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
        // Preferences are not secret, but they must deserialize from partial or older files.
        let prefs: Preferences = serde_json::from_str(r#"{"theme":"dark","terminal":{"fontSize":16}}"#).unwrap();
        assert_eq!(prefs.theme, ThemePreference::Dark);
        assert!((prefs.terminal.font_size - 16.0).abs() < f32::EPSILON);
        assert_eq!(prefs.terminal.scrollback, 5_000);
        let rendered = format!("{key:?} {auth:?} {issued:?}");
        assert!(!rendered.to_lowercase().contains("canary"), "{rendered}");
    }

    #[test]
    fn state_and_negotiated_events_without_a_hop_still_parse() {
        let state: SessionEvent = serde_json::from_str(r#"{"type":"state","state":"connected"}"#).unwrap();
        assert_eq!(state, SessionEvent::State { state: SessionState::Connected, hop: None });
        let negotiated: SessionEvent = serde_json::from_str(
            r#"{"type":"negotiated","kex":"k","hostKey":"h","cipher":"c","mac":"","strictKex":true}"#,
        )
        .unwrap();
        assert!(matches!(negotiated, SessionEvent::Negotiated { hop: None, .. }));
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
            hop: None,
        };
        // Field names are part of the contract with the generated TypeScript.
        let json = format!("{:?}", serde_json_like(&event));
        assert!(json.contains("trust_prompt") && json.contains("promptId") && json.contains("resolvedAddress"));
    }

    fn serde_json_like<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap_or_default()
    }
}

// ---------- files (SFTP) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RemoteEntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// One entry of a remote folder. `name` is server-supplied text: display it, never interpret it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteEntry {
    pub name: String,
    pub kind: RemoteEntryKind,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    /// Permission bits (`0o7777`).
    pub permissions: Option<u32>,
    /// Seconds since the Unix epoch.
    #[ts(type = "number | null")]
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteListing {
    /// The folder's absolute path on the server.
    pub path: String,
    /// The parent folder, unless this is the root.
    pub parent: Option<String>,
    pub entries: Vec<RemoteEntry>,
    /// The folder has more entries than are listed.
    pub truncated: bool,
}

/// A local file or folder the user chose in a native dialog. The path stays on the native side;
/// the renderer refers to it by `token`, valid for the window that chose it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalPick {
    pub token: String,
    pub name: String,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
}

/// What a transfer does when its target name is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ConflictChoice {
    /// Refuse with a conflict, so the user can decide.
    Ask,
    /// Replace the existing file (files only; folders are never merged or replaced).
    Replace,
    /// Keep the existing one and use the first free name like `name (1).ext`.
    KeepBoth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TransferDirection {
    Upload,
    Download,
    /// From one server to another.
    Copy,
}

/// An upload whose content the window sends in pieces (a file dropped from the desktop).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StreamUpload {
    pub upload_id: String,
    /// The name it will have on the server (differs from the dropped file's with Keep both).
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TransferStarted {
    pub transfer_id: String,
    pub name: String,
    pub direction: TransferDirection,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum TransferEvent {
    Progress {
        #[ts(type = "number")]
        done: u64,
    },
    /// The file or folder is complete under its final name. `files` counts files copied;
    /// `skipped` counts links and special files inside a folder, which are never copied.
    Done {
        #[ts(type = "number")]
        bytes: u64,
        files: u32,
        skipped: u32,
    },
    /// Nothing was left under the final name; temporary data was removed where possible.
    Failed {
        error: IpcError,
    },
    Cancelled,
}

/// A remote file opened in a local application. `changed`: the local copy differs from what
/// was downloaded or last saved to the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditStatus {
    pub edit_id: String,
    pub name: String,
    pub changed: bool,
}

/// A folder inside a local folder the user chose (`token`), listed for the two-pane view. `path`
/// is the list of names below the chosen folder; the chosen folder itself is `[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalListing {
    pub token: String,
    pub root_name: String,
    pub path: Vec<String>,
    pub entries: Vec<RemoteEntry>,
    pub truncated: bool,
}

// ---------- serial connections (CON-06) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SerialParity {
    #[default]
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SerialFlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

/// How to open a serial port: the device (`/dev/ttyUSB0`, `COM3`) and its line settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SerialSettings {
    pub path: String,
    pub baud: u32,
    /// 5 to 8.
    pub data_bits: u8,
    pub parity: SerialParity,
    /// 1 or 2.
    pub stop_bits: u8,
    pub flow_control: SerialFlowControl,
}

impl Default for SerialSettings {
    fn default() -> Self {
        Self {
            path: String::new(),
            baud: 115_200,
            data_bits: 8,
            parity: SerialParity::None,
            stop_bits: 1,
            flow_control: SerialFlowControl::None,
        }
    }
}

// ---------- terminal settings per host (TRM-05, TRM-06) ----------

/// Character encoding a host's programs use. Output is converted to UTF-8 natively and typed
/// text back; characters the encoding cannot represent are sent as `?`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum TerminalEncoding {
    #[default]
    Utf8,
    Iso8859_1,
    Iso8859_15,
    Windows1252,
    Koi8R,
    ShiftJis,
    EucJp,
    EucKr,
    Gbk,
    Gb18030,
    Big5,
}

/// The terminal type reported to the server (`TERM`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum TerminalType {
    #[default]
    Xterm256color,
    Xterm,
    Linux,
    Vt220,
    Vt100,
}

impl TerminalType {
    pub fn term(self) -> &'static str {
        match self {
            Self::Xterm256color => "xterm-256color",
            Self::Xterm => "xterm",
            Self::Linux => "linux",
            Self::Vt220 => "vt220",
            Self::Vt100 => "vt100",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct HostTerminal {
    pub encoding: TerminalEncoding,
    pub term: TerminalType,
}

impl HostTerminal {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

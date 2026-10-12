//! Tyrminal application services.
//!
//! This crate owns the things the UI must never own: unlocked vault keys, decrypted records, SSH
//! connections, local processes and the rules that tie them together (lock generations, handle
//! ownership, trust and authentication prompts). It has no dependency on Tauri or the UI; the
//! adapter crate supplies a [`SessionSink`] and calls these services.

mod connlog;
mod deploy;
mod diagnostics;
mod discovery;
mod edits;
mod error;
mod files;
mod folders;
mod handoff;
mod import;
mod inventory;
mod preferences;
mod records;
mod remote_copy;
mod serial;
mod sessions;
mod streams;
mod telnet;
mod transcode;
mod validate;
mod vault;
// agent B: tunnels and history
mod tunnels;
// agent D: inventory and snippets
mod importers;
pub mod shell_integration;
mod snippet_runs;
// command history
mod command_history;
// server at a glance
mod server_glance;

pub use diagnostics::{ReportInfo, report as diagnostic_report};
pub use discovery::{BROWSE_DURATION, Discovery, SSH_SERVICE_TYPE, networks as discovery_networks};
pub use files::{TransferSink, list_local, local_within};
pub use preferences::PreferencesStore;
pub use serial::available_ports as serial_ports;
pub use sessions::{SessionSink, Sessions};
pub use tyrminal_contracts as contracts;
pub use tyrminal_platform::{
    MemorySecretStore, OsSecretStore, ScreenLockSupport, SecretStore, UnavailableSecretStore, restrict_to_owner,
    watch_screen_lock,
};
pub use tyrminal_pty::available_shells;
pub use vault::VaultService;
// agent D: inventory and snippets
pub use importers::key_text_is_encrypted;

use std::path::Path;
use std::sync::Arc;

use tyrminal_contracts::IpcError;
use tyrminal_storage::Database;

/// The application's long-lived services.
#[derive(Clone)]
pub struct Core {
    pub vault: Arc<VaultService>,
    pub sessions: Arc<Sessions>,
    pub preferences: Arc<PreferencesStore>,
    /// LAN discovery (HST-14); independent of the vault.
    pub discovery: Arc<Discovery>,
}

impl core::fmt::Debug for Core {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Core")
    }
}

impl Core {
    /// Opens the vault database at `db_path` (creating an empty one if needed). Blocking: the
    /// caller runs this once at startup, off the UI thread.
    pub fn open(db_path: &Path) -> Result<Self, IpcError> {
        Self::open_with_store(db_path, Arc::new(tyrminal_platform::UnavailableSecretStore))
    }

    /// Like `open`, with the OS secret store used for quick unlock.
    pub fn open_with_store(
        db_path: &Path,
        secret_store: Arc<dyn tyrminal_platform::SecretStore>,
    ) -> Result<Self, IpcError> {
        let db = Database::open(db_path).map_err(error::from_storage)?;
        let preferences = PreferencesStore::open(&db_path.with_file_name("preferences.json"));
        Ok(Self::with_database(db, preferences, secret_store))
    }

    fn with_database(
        db: Database,
        preferences: PreferencesStore,
        secret_store: Arc<dyn tyrminal_platform::SecretStore>,
    ) -> Self {
        let vault = Arc::new(VaultService::new(db, secret_store));
        let sessions = Sessions::new(Arc::clone(&vault));
        Self { vault, sessions, preferences: Arc::new(preferences), discovery: Discovery::new() }
    }
}

impl Core {
    /// Starts LAN discovery on `network_id` for `owner` (a window). Only while the vault is
    /// unlocked: the lock screen cannot start network activity.
    pub async fn discovery_start(
        &self,
        owner: &str,
        network_id: &str,
    ) -> Result<tyrminal_contracts::DiscoveryStatus, IpcError> {
        self.vault.require_unlocked().await?;
        self.discovery.start(owner, network_id)
    }
}

/// Validates a link the user asked to open from terminal output (http/https only, no embedded
/// credentials). The adapter opens only what this returns.
pub fn validate_link(url: &str) -> Result<String, IpcError> {
    validate::link(url)
}

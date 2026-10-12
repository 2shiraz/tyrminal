//! Tyrminal application services.
//!
//! This crate owns the things the UI must never own: unlocked vault keys, decrypted records, SSH
//! connections, local processes and the rules that tie them together (lock generations, handle
//! ownership, trust and authentication prompts). It has no dependency on Tauri or the UI; the
//! adapter crate supplies a [`SessionSink`] and calls these services.

mod error;
mod preferences;
mod records;
mod sessions;
mod validate;
mod vault;

pub use preferences::PreferencesStore;
pub use sessions::{SessionSink, Sessions};
pub use tyrminal_contracts as contracts;
pub use tyrminal_platform::restrict_to_owner;
pub use vault::VaultService;

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
        let db = Database::open(db_path).map_err(error::from_storage)?;
        let preferences = PreferencesStore::open(&db_path.with_file_name("preferences.json"));
        Ok(Self::with_database(db, preferences))
    }

    fn with_database(db: Database, preferences: PreferencesStore) -> Self {
        let vault = Arc::new(VaultService::new(db));
        let sessions = Sessions::new(Arc::clone(&vault));
        Self { vault, sessions, preferences: Arc::new(preferences) }
    }
}

/// Validates a link the user asked to open from terminal output (http/https only, no embedded
/// credentials). The adapter opens only what this returns.
pub fn validate_link(url: &str) -> Result<String, IpcError> {
    validate::link(url)
}

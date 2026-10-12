use std::path::PathBuf;

use tyrminal_core::Core;
use tyrminal_core::contracts::{ErrorCode, IpcError};

/// Local paths the user chose in native dialogs, by token, kept at most this many.
const MAX_GRANTS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    /// A file to upload.
    File,
    /// A folder to upload (with everything in it).
    UploadFolder,
    /// A folder to download into.
    Folder,
}

/// A local file or folder the user chose for one window. The renderer only holds its token.
pub struct Grant {
    pub owner: String,
    pub kind: GrantKind,
    pub path: PathBuf,
}

/// Managed application state. If the vault database could not be opened at startup the
/// application still runs and every command reports that failure, so the UI can explain it
/// instead of the window never appearing.
pub struct AppState {
    core: Result<Core, IpcError>,
    /// The backup file picked for restore (name and bytes), held natively between the preview
    /// and the restore so the renderer never handles paths or file contents.
    pub chosen_backup: std::sync::Mutex<Option<(String, Vec<u8>)>>,
    /// Local file grants, oldest first.
    grants: std::sync::Mutex<Vec<(String, Grant)>>,
    /// Where local copies of remote files being edited live (owner-only, emptied at start).
    pub edit_root: PathBuf,
    /// Held for the life of the process: one instance per data directory.
    _instance_lock: Option<std::fs::File>,
}

impl AppState {
    pub fn new(core: Result<Core, IpcError>, instance_lock: Option<std::fs::File>, edit_root: PathBuf) -> Self {
        Self {
            core,
            chosen_backup: std::sync::Mutex::new(None),
            grants: std::sync::Mutex::new(Vec::new()),
            edit_root,
            _instance_lock: instance_lock,
        }
    }

    pub fn core(&self) -> Result<&Core, IpcError> {
        self.core.as_ref().map_err(Clone::clone)
    }

    pub fn add_grant(&self, token: String, grant: Grant) {
        let mut grants = self.grants.lock().unwrap_or_else(|p| p.into_inner());
        if grants.len() >= MAX_GRANTS {
            grants.remove(0);
        }
        grants.push((token, grant));
    }

    /// The path behind a token, if the token was issued to `owner` for one of `kinds`.
    pub fn grant(&self, owner: &str, token: &str, kinds: &[GrantKind]) -> Result<PathBuf, IpcError> {
        let grants = self.grants.lock().unwrap_or_else(|p| p.into_inner());
        grants
            .iter()
            .find(|(t, g)| t == token && g.owner == owner && kinds.contains(&g.kind))
            .map(|(_, g)| g.path.clone())
            .ok_or_else(|| IpcError::new(ErrorCode::AccessDenied, "Choose the file or folder again."))
    }
}

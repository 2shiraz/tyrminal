use tyrminal_core::Core;
use tyrminal_core::contracts::IpcError;

/// Managed application state. If the vault database could not be opened at startup the
/// application still runs and every command reports that failure, so the UI can explain it
/// instead of the window never appearing.
pub struct AppState {
    core: Result<Core, IpcError>,
    /// The backup file picked for restore (name and bytes), held natively between the preview
    /// and the restore so the renderer never handles paths or file contents.
    pub chosen_backup: std::sync::Mutex<Option<(String, Vec<u8>)>>,
    /// Held for the life of the process: one instance per data directory.
    _instance_lock: Option<std::fs::File>,
}

impl AppState {
    pub fn new(core: Result<Core, IpcError>, instance_lock: Option<std::fs::File>) -> Self {
        Self { core, chosen_backup: std::sync::Mutex::new(None), _instance_lock: instance_lock }
    }

    pub fn core(&self) -> Result<&Core, IpcError> {
        self.core.as_ref().map_err(Clone::clone)
    }
}

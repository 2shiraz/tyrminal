use tyrminal_core::Core;
use tyrminal_core::contracts::IpcError;

/// Managed application state. If the vault database could not be opened at startup the
/// application still runs and every command reports that failure, so the UI can explain it
/// instead of the window never appearing.
pub struct AppState {
    core: Result<Core, IpcError>,
}

impl AppState {
    pub fn new(core: Result<Core, IpcError>) -> Self {
        Self { core }
    }

    pub fn core(&self) -> Result<&Core, IpcError> {
        self.core.as_ref().map_err(Clone::clone)
    }
}

use tauri::State;
use tyrminal_core::contracts::{HostSummary, IpcError, Preferences};

use crate::state::AppState;

#[tauri::command]
pub async fn prefs_get(state: State<'_, AppState>) -> Result<Preferences, IpcError> {
    Ok(state.core()?.preferences.get())
}

#[tauri::command]
pub async fn prefs_set(state: State<'_, AppState>, prefs: Preferences) -> Result<Preferences, IpcError> {
    state.core()?.preferences.set(prefs)
}

/// Shells that can be chosen for local terminals (absolute paths of installed shells).
#[tauri::command]
pub async fn shells_list() -> Result<Vec<String>, IpcError> {
    Ok(tyrminal_core::available_shells().into_iter().filter_map(|p| p.to_str().map(str::to_owned)).collect())
}

#[tauri::command]
pub async fn host_recent(state: State<'_, AppState>) -> Result<Vec<HostSummary>, IpcError> {
    state.core()?.vault.recent_hosts().await
}

/// Opens a web link from terminal output in the OS browser, after the user confirmed the exact
/// destination in the UI. Only http/https without embedded credentials is accepted (validated
/// natively); the URL goes to the OS opener as a single argument, never through a shell.
#[tauri::command]
pub async fn link_open(url: String) -> Result<(), IpcError> {
    let url = tyrminal_core::validate_link(&url)?;
    // Test builds never launch a browser; the UI reports the validated URL either way.
    #[cfg(feature = "e2e")]
    {
        let _ = url;
        Ok(())
    }
    #[cfg(not(feature = "e2e"))]
    {
        open::that_detached(&url).map_err(|_| {
            IpcError::new(tyrminal_core::contracts::ErrorCode::IoError, "The link could not be handed to your browser.")
        })
    }
}

//! Server at a glance (P-32): uptime, load, memory and disk use of the server behind an SSH
//! session, read with a fixed command on a separate exec channel (see `tyrminal_core`).

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{IpcError, ServerGlance};

use crate::state::AppState;

/// The values for a session this window owns. The server is asked at most every 5 s.
#[tauri::command]
pub async fn glance_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ServerGlance, IpcError> {
    state.core()?.sessions.server_glance(window.label(), &session_id).await
}

/// Whether the panel reads values for a saved host (on unless turned off).
#[tauri::command]
pub async fn glance_host_get(state: State<'_, AppState>, host_id: String) -> Result<bool, IpcError> {
    state.core()?.vault.glance_enabled(&host_id).await
}

#[tauri::command]
pub async fn glance_host_set(state: State<'_, AppState>, host_id: String, enabled: bool) -> Result<bool, IpcError> {
    state.core()?.vault.set_glance_enabled(&host_id, enabled).await
}

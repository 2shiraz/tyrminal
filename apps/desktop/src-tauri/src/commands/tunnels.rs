//! Port forwarding (tunnels). Rules are vault records; running forwards belong to the window that
//! started them and to one of its connected SSH sessions.

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{ActiveTunnel, IpcError, TunnelInput, TunnelSummary};

use crate::state::AppState;

#[tauri::command]
pub async fn tunnel_list(state: State<'_, AppState>) -> Result<Vec<TunnelSummary>, IpcError> {
    state.core()?.vault.list_tunnels().await
}

#[tauri::command]
pub async fn tunnel_save(state: State<'_, AppState>, tunnel: TunnelInput) -> Result<TunnelSummary, IpcError> {
    state.core()?.vault.save_tunnel(tunnel).await
}

#[tauri::command]
pub async fn tunnel_duplicate(state: State<'_, AppState>, id: String) -> Result<TunnelSummary, IpcError> {
    state.core()?.vault.duplicate_tunnel(&id).await
}

#[tauri::command]
pub async fn tunnel_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_tunnel(&id).await
}

/// Starts a saved rule on a connected SSH session this window owns.
#[tauri::command]
pub async fn tunnel_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    tunnel_id: String,
) -> Result<ActiveTunnel, IpcError> {
    state.core()?.sessions.start_tunnel(window.label(), &session_id, &tunnel_id).await
}

#[tauri::command]
pub async fn tunnel_stop(window: WebviewWindow, state: State<'_, AppState>, run_id: String) -> Result<(), IpcError> {
    state.core()?.sessions.stop_tunnel(window.label(), &run_id).await
}

/// This window's running and recently ended forwards, with live counters.
#[tauri::command]
pub async fn tunnel_active(window: WebviewWindow, state: State<'_, AppState>) -> Result<Vec<ActiveTunnel>, IpcError> {
    Ok(state.core()?.sessions.active_tunnels(window.label()))
}

#[tauri::command]
pub async fn tunnel_clear_ended(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.core()?.sessions.clear_ended_tunnels(window.label());
    Ok(())
}

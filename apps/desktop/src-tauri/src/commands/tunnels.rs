//! Port forwarding (tunnels). Rules are vault records; running forwards belong to the window that
//! started them and to one of its connected SSH sessions.

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{
    ActiveTunnel, ChainHop, HostConnection, HostConnectionInput, IpcError, TunnelInput, TunnelSummary,
};

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

/// A host's advanced connection settings (jump host).
#[tauri::command]
pub async fn host_connection_get(state: State<'_, AppState>, host_id: String) -> Result<HostConnection, IpcError> {
    state.core()?.vault.host_connection(&host_id).await
}

/// Replaces a host's advanced connection settings; returns the resulting chain.
#[tauri::command]
pub async fn host_connection_set(
    state: State<'_, AppState>,
    host_id: String,
    connection: HostConnectionInput,
) -> Result<Vec<ChainHop>, IpcError> {
    state.core()?.vault.set_host_connection(&host_id, connection).await
}

/// The hosts a connection goes through, first hop first, the host itself last.
#[tauri::command]
pub async fn host_chain(state: State<'_, AppState>, host_id: String) -> Result<Vec<ChainHop>, IpcError> {
    state.core()?.vault.host_chain(&host_id).await
}

// Quick port forwards (P-24)

/// Forwards a port this session's output named, after the user accepted the suggestion. The
/// destination is the server's loopback at that port; the listener is on 127.0.0.1.
#[tauri::command]
pub async fn quick_forward_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    port: u16,
) -> Result<ActiveTunnel, IpcError> {
    state.core()?.sessions.quick_forward(window.label(), &session_id, port).await
}

/// Opens `http://127.0.0.1:<local port>/` of a running quick forward in the OS browser. The address
/// is built natively from the bound port; the UI sends only the forward's handle. Returns it.
#[tauri::command]
pub async fn quick_forward_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<String, IpcError> {
    let url = state.core()?.sessions.quick_forward_url(window.label(), &run_id)?;
    // Test builds never launch a browser.
    #[cfg(not(feature = "e2e"))]
    open::that_detached(&url).map_err(|_| {
        IpcError::new(tyrminal_core::contracts::ErrorCode::IoError, "The address could not be handed to your browser.")
    })?;
    Ok(url)
}

/// Turns quick forward suggestions on or off for one host.
#[tauri::command]
pub async fn host_port_suggestions_set(
    state: State<'_, AppState>,
    host_id: String,
    enabled: bool,
) -> Result<(), IpcError> {
    state.core()?.vault.set_port_suggestions(&host_id, enabled).await
}

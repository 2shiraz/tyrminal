//! LAN discovery (HST-14): opt-in, user-started browsing for SSH servers on one network.

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{DiscoveryNetwork, DiscoveryStatus, IpcError};

use crate::state::AppState;

/// Networks the user can choose to browse on. Lists local interfaces only; sends nothing.
#[tauri::command]
pub async fn discovery_networks(state: State<'_, AppState>) -> Result<Vec<DiscoveryNetwork>, IpcError> {
    state.core()?;
    Ok(tyrminal_core::discovery_networks())
}

/// Starts browsing on the chosen network for a fixed time (vault unlocked only).
#[tauri::command]
pub async fn discovery_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    network_id: String,
) -> Result<DiscoveryStatus, IpcError> {
    state.core()?.discovery_start(window.label(), &network_id).await
}

#[tauri::command]
pub async fn discovery_status(window: WebviewWindow, state: State<'_, AppState>) -> Result<DiscoveryStatus, IpcError> {
    Ok(state.core()?.discovery.status(window.label()))
}

#[tauri::command]
pub async fn discovery_stop(window: WebviewWindow, state: State<'_, AppState>) -> Result<DiscoveryStatus, IpcError> {
    let core = state.core()?;
    core.discovery.stop(window.label());
    Ok(core.discovery.status(window.label()))
}

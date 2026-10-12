//! OS auto-detection: whether the server's OS is read once when a connection opens (on unless
//! turned off). The detected OS itself reaches the renderer through `host_appearance_list`.

use tauri::State;
use tyrminal_core::contracts::IpcError;

use crate::state::AppState;

#[tauri::command]
pub async fn os_detection_get(state: State<'_, AppState>) -> Result<bool, IpcError> {
    state.core()?.vault.os_detection_enabled().await
}

/// Turning it off also forgets every detected OS.
#[tauri::command]
pub async fn os_detection_set(state: State<'_, AppState>, enabled: bool) -> Result<bool, IpcError> {
    state.core()?.vault.set_os_detection_enabled(enabled).await
}

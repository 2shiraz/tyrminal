use tauri::State;
use tyrminal_core::contracts::{HostInput, HostSummary, IpcError, KeyImportInput, KeySummary, KnownHostSummary};

use crate::state::AppState;

#[tauri::command]
pub async fn host_list(state: State<'_, AppState>) -> Result<Vec<HostSummary>, IpcError> {
    state.core()?.vault.list_hosts().await
}

#[tauri::command]
pub async fn host_save(state: State<'_, AppState>, host: HostInput) -> Result<HostSummary, IpcError> {
    state.core()?.vault.save_host(host).await
}

#[tauri::command]
pub async fn host_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_host(&id).await
}

#[tauri::command]
pub async fn key_list(state: State<'_, AppState>) -> Result<Vec<KeySummary>, IpcError> {
    state.core()?.vault.list_keys().await
}

#[tauri::command]
pub async fn key_import(state: State<'_, AppState>, key: KeyImportInput) -> Result<KeySummary, IpcError> {
    state.core()?.vault.import_key(key).await
}

#[tauri::command]
pub async fn key_generate(state: State<'_, AppState>, label: String) -> Result<KeySummary, IpcError> {
    state.core()?.vault.generate_key(&label).await
}

#[tauri::command]
pub async fn key_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_key(&id).await
}

#[tauri::command]
pub async fn known_host_list(state: State<'_, AppState>) -> Result<Vec<KnownHostSummary>, IpcError> {
    state.core()?.vault.list_known_hosts().await
}

#[tauri::command]
pub async fn known_host_remove(state: State<'_, AppState>, id: String, reason: String) -> Result<(), IpcError> {
    state.core()?.vault.remove_known_host(&id, &reason).await
}

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{
    BulkHostChange, GroupInput, GroupSummary, HostInput, HostSummary, ImportFormat, ImportHost, ImportPreview,
    IpcError, KeyDeployPreview, KeyImportInput, KeySummary, KnownHostSummary,
};

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

#[tauri::command]
pub async fn host_search(state: State<'_, AppState>, query: String) -> Result<Vec<HostSummary>, IpcError> {
    state.core()?.vault.search_hosts(&query).await
}

#[tauri::command]
pub async fn host_duplicate(state: State<'_, AppState>, id: String) -> Result<HostSummary, IpcError> {
    state.core()?.vault.duplicate_host(&id).await
}

#[tauri::command]
pub async fn host_bulk(state: State<'_, AppState>, ids: Vec<String>, change: BulkHostChange) -> Result<u32, IpcError> {
    state.core()?.vault.bulk_update_hosts(&ids, change).await
}

#[tauri::command]
pub async fn group_list(state: State<'_, AppState>) -> Result<Vec<GroupSummary>, IpcError> {
    state.core()?.vault.list_groups().await
}

#[tauri::command]
pub async fn group_save(state: State<'_, AppState>, group: GroupInput) -> Result<GroupSummary, IpcError> {
    state.core()?.vault.save_group(group).await
}

#[tauri::command]
pub async fn group_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_group(&id).await
}

/// `text` is the content of a file the user picked in the renderer (read as data, at most
/// 1 MiB, checked again in the core).
#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    format: ImportFormat,
    text: String,
) -> Result<ImportPreview, IpcError> {
    state.core()?.vault.import_preview(format, &text).await
}

#[tauri::command]
pub async fn import_hosts(
    state: State<'_, AppState>,
    hosts: Vec<ImportHost>,
    into_group: Option<String>,
) -> Result<u32, IpcError> {
    state.core()?.vault.import_hosts(hosts, into_group).await
}

/// Reads the server's authorized keys over a connected SSH session this window owns and reports
/// what installing the key would change. Writes nothing.
#[tauri::command]
pub async fn key_deploy_preview(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    key_id: String,
) -> Result<KeyDeployPreview, IpcError> {
    state.core()?.sessions.deploy_key_preview(window.label(), &session_id, &key_id).await
}

/// Appends the key to the server's authorized keys over that session (an explicit user action).
#[tauri::command]
pub async fn key_deploy(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    key_id: String,
) -> Result<KeyDeployPreview, IpcError> {
    state.core()?.sessions.deploy_key(window.label(), &session_id, &key_id).await
}

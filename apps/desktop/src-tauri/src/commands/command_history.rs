//! Command history for suggestions (AUT-01). Remembered commands live in the vault; the renderer
//! submits only command lines taken from shell-integration marks, and only while history is on.

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{HistoryEntry, HistorySettings, IpcError};

use crate::state::AppState;

#[tauri::command]
pub async fn history_settings_get(state: State<'_, AppState>) -> Result<HistorySettings, IpcError> {
    state.core()?.vault.history_settings().await
}

/// Turning history off stops remembering and suggesting and keeps what was remembered.
#[tauri::command]
pub async fn history_settings_set(
    state: State<'_, AppState>,
    settings: HistorySettings,
) -> Result<HistorySettings, IpcError> {
    state.core()?.vault.set_history_settings(settings).await
}

/// Adds a command line of a session this window owns to its host's history.
#[tauri::command]
pub async fn history_add(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.history_add(window.label(), &session_id, &command).await
}

/// Suggestions from the history of a session's host. Picking one only inserts it.
#[tauri::command]
pub async fn history_suggest(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    query: String,
) -> Result<Vec<String>, IpcError> {
    state.core()?.sessions.history_suggest(window.label(), &session_id, &query).await
}

#[tauri::command]
pub async fn history_list(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, IpcError> {
    state.core()?.vault.list_history().await
}

/// Forgets one command of a host (`hostId` null: of local terminals).
#[tauri::command]
pub async fn history_delete(
    state: State<'_, AppState>,
    host_id: Option<String>,
    command: String,
) -> Result<(), IpcError> {
    state.core()?.vault.delete_history(host_id.as_deref(), &command).await
}

#[tauri::command]
pub async fn history_clear(state: State<'_, AppState>) -> Result<u32, IpcError> {
    state.core()?.vault.clear_history().await
}

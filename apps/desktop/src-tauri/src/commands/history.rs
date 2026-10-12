//! Session recordings. Recording is a vault setting; recordings are vault records plus encrypted
//! files, opened read-only for playback.

use tauri::State;
use tyrminal_core::contracts::{IpcError, RecordingSettings, SessionLogPlayback, SessionLogStorage, SessionLogSummary};

use crate::state::AppState;

#[tauri::command]
pub async fn recording_settings_get(state: State<'_, AppState>) -> Result<RecordingSettings, IpcError> {
    state.core()?.sessions.recording_settings().await
}

/// Turning recording off stops running recordings and keeps existing ones.
#[tauri::command]
pub async fn recording_settings_set(
    state: State<'_, AppState>,
    settings: RecordingSettings,
) -> Result<RecordingSettings, IpcError> {
    state.core()?.sessions.set_recording_settings(settings).await
}

#[tauri::command]
pub async fn session_log_list(state: State<'_, AppState>) -> Result<Vec<SessionLogSummary>, IpcError> {
    state.core()?.sessions.list_session_logs().await
}

#[tauri::command]
pub async fn session_log_storage(state: State<'_, AppState>) -> Result<SessionLogStorage, IpcError> {
    state.core()?.sessions.session_log_storage().await
}

#[tauri::command]
pub async fn session_log_bookmark(
    state: State<'_, AppState>,
    id: String,
    bookmarked: bool,
    comment: String,
) -> Result<SessionLogSummary, IpcError> {
    state.core()?.sessions.bookmark_session_log(&id, bookmarked, comment).await
}

#[tauri::command]
pub async fn session_log_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.sessions.delete_session_log(&id).await
}

/// Deletes every recording that is not running. Separate from turning recording off.
#[tauri::command]
pub async fn session_log_delete_all(state: State<'_, AppState>) -> Result<u32, IpcError> {
    state.core()?.sessions.delete_all_session_logs().await
}

/// Opens a recording for read-only playback.
#[tauri::command]
pub async fn session_log_open(state: State<'_, AppState>, id: String) -> Result<SessionLogPlayback, IpcError> {
    state.core()?.sessions.open_session_log(&id).await
}

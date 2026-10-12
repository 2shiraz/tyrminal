use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{IpcError, SnippetInput, SnippetSendMode, SnippetSummary};

use crate::state::AppState;

#[tauri::command]
pub async fn snippet_list(state: State<'_, AppState>) -> Result<Vec<SnippetSummary>, IpcError> {
    state.core()?.vault.list_snippets().await
}

#[tauri::command]
pub async fn snippet_save(state: State<'_, AppState>, snippet: SnippetInput) -> Result<SnippetSummary, IpcError> {
    state.core()?.vault.save_snippet(snippet).await
}

#[tauri::command]
pub async fn snippet_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_snippet(&id).await
}

/// Paste or Run a saved snippet in a session this window owns. `bracketed` reports whether the
/// terminal currently has bracketed-paste mode on (only the renderer's parser knows).
#[tauri::command]
pub async fn snippet_send(
    window: WebviewWindow,
    state: State<'_, AppState>,
    snippet_id: String,
    session_id: String,
    mode: SnippetSendMode,
    bracketed: bool,
) -> Result<(), IpcError> {
    state.core()?.sessions.send_snippet(window.label(), &session_id, &snippet_id, mode, bracketed).await
}

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

// agent D: inventory and snippets

/// Runs a saved snippet without a terminal on a session this window owns and returns its exit
/// status and bounded output (multi-host and existing-session execution).
#[tauri::command]
pub async fn snippet_exec(
    window: WebviewWindow,
    state: State<'_, AppState>,
    snippet_id: String,
    session_id: String,
    run_id: String,
) -> Result<tyrminal_core::contracts::SnippetExecResult, IpcError> {
    state.core()?.sessions.exec_snippet(window.label(), &session_id, &snippet_id, &run_id).await
}

#[tauri::command]
pub async fn snippet_exec_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.cancel_snippet_run(window.label(), &run_id);
    Ok(())
}

#[tauri::command]
pub async fn execution_target_list(
    state: State<'_, AppState>,
) -> Result<Vec<tyrminal_core::contracts::ExecutionTarget>, IpcError> {
    state.core()?.vault.list_execution_targets().await
}

#[tauri::command]
pub async fn execution_target_save(
    state: State<'_, AppState>,
    target: tyrminal_core::contracts::ExecutionTargetInput,
) -> Result<tyrminal_core::contracts::ExecutionTarget, IpcError> {
    state.core()?.vault.save_execution_target(target).await
}

#[tauri::command]
pub async fn execution_target_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_execution_target(&id).await
}

/// Moves (or with `copy`, copies) snippets into a folder, all in one transaction.
#[tauri::command]
pub async fn snippet_move(
    state: State<'_, AppState>,
    ids: Vec<String>,
    folder: String,
    copy: bool,
) -> Result<Vec<SnippetSummary>, IpcError> {
    state.core()?.vault.move_snippets(&ids, &folder, copy).await
}

#[tauri::command]
pub async fn snippet_folder_rename(state: State<'_, AppState>, from: String, to: String) -> Result<u32, IpcError> {
    state.core()?.vault.rename_snippet_folder(&from, &to).await
}

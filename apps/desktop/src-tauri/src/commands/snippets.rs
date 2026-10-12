use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{IpcError, SnippetInput, SnippetSendMode, SnippetSummary};
// Shell integration (AUT-07).
use tyrminal_core::contracts::{ErrorCode, IntegrationStatus, IntegrationTarget};
use tyrminal_core::shell_integration;

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

/// The home folder whose startup files local shell integration edits. Test builds use a
/// disposable folder named by `TYRMINAL_E2E_HOME`, never the real one.
fn integration_home() -> Result<std::path::PathBuf, IpcError> {
    let unavailable = || {
        IpcError::new(
            ErrorCode::InvalidInput,
            "Shell integration on this computer is available for Bash and Zsh on macOS and Linux.",
        )
    };
    if cfg!(windows) {
        return Err(unavailable());
    }
    let var = if cfg!(feature = "e2e") { "TYRMINAL_E2E_HOME" } else { "HOME" };
    std::env::var_os(var).filter(|h| !h.is_empty()).map(std::path::PathBuf::from).ok_or_else(unavailable)
}

/// What installing shell integration at `target` would write. Reads only.
#[tauri::command]
pub async fn prompt_marks_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
    target: IntegrationTarget,
) -> Result<IntegrationStatus, IpcError> {
    match target {
        IntegrationTarget::Session { session_id } => {
            state.core()?.sessions.integration_status(window.label(), &session_id).await
        }
        IntegrationTarget::Local { shell } => {
            let home = integration_home()?;
            blocking(move || shell_integration::local_status(&home, shell)).await
        }
    }
}

/// Writes the shell integration block at `target`. Only ever called from the user's Install
/// button, after the exact block was shown.
#[tauri::command]
pub async fn prompt_marks_install(
    window: WebviewWindow,
    state: State<'_, AppState>,
    target: IntegrationTarget,
) -> Result<IntegrationStatus, IpcError> {
    match target {
        IntegrationTarget::Session { session_id } => {
            state.core()?.sessions.integration_install(window.label(), &session_id).await
        }
        IntegrationTarget::Local { shell } => {
            let home = integration_home()?;
            blocking(move || shell_integration::local_install(&home, shell)).await
        }
    }
}

#[tauri::command]
pub async fn prompt_marks_remove(
    window: WebviewWindow,
    state: State<'_, AppState>,
    target: IntegrationTarget,
) -> Result<IntegrationStatus, IpcError> {
    match target {
        IntegrationTarget::Session { session_id } => {
            state.core()?.sessions.integration_remove(window.label(), &session_id).await
        }
        IntegrationTarget::Local { shell } => {
            let home = integration_home()?;
            blocking(move || shell_integration::local_remove(&home, shell)).await
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err(IpcError::new(ErrorCode::Internal, "The change did not finish.")))
}

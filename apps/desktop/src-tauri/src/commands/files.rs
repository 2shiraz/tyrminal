//! Remote files (SFTP) for a connected SSH session.
//!
//! Local files and folders are chosen in native dialogs opened from here. Their paths stay on the
//! native side as grants: the renderer receives an opaque token for the window that chose them,
//! and every upload or download names a grant, never a path (BUILD_SPEC Phase 06 "scoped file
//! grants").

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, State, WebviewWindow};
use tyrminal_core::TransferSink;
use tyrminal_core::contracts::{
    EditStatus, ErrorCode, IpcError, LocalPick, RemoteListing, TransferEvent, TransferStarted,
};

use crate::state::{AppState, Grant, GrantKind};

struct ChannelTransferSink(Channel<TransferEvent>);

impl TransferSink for ChannelTransferSink {
    fn event(&self, event: TransferEvent) -> bool {
        self.0.send(event).is_ok()
    }
}

#[cfg_attr(feature = "e2e", allow(dead_code))]
fn dialog_error() -> IpcError {
    IpcError::new(ErrorCode::IoError, "The file dialog could not be shown.")
}

fn token() -> Result<String, IpcError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| IpcError::new(ErrorCode::Internal, "Something went wrong."))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn file_name(path: &std::path::Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Files to upload. Test builds take one path from `TYRMINAL_E2E_UPLOAD_PATH` (WebDriver cannot
/// drive OS dialogs); release builds never read it.
async fn pick_files(app: &AppHandle) -> Result<Vec<PathBuf>, IpcError> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(std::env::var_os("TYRMINAL_E2E_UPLOAD_PATH").map(PathBuf::from).into_iter().collect())
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file();
        let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
            .await
            .map_err(|_| dialog_error())?;
        Ok(picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect())
    }
}

/// A folder to upload. Test builds read `TYRMINAL_E2E_UPLOAD_DIR`.
async fn pick_upload_folder(app: &AppHandle) -> Result<Option<PathBuf>, IpcError> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(std::env::var_os("TYRMINAL_E2E_UPLOAD_DIR").map(PathBuf::from))
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file();
        let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
            .await
            .map_err(|_| dialog_error())?;
        Ok(picked.and_then(|p| p.into_path().ok()))
    }
}

/// A folder to download into. Test builds read `TYRMINAL_E2E_DOWNLOAD_DIR`.
async fn pick_folder(app: &AppHandle) -> Result<Option<PathBuf>, IpcError> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(std::env::var_os("TYRMINAL_E2E_DOWNLOAD_DIR").map(PathBuf::from))
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file();
        let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
            .await
            .map_err(|_| dialog_error())?;
        Ok(picked.and_then(|p| p.into_path().ok()))
    }
}

fn grant(state: &AppState, owner: &str, kind: GrantKind, path: PathBuf) -> Result<LocalPick, IpcError> {
    let size = if kind == GrantKind::File { std::fs::metadata(&path).ok().map(|m| m.len()) } else { None };
    let pick = LocalPick { token: token()?, name: file_name(&path), size };
    state.add_grant(pick.token.clone(), Grant { owner: owner.to_owned(), kind, path });
    Ok(pick)
}

/// Lets the user choose files to upload. Empty: the dialog was cancelled.
#[tauri::command]
pub async fn files_pick_upload(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<LocalPick>, IpcError> {
    state.core()?;
    let paths = pick_files(&app).await?;
    paths.into_iter().map(|p| grant(&state, window.label(), GrantKind::File, p)).collect()
}

/// Lets the user choose a folder to upload (with everything in it). `None`: cancelled.
#[tauri::command]
pub async fn files_pick_upload_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<LocalPick>, IpcError> {
    state.core()?;
    let Some(path) = pick_upload_folder(&app).await? else { return Ok(None) };
    grant(&state, window.label(), GrantKind::UploadFolder, path).map(Some)
}

/// Lets the user choose a folder to download into. `None`: the dialog was cancelled.
#[tauri::command]
pub async fn files_pick_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<LocalPick>, IpcError> {
    state.core()?;
    let Some(path) = pick_folder(&app).await? else { return Ok(None) };
    grant(&state, window.label(), GrantKind::Folder, path).map(Some)
}

#[tauri::command]
pub async fn files_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<RemoteListing, IpcError> {
    state.core()?.sessions.list_files(window.label(), &session_id, path.as_deref()).await
}

#[tauri::command]
pub async fn files_mkdir(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    name: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.make_dir(window.label(), &session_id, &dir, &name).await
}

#[tauri::command]
pub async fn files_rename(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    from: String,
    to: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.rename_file(window.label(), &session_id, &dir, &from, &to).await
}

#[tauri::command]
pub async fn files_remove(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    name: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.remove_file(window.label(), &session_id, &dir, &name).await
}

#[tauri::command]
pub async fn files_chmod(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    name: String,
    mode: u32,
) -> Result<(), IpcError> {
    state.core()?.sessions.set_file_mode(window.label(), &session_id, &dir, &name, mode).await
}

/// Uploads a chosen local file or folder into the remote folder `dir`, under its own name.
#[tauri::command]
pub async fn files_upload(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    token: String,
    dir: String,
    overwrite: bool,
    events: Channel<TransferEvent>,
) -> Result<TransferStarted, IpcError> {
    let path = state.grant(window.label(), &token, &[GrantKind::File, GrantKind::UploadFolder])?;
    let name = file_name(&path);
    let sink = Arc::new(ChannelTransferSink(events));
    state.core()?.sessions.upload(window.label(), &session_id, path, &dir, &name, overwrite, sink).await
}

/// Downloads the remote file or folder `dir/name` into a chosen local folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn files_download(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    name: String,
    token: String,
    overwrite: bool,
    events: Channel<TransferEvent>,
) -> Result<TransferStarted, IpcError> {
    let folder = state.grant(window.label(), &token, &[GrantKind::Folder])?;
    let sink = Arc::new(ChannelTransferSink(events));
    state.core()?.sessions.download(window.label(), &session_id, &dir, &name, folder, overwrite, sink).await
}

#[tauri::command]
pub async fn files_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.cancel_transfer(window.label(), &transfer_id)
}

/// Opens a remote file in the default local application for its type. The core downloads it into
/// an owner-only folder; nothing is uploaded until `files_edit_save`.
#[tauri::command]
pub async fn files_edit_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    name: String,
) -> Result<EditStatus, IpcError> {
    if state.edit_root.as_os_str().is_empty() {
        return Err(IpcError::new(ErrorCode::IoError, "There is no place to keep files being edited."));
    }
    let (path, status) =
        state.core()?.sessions.edit_open(window.label(), &session_id, &dir, &name, &state.edit_root).await?;
    // Test builds do not launch other applications; the test edits the file directly.
    #[cfg(not(feature = "e2e"))]
    open::that_detached(&path).map_err(|_| {
        IpcError::new(ErrorCode::IoError, "No application could open that file. It is still open for editing.")
    })?;
    #[cfg(feature = "e2e")]
    let _ = path;
    Ok(status)
}

#[tauri::command]
pub async fn files_edit_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
    edit_id: String,
) -> Result<EditStatus, IpcError> {
    state.core()?.sessions.edit_status(window.label(), &edit_id).await
}

#[tauri::command]
pub async fn files_edit_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    edit_id: String,
    overwrite: bool,
) -> Result<EditStatus, IpcError> {
    state.core()?.sessions.edit_save(window.label(), &edit_id, overwrite).await
}

#[tauri::command]
pub async fn files_edit_close(
    window: WebviewWindow,
    state: State<'_, AppState>,
    edit_id: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.edit_close(window.label(), &edit_id).await
}

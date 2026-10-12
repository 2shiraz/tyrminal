//! Portable backups. Files are chosen in native dialogs opened from here; the renderer never
//! supplies a path and never receives file contents (docs/crypto-format.md §10).

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tyrminal_core::contracts::{BackupCredentialKind, BackupFile, BackupPreview, ErrorCode, IpcError};

use crate::state::AppState;

#[cfg(not(feature = "e2e"))]
const EXTENSION: &str = "tyrbackup";
/// Same bound the vault crate enforces when parsing (`MAX_BACKUP_LEN`).
const MAX_FILE_LEN: u64 = 256 * 1024 * 1024;

fn io_error(message: &'static str) -> IpcError {
    IpcError::new(ErrorCode::IoError, message)
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(not(feature = "e2e"))]
pub(crate) fn today() -> String {
    // Days since the epoch to a civil date (no time zone; the name is only a suggestion).
    let days =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
            as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Where to save. Test builds take the path from `TYRMINAL_E2E_BACKUP_PATH` instead of a native
/// dialog (WebDriver cannot drive OS dialogs); release builds never read it.
async fn save_path(app: &AppHandle) -> Result<Option<PathBuf>, IpcError> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(std::env::var_os("TYRMINAL_E2E_BACKUP_PATH").map(PathBuf::from))
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app
            .dialog()
            .file()
            .add_filter("Tyrminal backup", &[EXTENSION])
            .set_file_name(format!("tyrminal-backup-{}.{EXTENSION}", today()));
        let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
            .await
            .map_err(|_| io_error("The save dialog could not be shown."))?;
        picked.map(|p| p.into_path().map_err(|_| io_error("That location cannot be used."))).transpose()
    }
}

async fn open_path(app: &AppHandle) -> Result<Option<PathBuf>, IpcError> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(std::env::var_os("TYRMINAL_E2E_BACKUP_PATH").map(PathBuf::from))
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file().add_filter("Tyrminal backup", &[EXTENSION]);
        let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
            .await
            .map_err(|_| io_error("The file dialog could not be shown."))?;
        picked.map(|p| p.into_path().map_err(|_| io_error("That file cannot be used."))).transpose()
    }
}

/// Writes to a new owner-only temporary file next to the target, then renames it into place, so
/// a crash never leaves a half-written backup under the chosen name.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let tmp = dir.join(format!(".{}.partial", file_name(path)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Saves a backup of the unlocked vault where the user chooses. `None`: the dialog was cancelled.
#[tauri::command]
pub async fn backup_export(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, IpcError> {
    let bytes = state.core()?.vault.export_backup().await?;
    let Some(path) = save_path(&app).await? else { return Ok(None) };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_private(&target, &bytes))
        .await
        .map_err(|_| io_error("The backup could not be written."))?
        .map_err(|_| io_error("The backup could not be written there. Choose another location."))?;
    Ok(Some(file_name(&path)))
}

/// Lets the user pick a backup to restore. Nothing is decrypted yet.
#[tauri::command]
pub async fn backup_choose(app: AppHandle, state: State<'_, AppState>) -> Result<Option<BackupFile>, IpcError> {
    let Some(path) = open_path(&app).await? else { return Ok(None) };
    let read = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<Option<Vec<u8>>> {
        let len = std::fs::metadata(&read)?.len();
        if len > MAX_FILE_LEN {
            return Ok(None);
        }
        std::fs::read(&read).map(Some)
    })
    .await
    .map_err(|_| io_error("The file could not be read."))?
    .map_err(|_| io_error("The file could not be read."))?
    .ok_or_else(|| IpcError::new(ErrorCode::LimitExceeded, "The file is too large to be a Tyrminal backup."))?;
    let chosen = BackupFile { file_name: file_name(&path), size: bytes.len() as u64 };
    *state.chosen_backup.lock().unwrap_or_else(|p| p.into_inner()) = Some((chosen.file_name.clone(), bytes));
    Ok(Some(chosen))
}

fn chosen_bytes(state: &AppState) -> Result<Vec<u8>, IpcError> {
    state
        .chosen_backup
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|(_, bytes)| bytes.clone())
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "Choose a backup file first."))
}

/// Validates the chosen backup completely with its passphrase or recovery key and reports what
/// it contains. Changes nothing.
#[tauri::command]
pub async fn backup_preview(
    state: State<'_, AppState>,
    kind: BackupCredentialKind,
    secret: String,
) -> Result<BackupPreview, IpcError> {
    let bytes = chosen_bytes(&state)?;
    state.core()?.vault.preview_backup(bytes, kind, secret).await
}

/// Replaces this device's vault with the chosen backup (validated again first) and locks it.
#[tauri::command]
pub async fn backup_restore(
    state: State<'_, AppState>,
    kind: BackupCredentialKind,
    secret: String,
    replace_existing: bool,
) -> Result<BackupPreview, IpcError> {
    let bytes = chosen_bytes(&state)?;
    let preview = state.core()?.vault.restore_backup(bytes, kind, secret, replace_existing).await?;
    *state.chosen_backup.lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(preview)
}

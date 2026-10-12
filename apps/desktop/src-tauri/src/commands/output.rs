//! Saving one command's output to a file the user chooses (P-29).

use tauri::AppHandle;
use tyrminal_core::contracts::limits::MAX_SAVED_OUTPUT_LEN;
use tyrminal_core::contracts::{ErrorCode, IpcError};

/// Writes `text` (one command's output, chosen by the user in the terminal) to a file picked in
/// the system save dialog, every time: there is no default folder and nothing is saved without
/// the dialog. Test builds take the path from `TYRMINAL_E2E_OUTPUT_PATH` instead (WebDriver
/// cannot drive OS dialogs); release builds never read it. Returns the file name, or `None` when
/// the user cancelled.
#[tauri::command]
pub async fn terminal_output_save(app: AppHandle, text: String) -> Result<Option<String>, IpcError> {
    if text.len() > MAX_SAVED_OUTPUT_LEN {
        return Err(IpcError::new(ErrorCode::LimitExceeded, "That output is too large to save (32 MiB at most)."));
    }
    let io = || IpcError::new(ErrorCode::IoError, "The output could not be written there. Choose another location.");
    #[cfg(feature = "e2e")]
    let path = {
        let _ = &app;
        std::env::var_os("TYRMINAL_E2E_OUTPUT_PATH").map(std::path::PathBuf::from)
    };
    #[cfg(not(feature = "e2e"))]
    let path = {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app
            .dialog()
            .file()
            .add_filter("Text", &["txt"])
            .set_file_name(format!("command-output-{}.txt", crate::commands::backup::today()));
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
            .await
            .map_err(|_| io())?
            .map(|p| p.into_path().map_err(|_| io()))
            .transpose()?
    };
    let Some(path) = path else { return Ok(None) };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || crate::commands::backup::write_private(&target, text.as_bytes()))
        .await
        .map_err(|_| io())?
        .map_err(|_| io())?;
    Ok(Some(crate::commands::backup::file_name(&path)))
}

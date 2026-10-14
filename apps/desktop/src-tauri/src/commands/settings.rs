use tauri::{AppHandle, State};
use tyrminal_core::contracts::{HostSummary, IpcError, Preferences};

use crate::state::AppState;

#[tauri::command]
pub async fn prefs_get(state: State<'_, AppState>) -> Result<Preferences, IpcError> {
    Ok(state.core()?.preferences.get())
}

#[tauri::command]
pub async fn prefs_set(state: State<'_, AppState>, prefs: Preferences) -> Result<Preferences, IpcError> {
    let core = state.core()?;
    let saved = core.preferences.set(prefs)?;
    // The idle lock follows the saved choice at once (validated by the core's sanitizer).
    core.vault.set_idle_timeout(tyrminal_core::idle_lock_timeout(&saved));
    Ok(saved)
}

/// The application to use for editing remote files with `extension`, chosen in a native dialog
/// (test builds read `TYRMINAL_E2E_EDITOR_APP`). `None`: the dialog was cancelled.
#[tauri::command]
pub async fn editor_pick_app(
    app: AppHandle,
    state: State<'_, AppState>,
    extension: String,
) -> Result<Option<Preferences>, IpcError> {
    let store = std::sync::Arc::clone(&state.core()?.preferences);
    #[cfg(feature = "e2e")]
    let picked = {
        let _ = app;
        std::env::var_os("TYRMINAL_E2E_EDITOR_APP").map(std::path::PathBuf::from)
    };
    #[cfg(not(feature = "e2e"))]
    let picked = {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file();
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
            .await
            .map_err(|_| {
                IpcError::new(tyrminal_core::contracts::ErrorCode::IoError, "The file dialog could not be shown.")
            })?
            .and_then(|p| p.into_path().ok())
    };
    let Some(path) = picked else { return Ok(None) };
    store.add_editor_app(&extension, &path).map(Some)
}

/// Shells that can be chosen for local terminals (absolute paths of installed shells).
#[tauri::command]
pub async fn terminal_choices() -> Result<Vec<String>, IpcError> {
    Ok(tyrminal_core::available_shells().into_iter().filter_map(|p| p.to_str().map(str::to_owned)).collect())
}

#[tauri::command]
pub async fn host_recent(state: State<'_, AppState>) -> Result<Vec<HostSummary>, IpcError> {
    state.core()?.vault.recent_hosts().await
}

/// Opens a web link from terminal output in the OS browser, after the user confirmed the exact
/// destination in the UI. Only http/https without embedded credentials is accepted (validated
/// natively); the URL goes to the OS opener as a single argument, never through a shell.
#[tauri::command]
pub async fn link_open(url: String) -> Result<(), IpcError> {
    let url = tyrminal_core::validate_link(&url)?;
    // Test builds never launch a browser; the UI reports the validated URL either way.
    #[cfg(feature = "e2e")]
    {
        let _ = url;
        Ok(())
    }
    #[cfg(not(feature = "e2e"))]
    {
        open::that_detached(&url).map_err(|_| {
            IpcError::new(tyrminal_core::contracts::ErrorCode::IoError, "The link could not be handed to your browser.")
        })
    }
}

/// Static build and platform facts for Settings → About. Read-only; nothing about the user,
/// their hosts or their vault.
#[tauri::command]
pub async fn app_info() -> tyrminal_core::contracts::AppInfo {
    tyrminal_core::contracts::AppInfo {
        commit: env!("TYRMINAL_BUILD_COMMIT").to_owned(),
        build_date: env!("TYRMINAL_BUILD_DATE").to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        tauri_version: tauri::VERSION.to_owned(),
        webview_version: tauri::webview_version().ok(),
    }
}

/// Saves a diagnostic report to a file the user chooses (test builds read
/// `TYRMINAL_E2E_REPORT_PATH`). Nothing is sent anywhere. `None`: the dialog was cancelled.
#[tauri::command]
pub async fn diagnostics_report(
    app: AppHandle,
    state: State<'_, AppState>,
    entries: Vec<tyrminal_core::contracts::DiagnosticEntry>,
) -> Result<Option<String>, IpcError> {
    use tyrminal_core::contracts::{ErrorCode, VaultState};
    let core = state.core()?;
    let unlocked = core.vault.status().await.is_ok_and(|s| s.state == VaultState::Unlocked);
    let info = tyrminal_core::ReportInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        vault_unlocked: unlocked,
        sessions: core.sessions.count(),
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let text = tyrminal_core::diagnostic_report(&info, &entries, now)?;
    let io = || IpcError::new(ErrorCode::IoError, "The report could not be written there. Choose another location.");
    #[cfg(feature = "e2e")]
    let path = {
        let _ = &app;
        std::env::var_os("TYRMINAL_E2E_REPORT_PATH").map(std::path::PathBuf::from)
    };
    #[cfg(not(feature = "e2e"))]
    let path = {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app
            .dialog()
            .file()
            .add_filter("Text", &["txt"])
            .set_file_name(format!("tyrminal-diagnostics-{}.txt", crate::commands::backup::today()));
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

/// Serial ports this computer reports, for choosing a serial host's device.
#[tauri::command]
pub async fn serial_ports() -> Result<Vec<String>, IpcError> {
    Ok(tauri::async_runtime::spawn_blocking(tyrminal_core::serial_ports).await.unwrap_or_default())
}

/// Interface size: zooms the calling window's web view (CSS pixels grow, so layout, text and the
/// terminal scale together and the OS keeps rendering at full resolution). The interface works out
/// the factor from the preference or the window size; anything outside 0.5–2 is refused.
#[tauri::command]
pub async fn ui_zoom_set(window: tauri::WebviewWindow, scale: f64) -> Result<(), IpcError> {
    if !scale.is_finite() || !(0.5..=2.0).contains(&scale) {
        return Err(IpcError::new(
            tyrminal_core::contracts::ErrorCode::InvalidInput,
            "That interface size is not allowed.",
        ));
    }
    window.set_zoom(scale).map_err(|_| {
        IpcError::new(tyrminal_core::contracts::ErrorCode::IoError, "The interface size could not be changed.")
    })
}

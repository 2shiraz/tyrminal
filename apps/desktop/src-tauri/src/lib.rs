//! Tauri adapter for Tyrminal. This crate translates between the WebView and `tyrminal-core`;
//! the security rules live in the core, and the renderer reaches it only through the commands
//! registered below and permitted in `capabilities/`.

mod commands;
mod state;

use std::path::{Path, PathBuf};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tyrminal_core::Core;
use tyrminal_core::contracts::{ErrorCode, IpcError};

use crate::state::AppState;

/// Event carrying the non-secret vault status to the main window.
const VAULT_STATUS_EVENT: &str = "vault-status";

fn storage_error() -> IpcError {
    IpcError::new(ErrorCode::IoError, "Tyrminal could not open its data folder. No data was changed.")
}

/// Creates the application data directory with owner-only permissions and returns the vault path.
fn vault_path(data_dir: &Path) -> Result<PathBuf, IpcError> {
    std::fs::create_dir_all(data_dir).map_err(|_| storage_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| storage_error())?;
    }
    Ok(data_dir.join("vault.db"))
}

fn open_core(app: &tauri::App) -> Result<Core, IpcError> {
    // `TYRMINAL_DATA_DIR` lets tests and second-instance profiles use an isolated directory. It
    // names a location only; it never carries a secret.
    let data_dir = match std::env::var_os("TYRMINAL_DATA_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => app.path().app_data_dir().map_err(|_| storage_error())?,
    };
    Core::open(&vault_path(&data_dir)?)
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Test automation exists only in builds made with the non-default `e2e` feature. The server
    // binds to loopback on the port given in TAURI_WEBDRIVER_PORT (a random port per test run).
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    let app = builder
        .setup(|app| {
            let core = open_core(app);
            if let Ok(core) = &core {
                // Forward vault state changes (for example a lock) to the main window.
                let mut status = core.vault.subscribe();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    while status.changed().await.is_ok() {
                        let current = *status.borrow_and_update();
                        let _ = handle.emit_to("main", VAULT_STATUS_EVENT, current);
                    }
                });
            }
            app.manage(AppState::new(core));
            Ok(())
        })
        .on_window_event(|window, event| {
            // A window that goes away takes its sessions with it.
            if matches!(event, WindowEvent::Destroyed)
                && let Ok(core) = window.state::<AppState>().core()
            {
                core.sessions.close_all_for_owner(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::vault_status,
            commands::vault::vault_create,
            commands::vault::vault_unlock,
            commands::vault::vault_unlock_recovery,
            commands::vault::vault_lock,
            commands::vault::vault_change_passphrase,
            commands::vault::vault_rotate_recovery_key,
            commands::inventory::host_list,
            commands::inventory::host_save,
            commands::inventory::host_delete,
            commands::inventory::key_list,
            commands::inventory::key_import,
            commands::inventory::key_generate,
            commands::inventory::key_delete,
            commands::inventory::known_host_list,
            commands::inventory::known_host_remove,
            commands::sessions::session_open_ssh,
            commands::sessions::session_open_local,
            commands::sessions::session_write,
            commands::sessions::session_resize,
            commands::sessions::session_ack,
            commands::sessions::session_close,
            commands::sessions::session_trust_answer,
            commands::sessions::session_auth_answer,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|handle, event| {
            // Lock on exit so keys are dropped and sessions end before the process does.
            if let RunEvent::ExitRequested { .. } = event
                && let Ok(core) = handle.state::<AppState>().core()
            {
                let vault = std::sync::Arc::clone(&core.vault);
                tauri::async_runtime::block_on(async move { vault.lock().await });
            }
        }),
        Err(error) => {
            // Startup failure before any window exists: there is nowhere else to report it.
            #[allow(clippy::print_stderr)]
            {
                eprintln!("Tyrminal failed to start: {error}");
            }
            std::process::exit(1);
        }
    }
}

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
/// Inactivity after which the vault locks itself.
const IDLE_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn storage_error() -> IpcError {
    IpcError::new(ErrorCode::IoError, "Tyrminal could not open its data folder. No data was changed.")
}

/// Creates the application data directory with owner-only permissions and returns the vault path.
fn vault_path(data_dir: &Path) -> Result<PathBuf, IpcError> {
    std::fs::create_dir_all(data_dir).map_err(|_| storage_error())?;
    // Owner-only before anything is written (Unix 0700; Windows a user+SYSTEM DACL).
    tyrminal_core::restrict_to_owner(data_dir).map_err(|_| storage_error())?;
    Ok(data_dir.join("vault.db"))
}

/// One running instance per data directory: an exclusive lock on a file inside it, held for the
/// life of the process (the OS releases it if the process dies). A second instance would keep
/// its own copy of the vault state and race the first on every write, so it refuses to start.
fn lock_instance(data_dir: &Path) -> Result<std::fs::File, IpcError> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("instance.lock"))
        .map_err(|_| storage_error())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(IpcError::new(
            ErrorCode::InUse,
            "Tyrminal is already open. Switch to the open window; this one can be closed.",
        )),
        Err(std::fs::TryLockError::Error(_)) => Err(storage_error()),
    }
}

fn data_dir(app: &tauri::App) -> Result<PathBuf, IpcError> {
    // `TYRMINAL_DATA_DIR` lets tests and second-instance profiles use an isolated directory. It
    // names a location only; it never carries a secret.
    match std::env::var_os("TYRMINAL_DATA_DIR") {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => app.path().app_data_dir().map_err(|_| storage_error()),
    }
}

fn open_core(app: &tauri::App) -> Result<(Core, std::fs::File), IpcError> {
    let data_dir = data_dir(app)?;
    let path = vault_path(&data_dir)?;
    let lock = lock_instance(&data_dir)?;
    // Quick-unlock material lives in the OS secret store under this application's own service
    // name. Test builds use a separate name so they never touch a real installation's items.
    let service = if cfg!(feature = "e2e") { "app.tyrminal.desktop.e2e" } else { "app.tyrminal.desktop" };
    let store = std::sync::Arc::new(tyrminal_core::OsSecretStore::new(service));
    Ok((Core::open_with_store(&path, store)?, lock))
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Test automation exists only in builds made with the non-default `e2e` feature. The server
    // binds to loopback on the port given in TAURI_WEBDRIVER_PORT (a random port per test run).
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    // Native file dialogs for backups, used from Rust only (no renderer permission).
    let builder = builder.plugin(tauri_plugin_dialog::init());

    let app = builder
        .setup(|app| {
            let opened = open_core(app);
            let (core, instance_lock) = match opened {
                Ok((core, lock)) => (Ok(core), Some(lock)),
                Err(error) => (Err(error), None),
            };
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
                // The vault locks when the OS locks the screen (where the platform reports it).
                let vault = std::sync::Arc::clone(&core.vault);
                let _ = tyrminal_core::watch_screen_lock(std::sync::Arc::new(move || {
                    let vault = std::sync::Arc::clone(&vault);
                    tauri::async_runtime::spawn(async move {
                        let _ = vault.lock().await;
                    });
                }));
                // Idle lock, enforced natively (BUILD_SPEC §1.3: five minutes by default).
                tauri::async_runtime::spawn(std::sync::Arc::clone(&core.vault).run_idle_lock(IDLE_LOCK_TIMEOUT));
            }
            // Local copies of remote files being edited never outlive the process that made them:
            // anything left by an earlier run (a crash) is removed before the window opens.
            let edit_root = data_dir(app).map(|d| d.join("edits")).unwrap_or_default();
            if instance_lock.is_some() && !edit_root.as_os_str().is_empty() {
                let _ = std::fs::remove_dir_all(&edit_root);
            }
            app.manage(AppState::new(core, instance_lock, edit_root));
            Ok(())
        })
        .on_window_event(|window, event| {
            // A window that goes away takes its sessions with it.
            if matches!(event, WindowEvent::Destroyed)
                && let Ok(core) = window.state::<AppState>().core()
            {
                core.sessions.close_all_for_owner(window.label());
                // agent B: tunnels and history
                core.sessions.stop_tunnels_for_owner(window.label());
                core.discovery.forget(window.label());
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
            commands::vault::vault_activity,
            commands::vault::vault_quick_unlock_status,
            commands::vault::vault_quick_unlock_enable,
            commands::vault::vault_quick_unlock_disable,
            commands::vault::vault_unlock_device,
            commands::inventory::host_list,
            commands::inventory::host_save,
            commands::inventory::host_delete,
            commands::inventory::key_list,
            commands::inventory::key_import,
            commands::inventory::key_generate,
            commands::inventory::key_delete,
            commands::inventory::key_deploy_preview,
            commands::inventory::key_deploy,
            commands::inventory::known_host_list,
            commands::inventory::known_host_remove,
            commands::inventory::group_list,
            commands::inventory::group_save,
            commands::inventory::group_delete,
            commands::inventory::host_search,
            commands::inventory::host_duplicate,
            commands::inventory::host_bulk,
            commands::inventory::import_preview,
            commands::inventory::import_hosts,
            commands::sessions::session_open_ssh,
            commands::sessions::session_open_local,
            commands::sessions::session_open_files,
            commands::sessions::session_write,
            commands::sessions::session_resize,
            commands::sessions::session_ack,
            commands::sessions::session_close,
            commands::sessions::session_trust_answer,
            commands::sessions::session_auth_answer,
            commands::sessions::session_handoff_offer,
            commands::sessions::session_attach,
            commands::sessions::session_diagnostics,
            commands::files::files_pick_upload,
            commands::files::files_pick_folder,
            commands::files::files_pick_upload_folder,
            commands::files::files_list,
            commands::files::files_mkdir,
            commands::files::files_rename,
            commands::files::files_remove,
            commands::files::files_chmod,
            commands::files::files_upload,
            commands::files::files_download,
            commands::files::files_cancel,
            commands::files::files_upload_begin,
            commands::files::files_upload_chunk,
            commands::files::files_upload_finish,
            commands::files::files_upload_abort,
            commands::files::files_local_list,
            commands::files::files_local_mkdir,
            commands::files::files_local_rename,
            commands::files::files_local_remove,
            commands::files::files_local_chmod,
            commands::files::files_copy,
            commands::files::files_edit_open,
            commands::files::files_edit_status,
            commands::files::files_edit_save,
            commands::files::files_edit_close,
            commands::snippets::snippet_list,
            commands::snippets::snippet_save,
            commands::snippets::snippet_delete,
            commands::snippets::snippet_send,
            commands::settings::prefs_get,
            commands::settings::prefs_set,
            commands::settings::terminal_choices,
            commands::settings::editor_pick_app,
            commands::settings::diagnostics_report,
            commands::output::terminal_output_save,
            commands::settings::serial_ports,
            commands::settings::host_recent,
            commands::settings::link_open,
            commands::settings::app_info,
            commands::discovery::discovery_networks,
            commands::discovery::discovery_start,
            commands::discovery::discovery_status,
            commands::discovery::discovery_stop,
            commands::backup::backup_export,
            commands::backup::backup_choose,
            commands::backup::backup_preview,
            commands::backup::backup_restore,
            // agent B: tunnels and history
            commands::tunnels::tunnel_list,
            commands::tunnels::tunnel_save,
            commands::tunnels::tunnel_duplicate,
            commands::tunnels::tunnel_delete,
            commands::tunnels::tunnel_start,
            commands::tunnels::tunnel_stop,
            commands::tunnels::tunnel_active,
            commands::tunnels::tunnel_clear_ended,
            commands::tunnels::host_connection_get,
            commands::tunnels::host_connection_set,
            commands::tunnels::host_chain,
            // agent D: inventory and snippets
            commands::inventory::host_appearance_list,
            commands::inventory::host_set_os,
            commands::inventory::import_known_hosts_preview,
            commands::inventory::key_certificate_list,
            commands::inventory::key_certificate_attach,
            commands::inventory::key_certificate_remove,
            commands::snippets::snippet_exec,
            commands::snippets::snippet_exec_cancel,
            commands::snippets::execution_target_list,
            commands::snippets::execution_target_save,
            commands::snippets::execution_target_delete,
            commands::snippets::snippet_move,
            commands::snippets::snippet_folder_rename,
            commands::inventory::key_import_pick_file,
            commands::inventory::key_import_picked,
            commands::inventory::key_import_pick_clear,
            commands::inventory::known_hosts_import_preview,
            commands::inventory::known_hosts_import,
            commands::snippets::prompt_marks_status,
            commands::snippets::prompt_marks_install,
            commands::snippets::prompt_marks_remove,
            commands::inventory::identity_list,
            commands::inventory::identity_save,
            commands::inventory::identity_delete,
            commands::inventory::identity_assignments,
            commands::inventory::identity_assign,
            commands::inventory::env_get,
            commands::inventory::env_set,
            commands::inventory::env_effective,
            commands::inventory::startup_get,
            commands::inventory::startup_set,
            commands::inventory::startup_effective,
            commands::inventory::group_defaults_get,
            commands::inventory::group_defaults_set,
            // command history
            commands::command_history::history_settings_get,
            commands::command_history::history_settings_set,
            commands::command_history::history_add,
            commands::command_history::history_suggest,
            commands::command_history::history_list,
            commands::command_history::history_delete,
            commands::command_history::history_clear,
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

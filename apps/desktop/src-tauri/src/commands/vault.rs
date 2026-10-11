use tauri::State;
use tyrminal_core::contracts::{IpcError, RecoveryKeyIssued, VaultStatus};

use crate::state::AppState;

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, IpcError> {
    state.core()?.vault.status().await
}

#[tauri::command]
pub async fn vault_create(state: State<'_, AppState>, passphrase: String) -> Result<RecoveryKeyIssued, IpcError> {
    state.core()?.vault.create(passphrase).await
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, passphrase: String) -> Result<(), IpcError> {
    state.core()?.vault.unlock_with_passphrase(passphrase).await
}

#[tauri::command]
pub async fn vault_unlock_recovery(state: State<'_, AppState>, recovery_key: String) -> Result<(), IpcError> {
    state.core()?.vault.unlock_with_recovery_key(recovery_key).await
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<(), IpcError> {
    state.core()?.vault.lock().await;
    Ok(())
}

#[tauri::command]
pub async fn vault_change_passphrase(state: State<'_, AppState>, current: String, new: String) -> Result<(), IpcError> {
    state.core()?.vault.change_passphrase(current, new).await
}

#[tauri::command]
pub async fn vault_rotate_recovery_key(
    state: State<'_, AppState>,
    passphrase: String,
) -> Result<RecoveryKeyIssued, IpcError> {
    state.core()?.vault.rotate_recovery_key(passphrase).await
}

/// The renderer saw keyboard or pointer input. Postpones the core's idle lock; returns nothing.
#[tauri::command]
pub async fn vault_activity(state: State<'_, AppState>) -> Result<(), IpcError> {
    state.core()?.vault.note_activity();
    Ok(())
}

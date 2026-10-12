//! Compromised-password check (SEC-11). This build has no range source that reaches the network
//! (an HTTPS client in the release graph waits on an owner decision), so the status says the
//! check is unavailable and a run is refused; the settings and their validation still work.

use tauri::State;
use tyrminal_core::contracts::{IpcError, PasswordCheckReport, PasswordCheckStatus};
use tyrminal_core::password_check::NoRangeSource;

use crate::state::AppState;

#[tauri::command]
pub async fn password_check_status(state: State<'_, AppState>) -> Result<PasswordCheckStatus, IpcError> {
    state.core()?.password_check_status(&NoRangeSource).await
}

/// Runs the check on an explicit request. Refused unless the user turned it on.
#[tauri::command]
pub async fn password_check_run(state: State<'_, AppState>) -> Result<PasswordCheckReport, IpcError> {
    state.core()?.check_stored_passwords(&NoRangeSource).await
}

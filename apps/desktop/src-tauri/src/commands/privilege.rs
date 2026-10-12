//! Privilege-prompt assistance (KEY-18).

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{IpcError, SessionIdentity};

use crate::state::AppState;

/// Which identity's password the session could insert (for the confirmation).
#[tauri::command]
pub async fn session_identity(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionIdentity>, IpcError> {
    state.core()?.sessions.session_identity(window.label(), &session_id).await
}

/// Types the identity's password into the session. Only called after an explicit confirmation;
/// the password is read and written inside the core and never returned.
#[tauri::command]
pub async fn session_insert_identity_password(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    identity_id: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.insert_identity_password(window.label(), &session_id, &identity_id).await
}

//! Reusable identities (KEY-15..18).

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{IdentityInput, IdentitySummary, IpcError, SessionIdentity};

use crate::state::AppState;

#[tauri::command]
pub async fn identity_list(state: State<'_, AppState>) -> Result<Vec<IdentitySummary>, IpcError> {
    state.core()?.vault.list_identities().await
}

#[tauri::command]
pub async fn identity_save(state: State<'_, AppState>, identity: IdentityInput) -> Result<IdentitySummary, IpcError> {
    state.core()?.vault.save_identity(identity).await
}

#[tauri::command]
pub async fn identity_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_identity(&id).await
}

/// Which identity's password the session could insert (for the button's label).
#[tauri::command]
pub async fn session_identity(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionIdentity>, IpcError> {
    state.core()?.sessions.session_identity(window.label(), &session_id).await
}

/// Types the identity's password into the session. Only called from an explicit click or
/// shortcut; the password is read and written inside the core and never returned.
#[tauri::command]
pub async fn session_insert_identity_password(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    identity_id: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.insert_identity_password(window.label(), &session_id, &identity_id).await
}

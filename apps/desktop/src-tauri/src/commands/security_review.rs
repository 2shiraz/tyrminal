//! Security review (P-27): read-only findings over the unlocked vault. No network, no changes.

use tauri::State;
use tyrminal_core::contracts::{IpcError, SecurityReview};

use crate::state::AppState;

#[tauri::command]
pub async fn security_review(state: State<'_, AppState>) -> Result<SecurityReview, IpcError> {
    state.core()?.vault.security_review_now().await
}

//! tmux and screen session awareness (P-31): the sessions on the server behind an SSH session,
//! listed with a fixed command on a separate exec channel (see `tyrminal_core`). Nothing is typed
//! into the shell here; an attach command is typed by the renderer only after the user chooses it.

use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{IpcError, MultiplexerList};

use crate::state::AppState;

/// The tmux and screen sessions for a session this window owns.
#[tauri::command]
pub async fn multiplexer_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MultiplexerList, IpcError> {
    state.core()?.sessions.multiplexer_sessions(window.label(), &session_id).await
}

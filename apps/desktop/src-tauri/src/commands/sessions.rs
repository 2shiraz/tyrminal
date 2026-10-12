use std::sync::Arc;

use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{State, WebviewWindow};
use tyrminal_core::SessionSink;
use tyrminal_core::contracts::{ErrorCode, IpcError, SessionEvent, SessionOpened, TrustDecision};

use crate::state::AppState;

/// Delivers one session's output and events to the window that opened it, over channels that
/// exist only for that invocation. Nothing about a session is ever emitted as a global event.
struct ChannelSink {
    output: Channel<InvokeResponseBody>,
    events: Channel<SessionEvent>,
}

impl SessionSink for ChannelSink {
    fn output(&self, data: Vec<u8>) -> bool {
        self.output.send(InvokeResponseBody::Raw(data)).is_ok()
    }

    fn event(&self, event: SessionEvent) -> bool {
        self.events.send(event).is_ok()
    }
}

#[tauri::command]
pub async fn session_open_ssh(
    window: WebviewWindow,
    state: State<'_, AppState>,
    host_id: String,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
    events: Channel<SessionEvent>,
) -> Result<SessionOpened, IpcError> {
    let sink = Arc::new(ChannelSink { output, events });
    state.core()?.sessions.open_ssh(window.label(), &host_id, cols, rows, sink).await
}

#[tauri::command]
pub async fn session_open_local(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    start_in: Option<String>,
    output: Channel<InvokeResponseBody>,
    events: Channel<SessionEvent>,
) -> Result<SessionOpened, IpcError> {
    let sink = Arc::new(ChannelSink { output, events });
    let core = state.core()?;
    let shell = core.preferences.get().local_shell;
    core.sessions.open_local_in(window.label(), cols, rows, shell, start_in, sink).await
}

/// Terminal input. The body is the raw bytes (no JSON array of numbers); the session id travels
/// in a header because a raw body has no other fields.
#[tauri::command]
pub async fn session_write(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), IpcError> {
    let bad = || IpcError::new(ErrorCode::InvalidInput, "The terminal input was not in the expected form.");
    let session_id = request.headers().get("x-session").and_then(|v| v.to_str().ok()).ok_or_else(bad)?.to_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(bad());
    };
    state.core()?.sessions.write(window.label(), &session_id, bytes.clone()).await
}

#[tauri::command]
pub async fn session_resize(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    state.core()?.sessions.resize(window.label(), &session_id, cols, rows).await
}

#[tauri::command]
pub async fn session_ack(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    bytes: u32,
) -> Result<(), IpcError> {
    state.core()?.sessions.ack(window.label(), &session_id, bytes).await
}

#[tauri::command]
pub async fn session_close(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), IpcError> {
    state.core()?.sessions.close(window.label(), &session_id)
}

#[tauri::command]
pub async fn session_trust_answer(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    prompt_id: String,
    decision: TrustDecision,
) -> Result<(), IpcError> {
    state.core()?.sessions.answer_trust(window.label(), &session_id, &prompt_id, decision)
}

/// `secret: null` dismisses the prompt. The secret is carried in this request only.
#[tauri::command]
pub async fn session_auth_answer(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    prompt_id: String,
    secret: Option<String>,
) -> Result<(), IpcError> {
    state.core()?.sessions.answer_auth(window.label(), &session_id, &prompt_id, secret)
}

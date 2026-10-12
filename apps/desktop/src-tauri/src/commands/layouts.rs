//! Named layout templates (agent C). Saving is always an explicit user action; restoring is done
//! by the renderer from the listed template and connects nothing until the user asks.

use tauri::State;
use tyrminal_core::contracts::{IpcError, LayoutTemplateInput, LayoutTemplateSummary};

use crate::state::AppState;

#[tauri::command]
pub async fn layout_list(state: State<'_, AppState>) -> Result<Vec<LayoutTemplateSummary>, IpcError> {
    state.core()?.vault.list_layouts().await
}

#[tauri::command]
pub async fn layout_save(
    state: State<'_, AppState>,
    layout: LayoutTemplateInput,
) -> Result<LayoutTemplateSummary, IpcError> {
    state.core()?.vault.save_layout(layout).await
}

#[tauri::command]
pub async fn layout_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_layout(&id).await
}

// ---------- detaching a tab into its own window (TRM-02) ----------

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tyrminal_core::contracts::{DetachTabInput, DetachedPane, DetachedTab, ErrorCode};

/// Prefix of detached windows; `capabilities/detached.json` applies to exactly these labels.
pub const DETACHED_PREFIX: &str = "detached-";
/// A payload not collected by its window within this time is dropped (its tokens expire sooner).
const PAYLOAD_TTL: Duration = Duration::from_secs(60);

/// What each new window collects once: the tab's arrangement and its handoff tokens. Tokens never
/// go back to the window that offered them.
static PENDING: LazyLock<Mutex<HashMap<String, DetachedTab>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn pending() -> std::sync::MutexGuard<'static, HashMap<String, DetachedTab>> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

/// Moves a tab's live sessions into a new window. Only the main window may detach. The new window
/// is created first (a handoff can only be offered to an open window), then each session is
/// offered to it; if any offer fails, the window is closed and every session stays here.
#[tauri::command]
pub async fn window_detach(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    tab: DetachTabInput,
) -> Result<String, IpcError> {
    if window.label() != "main" {
        return Err(IpcError::new(ErrorCode::AccessDenied, "Only the main window can move tabs to a new window."));
    }
    tyrminal_core::validate_detach(&tab)?;
    let core = state.core()?;
    let mut id = [0u8; 8];
    getrandom::fill(&mut id).map_err(|_| IpcError::new(ErrorCode::Internal, "Something went wrong."))?;
    let label = format!("{DETACHED_PREFIX}{}", id.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let title = tab.title.clone().unwrap_or_else(|| tab.panes[tab.focused as usize].label.clone());
    let created = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("{title} — Tyrminal"))
        .inner_size(960.0, 640.0)
        .min_inner_size(480.0, 320.0)
        .disable_drag_drop_handler()
        .build()
        .map_err(|_| IpcError::new(ErrorCode::Internal, "A new window could not be opened."))?;
    let mut panes = Vec::with_capacity(tab.panes.len());
    for pane in &tab.panes {
        match core.sessions.offer_handoff(window.label(), &pane.session_id, &label) {
            Ok(token) => panes.push(DetachedPane {
                token,
                label: pane.label.clone(),
                identity: pane.identity.clone(),
                target: pane.target.clone(),
            }),
            Err(error) => {
                // Offers already made lapse when their target window closes.
                let _ = created.destroy();
                return Err(error);
            }
        }
    }
    pending().insert(label.clone(), DetachedTab { title: tab.title, layout: tab.layout, panes, focused: tab.focused });
    let expiring = label.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PAYLOAD_TTL).await;
        pending().remove(&expiring);
    });
    Ok(label)
}

/// The tab this detached window was opened for, once. Any other caller gets nothing.
#[tauri::command]
pub async fn window_detach_take(window: WebviewWindow) -> Result<DetachedTab, IpcError> {
    if !window.label().starts_with(DETACHED_PREFIX) {
        return Err(IpcError::new(ErrorCode::AccessDenied, "This window has no tab to take."));
    }
    // The window is created before its sessions are offered to it, so it can ask a moment early.
    for _ in 0..50 {
        if let Some(tab) = pending().remove(window.label()) {
            return Ok(tab);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(IpcError::new(ErrorCode::NotFound, "The tab for this window is no longer available."))
}

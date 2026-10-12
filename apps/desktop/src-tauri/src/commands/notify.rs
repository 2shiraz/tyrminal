//! Command-finished notifications (P-23). The renderer reports which tab finished a command,
//! with its exit status and duration; the text is built by the core from those fields only and
//! shown through the notification plugin from Rust. A window gets at most one notification every
//! few seconds, so output that fakes command marks cannot flood the desktop.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, WebviewWindow};
use tyrminal_core::contracts::{CommandNotice, IpcError};

const MIN_GAP: Duration = Duration::from_secs(3);

fn last_shown() -> &'static Mutex<HashMap<String, Instant>> {
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn notify_command_finished(
    app: AppHandle,
    window: WebviewWindow,
    tab_title: String,
    exit_status: Option<i32>,
    duration_ms: u64,
) -> Result<CommandNotice, IpcError> {
    let (title, body) = tyrminal_core::command_finished_notice(&tab_title, exit_status, duration_ms)?;
    let now = Instant::now();
    let allowed = {
        let mut last = last_shown().lock().unwrap_or_else(|p| p.into_inner());
        let label = window.label().to_owned();
        let ok = last.get(&label).is_none_or(|t| now.duration_since(*t) >= MIN_GAP);
        if ok {
            last.insert(label, now);
        }
        ok
    };
    // Test builds never post to the desktop; the UI still marks the tab and announces it.
    #[cfg(feature = "e2e")]
    let shown = {
        let _ = (&app, allowed);
        false
    };
    #[cfg(not(feature = "e2e"))]
    let shown = allowed && {
        use tauri_plugin_notification::NotificationExt;
        app.notification().builder().title(&title).body(&body).show().is_ok()
    };
    Ok(CommandNotice { title, body, shown })
}

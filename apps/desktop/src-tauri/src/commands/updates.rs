//! In-app updates (UX-05, ADR 0013), from Rust only: the renderer has no updater permission and
//! supplies no URL, key or file.
//!
//! The updater exists only in release builds made with the update signing key: the release
//! workflow builds them with the `updater` cargo feature (the only way an HTTP client enters the
//! binary) and adds the `plugins.updater` configuration (the public key, the feed URL and
//! `requireSignedVersion`). Development and unsigned builds have neither, so they have no updater,
//! no network client and never check; their commands report that. Checking is user-triggered, or daily when the user turned automatic
//! checks on (off by default). Installing is always the user's choice.
//!
//! What the plugin verifies: every artifact against the built-in minisign public key, and (with
//! `requireSignedVersion`) that the signed version is the one the manifest announces, so a
//! replayed or edited manifest cannot pair a newer version number with an older artifact. Only a
//! version greater than the running one is offered (INV-14: no silent downgrade).

use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
#[cfg(feature = "updater")]
use std::sync::atomic::Ordering;
#[cfg(feature = "updater")]
use std::time::Duration;
use std::time::Instant;

use tauri::{AppHandle, State};
#[cfg(feature = "updater")]
use tauri::{Emitter, Manager, Runtime};
#[cfg(feature = "updater")]
use tauri_plugin_updater::{Update, UpdaterExt};
#[cfg(feature = "updater")]
use tyrminal_core::contracts::UpdateProgress;
use tyrminal_core::contracts::{ErrorCode, IpcError, UpdateOffer, UpdateStatus};

#[cfg(feature = "updater")]
use crate::state::AppState;

/// Sent to the main window when an automatic check finds a newer release.
#[cfg(feature = "updater")]
pub const UPDATE_AVAILABLE_EVENT: &str = "update-available";
/// Download progress while an update installs.
#[cfg(feature = "updater")]
pub const UPDATE_PROGRESS_EVENT: &str = "update-progress";

/// How often an automatic check may run, and how long after start the first one waits.
#[cfg(feature = "updater")]
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
#[cfg(feature = "updater")]
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(60);
#[cfg(feature = "updater")]
const WAKE_EVERY: Duration = Duration::from_secs(60 * 60);
/// Release notes are shown as plain text, at most this many characters.
const MAX_NOTES: usize = 2000;

/// Whether this build has the updater, and the release the last check found.
#[cfg_attr(not(feature = "updater"), allow(dead_code))] // without the feature only `enabled` is read
pub struct Updates {
    enabled: bool,
    #[cfg(feature = "updater")]
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
    last_check: Mutex<Option<Instant>>,
}

impl Updates {
    /// `configured`: the build's configuration carries the updater. Without the `updater` feature
    /// there is no updater whatever the configuration says.
    pub fn new(configured: bool) -> Self {
        Self {
            enabled: configured && cfg!(feature = "updater"),
            #[cfg(feature = "updater")]
            pending: Mutex::new(None),
            installing: AtomicBool::new(false),
            last_check: Mutex::new(None),
        }
    }
}

/// True when the build's configuration carries the updater (release builds with the signing key).
pub fn configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .is_some_and(|c| c.get("pubkey").and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty()))
}

fn unavailable() -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, "This build has no updater. Download new versions from the releases page.")
}

#[cfg(feature = "updater")]
fn failed(error: &tauri_plugin_updater::Error) -> IpcError {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(_) | E::Network(_) => {
            IpcError::new(ErrorCode::Unreachable, "Could not reach the update server. Try again later.")
        }
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::MissingSignedVersion
        | E::SignedVersionMismatch { .. } => IpcError::new(
            ErrorCode::AccessDenied,
            "The update did not pass signature verification. Nothing was installed.",
        ),
        _ => IpcError::new(ErrorCode::Internal, "The update could not be checked or installed. Nothing was changed."),
    }
}

/// Plain text, shortened: release notes are shown, never rendered.
#[cfg_attr(not(feature = "updater"), allow(dead_code))]
fn plain_notes(body: Option<&str>) -> Option<String> {
    let text: String = body?.chars().filter(|c| !c.is_control() || *c == '\n').take(MAX_NOTES).collect();
    let text = text.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(feature = "updater")]
fn offer(update: &Update) -> UpdateOffer {
    UpdateOffer {
        version: update.version.clone(),
        date: update.date.map(|d| d.to_string()),
        notes: plain_notes(update.body.as_deref()),
    }
}

#[cfg(feature = "updater")]
async fn check_now<R: Runtime>(app: &AppHandle<R>, updates: &Updates) -> Result<Option<UpdateOffer>, IpcError> {
    if !updates.enabled {
        return Err(unavailable());
    }
    *updates.last_check.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    let updater = app.updater().map_err(|e| failed(&e))?;
    let found = updater.check().await.map_err(|e| failed(&e))?;
    let shown = found.as_ref().map(offer);
    *updates.pending.lock().unwrap_or_else(|p| p.into_inner()) = found;
    Ok(shown)
}

#[tauri::command]
pub async fn update_status(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateStatus, IpcError> {
    Ok(UpdateStatus { available_in_build: updates.enabled, current_version: app.package_info().version.to_string() })
}

/// Asks the release feed for a newer version (the user pressed Check now).
#[cfg(feature = "updater")]
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> Result<Option<UpdateOffer>, IpcError> {
    check_now(&app, &updates).await
}

/// A build without the updater has nothing to check.
#[cfg(not(feature = "updater"))]
#[tauri::command]
pub async fn update_check(_app: AppHandle, _updates: State<'_, Updates>) -> Result<Option<UpdateOffer>, IpcError> {
    Err(unavailable())
}

/// A build without the updater has nothing to install.
#[cfg(not(feature = "updater"))]
#[tauri::command]
pub async fn update_install(_app: AppHandle, _updates: State<'_, Updates>) -> Result<(), IpcError> {
    Err(unavailable())
}

/// Downloads the release the last check found, verifies it, installs it and restarts. The vault is
/// locked first, which ends open sessions; the user was told so before choosing to install.
#[cfg(feature = "updater")]
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, Updates>,
) -> Result<(), IpcError> {
    if !updates.enabled {
        return Err(unavailable());
    }
    if updates.installing.swap(true, Ordering::AcqRel) {
        return Err(IpcError::new(ErrorCode::InUse, "The update is already being installed."));
    }
    let update = updates.pending.lock().unwrap_or_else(|p| p.into_inner()).take();
    let Some(update) = update else {
        updates.installing.store(false, Ordering::Release);
        return Err(IpcError::new(ErrorCode::NotFound, "Check for updates first."));
    };
    let mut downloaded: u64 = 0;
    let progress = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit_to("main", UPDATE_PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await;
    if let Err(error) = result {
        updates.installing.store(false, Ordering::Release);
        return Err(failed(&error));
    }
    if let Ok(core) = state.core() {
        core.vault.lock().await;
    }
    app.restart()
}

/// The daily check, for as long as the app runs: only when this build has the updater and the user
/// turned automatic checks on. A newer release is announced to the main window; nothing installs.
#[cfg(feature = "updater")]
pub fn spawn_automatic_checks<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            let updates = app.state::<Updates>();
            let wanted = app.state::<AppState>().core().map(|c| c.preferences.get().check_updates).unwrap_or(false);
            let due = updates
                .last_check
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_none_or(|at| at.elapsed() >= CHECK_EVERY);
            if updates.enabled
                && wanted
                && due
                && !updates.installing.load(Ordering::Acquire)
                && let Ok(Some(found)) = check_now(&app, &updates).await
            {
                let _ = app.emit_to("main", UPDATE_AVAILABLE_EVENT, found);
            }
            tokio::time::sleep(WAKE_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_plain_shortened_text() {
        assert_eq!(plain_notes(None), None);
        assert_eq!(plain_notes(Some("  \n ")), None);
        assert_eq!(plain_notes(Some("Fixes\n- one\u{1b}[31m")).as_deref(), Some("Fixes\n- one[31m"));
        assert_eq!(plain_notes(Some(&"x".repeat(5000))).map(|n| n.chars().count()), Some(MAX_NOTES));
    }

    #[test]
    fn only_a_configuration_with_a_public_key_has_the_updater() {
        let with = |plugins: serde_json::Value| {
            let mut config: tauri::Config =
                serde_json::from_value(serde_json::json!({ "identifier": "app.test" })).unwrap();
            config.plugins = serde_json::from_value(plugins).unwrap();
            configured(&config)
        };
        assert!(!with(serde_json::json!({})), "development builds have no updater");
        assert!(!with(serde_json::json!({ "updater": { "pubkey": "  ", "endpoints": [] } })));
        assert!(with(serde_json::json!({ "updater": { "pubkey": "dW50cnVzdGVk", "endpoints": [] } })));
    }
}

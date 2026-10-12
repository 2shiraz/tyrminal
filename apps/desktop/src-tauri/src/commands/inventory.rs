use tauri::{State, WebviewWindow};
use tyrminal_core::contracts::{
    BulkHostChange, GroupInput, GroupSummary, HostInput, HostSummary, ImportFormat, ImportHost, ImportPreview,
    IpcError, KeyDeployPreview, KeyImportInput, KeySummary, KnownHostSummary,
};

use crate::state::AppState;

#[tauri::command]
pub async fn host_list(state: State<'_, AppState>) -> Result<Vec<HostSummary>, IpcError> {
    state.core()?.vault.list_hosts().await
}

#[tauri::command]
pub async fn host_save(state: State<'_, AppState>, host: HostInput) -> Result<HostSummary, IpcError> {
    state.core()?.vault.save_host(host).await
}

#[tauri::command]
pub async fn host_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_host(&id).await
}

#[tauri::command]
pub async fn key_list(state: State<'_, AppState>) -> Result<Vec<KeySummary>, IpcError> {
    state.core()?.vault.list_keys().await
}

#[tauri::command]
pub async fn key_import(state: State<'_, AppState>, key: KeyImportInput) -> Result<KeySummary, IpcError> {
    state.core()?.vault.import_key(key).await
}

#[tauri::command]
pub async fn key_generate(
    state: State<'_, AppState>,
    label: String,
    kind: Option<tyrminal_core::contracts::KeyKind>,
) -> Result<KeySummary, IpcError> {
    // agent D: the key type is optional; without it the key is Ed25519, as before.
    match kind {
        Some(kind) => state.core()?.vault.generate_key_of(&label, kind).await,
        None => state.core()?.vault.generate_key(&label).await,
    }
}

#[tauri::command]
pub async fn key_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_key(&id).await
}

#[tauri::command]
pub async fn known_host_list(state: State<'_, AppState>) -> Result<Vec<KnownHostSummary>, IpcError> {
    state.core()?.vault.list_known_hosts().await
}

#[tauri::command]
pub async fn known_host_remove(state: State<'_, AppState>, id: String, reason: String) -> Result<(), IpcError> {
    state.core()?.vault.remove_known_host(&id, &reason).await
}

#[tauri::command]
pub async fn host_search(state: State<'_, AppState>, query: String) -> Result<Vec<HostSummary>, IpcError> {
    state.core()?.vault.search_hosts(&query).await
}

#[tauri::command]
pub async fn host_duplicate(state: State<'_, AppState>, id: String) -> Result<HostSummary, IpcError> {
    state.core()?.vault.duplicate_host(&id).await
}

#[tauri::command]
pub async fn host_bulk(state: State<'_, AppState>, ids: Vec<String>, change: BulkHostChange) -> Result<u32, IpcError> {
    state.core()?.vault.bulk_update_hosts(&ids, change).await
}

#[tauri::command]
pub async fn group_list(state: State<'_, AppState>) -> Result<Vec<GroupSummary>, IpcError> {
    state.core()?.vault.list_groups().await
}

#[tauri::command]
pub async fn group_save(state: State<'_, AppState>, group: GroupInput) -> Result<GroupSummary, IpcError> {
    state.core()?.vault.save_group(group).await
}

#[tauri::command]
pub async fn group_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_group(&id).await
}

/// `text` is the content of a file the user picked in the renderer (read as data, at most
/// 1 MiB, checked again in the core).
#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    format: ImportFormat,
    text: String,
) -> Result<ImportPreview, IpcError> {
    state.core()?.vault.import_preview(format, &text).await
}

#[tauri::command]
pub async fn import_hosts(
    state: State<'_, AppState>,
    hosts: Vec<ImportHost>,
    into_group: Option<String>,
) -> Result<u32, IpcError> {
    state.core()?.vault.import_hosts(hosts, into_group).await
}

/// Reads the server's authorized keys over a connected SSH session this window owns and reports
/// what installing the key would change. Writes nothing.
#[tauri::command]
pub async fn key_deploy_preview(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    key_id: String,
) -> Result<KeyDeployPreview, IpcError> {
    state.core()?.sessions.deploy_key_preview(window.label(), &session_id, &key_id).await
}

/// Appends the key to the server's authorized keys over that session (an explicit user action).
#[tauri::command]
pub async fn key_deploy(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    key_id: String,
) -> Result<KeyDeployPreview, IpcError> {
    state.core()?.sessions.deploy_key(window.label(), &session_id, &key_id).await
}

// agent D: inventory and snippets

#[tauri::command]
pub async fn host_appearance_list(
    state: State<'_, AppState>,
) -> Result<Vec<tyrminal_core::contracts::HostAppearance>, IpcError> {
    state.core()?.vault.list_host_appearances().await
}

#[tauri::command]
pub async fn host_set_os(
    state: State<'_, AppState>,
    ids: Vec<String>,
    os: Option<tyrminal_core::contracts::HostOs>,
) -> Result<u32, IpcError> {
    state.core()?.vault.set_host_os(&ids, os).await
}

#[tauri::command]
pub async fn import_known_hosts_preview(state: State<'_, AppState>) -> Result<ImportPreview, IpcError> {
    state.core()?.vault.known_host_import_preview().await
}

#[tauri::command]
pub async fn key_certificate_list(
    state: State<'_, AppState>,
) -> Result<Vec<tyrminal_core::contracts::KeyCertificate>, IpcError> {
    state.core()?.vault.list_key_certificates().await
}

#[tauri::command]
pub async fn key_certificate_attach(
    state: State<'_, AppState>,
    key_id: String,
    certificate: String,
) -> Result<tyrminal_core::contracts::KeyCertificate, IpcError> {
    state.core()?.vault.attach_key_certificate(&key_id, &certificate).await
}

#[tauri::command]
pub async fn key_certificate_remove(state: State<'_, AppState>, key_id: String) -> Result<(), IpcError> {
    state.core()?.vault.remove_key_certificate(&key_id).await
}

/// Largest private-key file read (BUILD_SPEC §13: 1 MiB imported key payloads).
const MAX_KEY_FILE: u64 = 1024 * 1024;

fn key_file_error(message: &'static str) -> IpcError {
    IpcError::new(tyrminal_core::contracts::ErrorCode::KeyInvalid, message)
}

/// The key file to read. Test builds take it from `TYRMINAL_E2E_KEY_FILE` instead of a native
/// dialog (WebDriver cannot drive OS dialogs); release builds never read it.
async fn pick_key_path(app: &tauri::AppHandle) -> Result<Option<std::path::PathBuf>, IpcError> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(std::env::var_os("TYRMINAL_E2E_KEY_FILE").map(std::path::PathBuf::from))
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file().set_title("Choose a private key");
        let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
            .await
            .map_err(|_| key_file_error("The file dialog could not be shown."))?;
        picked.map(|p| p.into_path().map_err(|_| key_file_error("That file cannot be used."))).transpose()
    }
}

/// Reads a key file: at most 1 MiB, UTF-8 text. The text never leaves the native side.
fn read_key_file(path: &std::path::Path) -> Result<zeroize::Zeroizing<String>, IpcError> {
    use std::io::Read;
    let too_large =
        || IpcError::new(tyrminal_core::contracts::ErrorCode::LimitExceeded, "That file is larger than 1 MiB.");
    let file = std::fs::File::open(path).map_err(|_| key_file_error("That file could not be read."))?;
    if file.metadata().map(|m| m.len() > MAX_KEY_FILE).unwrap_or(true) {
        return Err(too_large());
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    file.take(MAX_KEY_FILE + 1).read_to_end(&mut bytes).map_err(|_| key_file_error("That file could not be read."))?;
    if bytes.len() as u64 > MAX_KEY_FILE {
        return Err(too_large());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| key_file_error("That does not look like a private key."))?;
    Ok(zeroize::Zeroizing::new(text.to_owned()))
}

/// Opens the native file dialog for a private key and holds the file for this window. Returns
/// its name and whether it needs a passphrase, or `None` if the dialog was cancelled.
#[tauri::command]
pub async fn key_import_pick_file(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<tyrminal_core::contracts::PickedKeyFile>, IpcError> {
    state.core()?;
    let Some(path) = pick_key_path(&app).await? else { return Ok(None) };
    let reading = path.clone();
    let text = tauri::async_runtime::spawn_blocking(move || read_key_file(&reading))
        .await
        .map_err(|_| key_file_error("That file could not be read."))??;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let passphrase_protected = tyrminal_core::key_text_is_encrypted(&text);
    *state.picked_key.lock().unwrap_or_else(|p| p.into_inner()) =
        Some((window.label().to_owned(), file_name.clone(), text));
    Ok(Some(tyrminal_core::contracts::PickedKeyFile { file_name, passphrase_protected }))
}

/// Imports the key file this window picked, through the same checks as pasted key text. The file
/// stays held after a failure (a missing or wrong passphrase can be corrected) and is dropped
/// after a successful import.
#[tauri::command]
pub async fn key_import_picked(
    window: WebviewWindow,
    state: State<'_, AppState>,
    label: String,
    passphrase: Option<String>,
    remember_passphrase: bool,
) -> Result<KeySummary, IpcError> {
    let core = state.core()?;
    let text = {
        let picked = state.picked_key.lock().unwrap_or_else(|p| p.into_inner());
        match picked.as_ref() {
            Some((owner, _, text)) if owner == window.label() => text.as_str().to_owned(),
            _ => return Err(key_file_error("Choose the key file again.")),
        }
    };
    let result =
        core.vault.import_key(KeyImportInput { label, private_key: text, passphrase, remember_passphrase }).await;
    if result.is_ok() {
        state.picked_key.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
    result
}

/// Forgets a picked key file (the import dialog was closed).
#[tauri::command]
pub async fn key_import_pick_clear(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), IpcError> {
    let mut picked = state.picked_key.lock().unwrap_or_else(|p| p.into_inner());
    if picked.as_ref().is_some_and(|(owner, _, _)| owner == window.label()) {
        picked.take();
    }
    Ok(())
}

#[cfg(test)]
mod key_file_tests {
    use super::*;

    fn write(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tyrminal-keyfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/../../../tests/fixtures/keys/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn key_files_are_read_bounded_and_as_text_only() {
        // Synthetic keys, encrypted and not, read and classified without leaving this side.
        let plain = read_key_file(&write("plain.ppk", &fixture("ed25519-v3.ppk"))).unwrap();
        assert!(!tyrminal_core::key_text_is_encrypted(&plain));
        let encrypted = read_key_file(&write("enc.ppk", &fixture("ecdsa-v3-enc.ppk"))).unwrap();
        assert!(tyrminal_core::key_text_is_encrypted(&encrypted));

        // Binary data and oversized files are refused before any parsing.
        let binary = read_key_file(&write("binary.key", &[0xff, 0xfe, 0x00, 0x80])).unwrap_err();
        assert_eq!(binary.code, tyrminal_core::contracts::ErrorCode::KeyInvalid);
        let huge = read_key_file(&write("huge.key", &vec![b'A'; (MAX_KEY_FILE + 1) as usize])).unwrap_err();
        assert_eq!(huge.code, tyrminal_core::contracts::ErrorCode::LimitExceeded);
        assert!(read_key_file(std::path::Path::new("/nonexistent/tyrminal/key")).is_err());
    }
}

/// Reads an OpenSSH known_hosts file (text of a file the user picked) into a preview of which keys
/// would become trusted. Nothing is written.
#[tauri::command]
pub async fn known_hosts_import_preview(
    state: State<'_, AppState>,
    text: String,
) -> Result<tyrminal_core::contracts::KnownHostImportPreview, IpcError> {
    state.core()?.vault.known_hosts_file_preview(&text).await
}

/// Trusts previewed known_hosts keys in one transaction; conflicts refuse the whole import.
#[tauri::command]
pub async fn known_hosts_import(
    state: State<'_, AppState>,
    entries: Vec<tyrminal_core::contracts::KnownHostImportEntry>,
) -> Result<u32, IpcError> {
    state.core()?.vault.import_known_hosts(entries).await
}

// Identities (KEY-15..17). The password is write-only: no command returns it.

#[tauri::command]
pub async fn identity_list(
    state: State<'_, AppState>,
) -> Result<Vec<tyrminal_core::contracts::IdentitySummary>, IpcError> {
    state.core()?.vault.list_identities().await
}

#[tauri::command]
pub async fn identity_save(
    state: State<'_, AppState>,
    identity: tyrminal_core::contracts::IdentityInput,
) -> Result<tyrminal_core::contracts::IdentitySummary, IpcError> {
    state.core()?.vault.save_identity(identity).await
}

/// Deletes an identity; resolves to how many hosts and groups were using it.
#[tauri::command]
pub async fn identity_delete(state: State<'_, AppState>, id: String) -> Result<u32, IpcError> {
    state.core()?.vault.delete_identity(&id).await
}

#[tauri::command]
pub async fn identity_assignments(
    state: State<'_, AppState>,
) -> Result<Vec<tyrminal_core::contracts::IdentityAssignment>, IpcError> {
    state.core()?.vault.list_identity_assignments().await
}

#[tauri::command]
pub async fn identity_assign(
    state: State<'_, AppState>,
    target: tyrminal_core::contracts::SettingsTarget,
    identity_id: Option<String>,
) -> Result<tyrminal_core::contracts::IdentityAssignment, IpcError> {
    state.core()?.vault.set_identity(target, identity_id).await
}

// Environment variables (SNP-11..14). Values are the user's own settings, shown in the editor.

#[tauri::command]
pub async fn env_get(
    state: State<'_, AppState>,
    target: tyrminal_core::contracts::SettingsTarget,
) -> Result<Vec<tyrminal_core::contracts::EnvVar>, IpcError> {
    state.core()?.vault.env_vars(target).await
}

#[tauri::command]
pub async fn env_set(
    state: State<'_, AppState>,
    target: tyrminal_core::contracts::SettingsTarget,
    vars: Vec<tyrminal_core::contracts::EnvVar>,
) -> Result<Vec<tyrminal_core::contracts::EnvVar>, IpcError> {
    state.core()?.vault.set_env_vars(target, vars).await
}

#[tauri::command]
pub async fn env_effective(
    state: State<'_, AppState>,
    host_id: String,
) -> Result<Vec<tyrminal_core::contracts::EffectiveEnvVar>, IpcError> {
    state.core()?.vault.effective_env_vars(&host_id).await
}

/// The startup snippets a host or group sets itself (`null`: inherit the group's list).
#[tauri::command]
pub async fn startup_get(
    state: State<'_, AppState>,
    target: tyrminal_core::contracts::SettingsTarget,
) -> Result<Option<Vec<String>>, IpcError> {
    state.core()?.vault.startup_snippets(target).await
}

#[tauri::command]
pub async fn startup_set(
    state: State<'_, AppState>,
    target: tyrminal_core::contracts::SettingsTarget,
    snippet_ids: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, IpcError> {
    state.core()?.vault.set_startup_snippets(target, snippet_ids).await
}

/// What a host runs at startup, after group inheritance.
#[tauri::command]
pub async fn startup_effective(
    state: State<'_, AppState>,
    host_id: String,
) -> Result<tyrminal_core::contracts::EffectiveStartup, IpcError> {
    state.core()?.vault.effective_startup_snippets(&host_id).await
}

/// A group's route and appearance defaults for its hosts (HST-05).
#[tauri::command]
pub async fn group_defaults_get(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<tyrminal_core::contracts::GroupDefaults, IpcError> {
    state.core()?.vault.group_defaults(&group_id).await
}

#[tauri::command]
pub async fn group_defaults_set(
    state: State<'_, AppState>,
    group_id: String,
    defaults: tyrminal_core::contracts::GroupDefaultsInput,
) -> Result<tyrminal_core::contracts::GroupDefaults, IpcError> {
    state.core()?.vault.set_group_defaults(&group_id, defaults).await
}

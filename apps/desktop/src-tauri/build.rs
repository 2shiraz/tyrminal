//! Declares every application command explicitly. With an app manifest, a command that is not
//! listed here does not exist for the renderer, and a listed command still needs an `allow-*`
//! permission in a capability file before any window can invoke it (BUILD_SPEC §3.3, §4.6).

const COMMANDS: &[&str] = &[
    // vault
    "vault_status",
    "vault_create",
    "vault_unlock",
    "vault_unlock_recovery",
    "vault_lock",
    "vault_change_passphrase",
    "vault_rotate_recovery_key",
    "vault_activity",
    "vault_quick_unlock_status",
    "vault_quick_unlock_enable",
    "vault_quick_unlock_disable",
    "vault_unlock_device",
    // inventory
    "host_list",
    "host_save",
    "host_delete",
    "key_list",
    "key_import",
    "key_generate",
    "key_delete",
    "key_deploy_preview",
    "key_deploy",
    "known_host_list",
    "known_host_remove",
    "group_list",
    "group_save",
    "group_delete",
    "host_search",
    "host_duplicate",
    "host_favourite_set",
    "host_bulk",
    "import_preview",
    "import_hosts",
    // sessions
    "session_open_ssh",
    "session_open_local",
    "session_open_files",
    "session_open_exec",
    "session_write",
    "session_resize",
    "session_ack",
    "session_close",
    "session_trust_answer",
    "session_auth_answer",
    "session_handoff_offer",
    "session_attach",
    "session_diagnostics",
    "session_open_key_install",
    "containers_list",
    "container_session_open",
    // files (SFTP)
    "files_pick_upload",
    "files_pick_folder",
    "files_pick_upload_folder",
    "files_list",
    "files_mkdir",
    "files_rename",
    "files_remove",
    "files_chmod",
    "files_upload",
    "files_download",
    "files_cancel",
    "files_upload_begin",
    "files_upload_chunk",
    "files_upload_finish",
    "files_upload_abort",
    "files_local_list",
    "files_local_mkdir",
    "files_local_rename",
    "files_local_remove",
    "files_local_chmod",
    "files_copy",
    "files_edit_open",
    "files_edit_status",
    "files_edit_save",
    "files_edit_close",
    // snippets
    "snippet_list",
    "snippet_save",
    "snippet_delete",
    "snippet_send",
    // settings and shell
    "prefs_get",
    "prefs_set",
    "terminal_choices",
    "editor_pick_app",
    "diagnostics_report",
    "terminal_output_save",
    "serial_ports",
    "host_recent",
    "link_open",
    "app_info",
    // backup and restore
    "backup_export",
    "backup_status",
    "backup_choose",
    "backup_preview",
    "backup_restore",
    // agent B: tunnels and history
    "tunnel_list",
    "tunnel_save",
    "tunnel_duplicate",
    "tunnel_delete",
    "tunnel_start",
    "tunnel_stop",
    "tunnel_active",
    "tunnel_clear_ended",
    "host_connection_get",
    "host_connection_set",
    "host_chain",
    "recording_settings_get",
    "recording_settings_set",
    "session_log_list",
    "session_log_storage",
    "session_log_bookmark",
    "session_log_delete",
    "session_log_delete_all",
    "session_log_open",
    "quick_forward_start",
    "quick_forward_open",
    "host_port_suggestions_set",
    // agent C: workspaces
    "layout_list",
    "layout_save",
    "layout_delete",
    "window_detach",
    "window_detach_take",
    // agent D: inventory and snippets
    "host_appearance_list",
    "host_set_os",
    "import_known_hosts_preview",
    "key_certificate_list",
    "key_certificate_attach",
    "key_certificate_remove",
    "snippet_exec",
    "snippet_exec_cancel",
    "execution_target_list",
    "execution_target_save",
    "execution_target_delete",
    "snippet_move",
    "snippet_folder_rename",
    "key_import_pick_file",
    "key_import_picked",
    "key_import_pick_clear",
    "known_hosts_import_preview",
    "known_hosts_import",
    "prompt_marks_status",
    "prompt_marks_install",
    "prompt_marks_remove",
    "identity_list",
    "identity_save",
    "identity_delete",
    "identity_assignments",
    "identity_assign",
    "env_get",
    "env_set",
    "env_effective",
    // privilege prompts (KEY-18)
    "session_identity",
    "session_insert_identity_password",
    // identity deletion (BUILD_SPEC §10.2)
    "identity_usage",
    // compromised-password check (SEC-11)
    "password_check_status",
    "password_check_run",
    // security review (P-27)
    "security_review",
    "startup_get",
    "startup_set",
    "startup_effective",
    "group_defaults_get",
    "group_defaults_set",
    // terminal notifications (P-23)
    "notify_command_finished",
    "note_get",
    "note_set",
    "note_for_host",
    // LAN discovery
    "discovery_networks",
    "discovery_start",
    "discovery_status",
    "discovery_stop",
    // command history
    "history_settings_get",
    "history_settings_set",
    "history_add",
    "history_suggest",
    "history_list",
    "history_delete",
    "history_clear",
    // server at a glance
    "glance_get",
    "glance_host_get",
    "glance_host_set",
    // tmux and screen session awareness (P-31)
    "multiplexer_list",
    // OS auto-detection
    "os_detection_get",
    "os_detection_set",
];

/// Short hash of the commit being built: CI's `GITHUB_SHA`, else the local checkout, else `dev`.
fn build_commit() -> String {
    let valid = |s: &str| s.len() >= 7 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if let Ok(sha) = std::env::var("GITHUB_SHA")
        && valid(&sha)
    {
        return sha[..7].to_ascii_lowercase();
    }
    std::process::Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| valid(s))
        .unwrap_or_else(|| "dev".to_owned())
}

/// UTC build date. `SOURCE_DATE_EPOCH` keeps reproducible builds reproducible.
fn build_date() -> String {
    let secs = std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
    });
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = i64::try_from(secs / 86_400).unwrap_or(0) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Rebuild the stamp when the checked-out commit moves.
fn watch_git_head() {
    let Some(git_dir) = std::process::Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
    else {
        return;
    };
    let git_dir = std::path::PathBuf::from(git_dir.trim());
    let head = git_dir.join("HEAD");
    println!("cargo:rerun-if-changed={}", head.display());
    if let Some(reference) =
        std::fs::read_to_string(&head).ok().and_then(|h| h.strip_prefix("ref: ").map(|r| r.trim().to_owned()))
    {
        let path = git_dir.join(reference);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    watch_git_head();
    println!("cargo:rustc-env=TYRMINAL_BUILD_COMMIT={}", build_commit());
    println!("cargo:rustc-env=TYRMINAL_BUILD_DATE={}", build_date());
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri build configuration failed: {error:#}");
    }
}

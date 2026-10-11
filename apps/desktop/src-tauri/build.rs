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
    // inventory
    "host_list",
    "host_save",
    "host_delete",
    "key_list",
    "key_import",
    "key_generate",
    "key_delete",
    "known_host_list",
    "known_host_remove",
    // sessions
    "session_open_ssh",
    "session_open_local",
    "session_write",
    "session_resize",
    "session_ack",
    "session_close",
    "session_trust_answer",
    "session_auth_answer",
];

fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri build configuration failed: {error:#}");
    }
}

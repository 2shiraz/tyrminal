//! Upgrades (Phase 09): a vault written by an earlier release opens in this build with all of
//! its contents. Fixtures hold synthetic data only and are copied before use, so the committed
//! files are never modified. See tests/fixtures/upgrade/README.md for how they were made.

use std::path::{Path, PathBuf};

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{HostAuth, ThemePreference, VaultState};

fn fixture(release: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/upgrade").join(release)
}

fn copy_of(release: &str) -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    for name in ["vault.db", "preferences.json"] {
        std::fs::copy(fixture(release).join(name), dir.path().join(name)).unwrap();
    }
    let db = dir.path().join("vault.db");
    (dir, db)
}

#[tokio::test]
async fn a_beta_1_vault_opens_with_everything_in_it() {
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture("v0.1.0-beta.1").join("expected.json")).unwrap()).unwrap();
    let text = |key: &str| expected[key].as_str().unwrap().to_owned();
    let (_dir, db) = copy_of("v0.1.0-beta.1");
    let core = Core::open(&db).unwrap();
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked);
    core.vault.unlock_with_passphrase(text("passphrase")).await.unwrap();

    let keys = core.vault.list_keys().await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].label, "fixture key");
    assert_eq!(keys[0].fingerprint, text("keyFingerprint"));
    assert_eq!(keys[0].public_key, text("keyPublic"));

    let mut hosts = core.vault.list_hosts().await.unwrap();
    hosts.sort_by(|a, b| a.label.cmp(&b.label));
    let summary: Vec<_> =
        hosts.iter().map(|h| (h.label.as_str(), h.address.as_str(), h.port, h.username.as_str())).collect();
    assert_eq!(
        summary,
        [
            ("ask", "192.0.2.10", 2222, "fixture"),
            ("keyed", "192.0.2.10", 2222, "fixture"),
            ("stored", "192.0.2.10", 2222, "fixture")
        ]
    );
    assert_eq!(hosts[0].auth, HostAuth::AskPassword);
    assert_eq!(hosts[1].auth, HostAuth::Key { key_id: keys[0].id.clone() });
    assert_eq!(hosts[2].auth, HostAuth::StoredPassword);

    let snippets = core.vault.list_snippets().await.unwrap();
    assert_eq!(
        snippets.iter().map(|s| (s.name.as_str(), s.folder.as_str(), s.text.as_str())).collect::<Vec<_>>(),
        [("uptime", "fixture", "uptime\n")]
    );

    let prefs = core.preferences.get();
    assert_eq!(prefs.theme, ThemePreference::Light);
    assert!((prefs.terminal.font_size - 15.0).abs() < f32::EPSILON);
    // Settings added since then take their defaults.
    assert!(!prefs.diagnostics);
    assert_eq!(prefs.local_shell, None);

    // The recovery key from that release still opens the upgraded vault, and it reopens.
    core.vault.lock().await;
    // Stored as its five-character groups.
    let groups: Vec<&str> =
        expected["recoveryGroups"].as_array().unwrap().iter().map(|g| g.as_str().unwrap()).collect();
    core.vault.unlock_with_recovery_key(groups.join("-")).await.unwrap();
    core.vault.lock().await;
    drop(core);
    let again = Core::open(&db).unwrap();
    again.vault.unlock_with_passphrase(text("passphrase")).await.unwrap();
    assert_eq!(again.vault.list_hosts().await.unwrap().len(), 3);
}

#[tokio::test]
async fn a_wrong_passphrase_on_an_upgraded_vault_leaves_it_intact() {
    let (_dir, db) = copy_of("v0.1.0-beta.1");
    let core = Core::open(&db).unwrap();
    assert!(core.vault.unlock_with_passphrase("not it".into()).await.is_err());
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked);
    drop(core);
    let reopened = Core::open(&db).unwrap();
    reopened.vault.unlock_with_passphrase("fixture passphrase, synthetic".into()).await.unwrap();
    assert_eq!(reopened.vault.list_hosts().await.unwrap().len(), 3);
}

//! Vault lifecycle against real persisted files (Phase 02 gate; INV-04, INV-07, INV-11, INV-16).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{ErrorCode, HostAuth, HostAuthInput, HostInput, IpcError, KeyImportInput, VaultState};

const PASSPHRASE: &str = "correct horse battery staple";

fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("vault.db")
}

fn open(dir: &TempDir) -> Core {
    Core::open(&db_path(dir)).expect("open core")
}

async fn created(dir: &TempDir) -> (Core, String) {
    let core = open(dir);
    let issued = core.vault.create(PASSPHRASE.into()).await.expect("create vault");
    (core, issued.recovery_key)
}

fn host(label: &str, auth: HostAuthInput) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: "host.example".into(),
        port: 22,
        username: "deploy".into(),
        auth,
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, IpcError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

/// Opens the database file directly, the way an attacker with file access would.
fn raw(dir: &TempDir) -> rusqlite::Connection {
    rusqlite::Connection::open(db_path(dir)).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn create_store_lock_reopen_unlock_and_recover() {
    let dir = TempDir::new().unwrap();
    let (core, recovery_key) = created(&dir).await;
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Unlocked);

    let key = core.vault.generate_key("deploy key").await.unwrap();
    assert_eq!(key.algorithm, "ssh-ed25519");
    assert!(key.public_key.starts_with("ssh-ed25519 AAAA") && key.public_key.ends_with(" deploy-key"));
    let with_key = core.vault.save_host(host("alpha", HostAuthInput::Key { key_id: key.id.clone() })).await.unwrap();
    core.vault
        .save_host(host("beta", HostAuthInput::StoredPassword { password: Some("s3cret-pw".into()) }))
        .await
        .unwrap();
    core.vault.save_host(host("gamma", HostAuthInput::AskPassword)).await.unwrap();
    assert_eq!(core.vault.list_keys().await.unwrap()[0].used_by, 1);

    core.vault.lock().await;
    let status = core.vault.status().await.unwrap();
    assert_eq!(status.state, VaultState::Locked);
    assert_eq!(status.generation, 1);
    assert_eq!(code(core.vault.list_hosts().await), ErrorCode::VaultLocked);
    assert_eq!(code(core.vault.list_keys().await), ErrorCode::VaultLocked);
    assert_eq!(code(core.vault.save_host(host("x", HostAuthInput::AskPassword)).await), ErrorCode::VaultLocked);
    drop(core);

    // A new process: only what is on disk survives.
    let core = open(&dir);
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked);
    assert_eq!(code(core.vault.unlock_with_passphrase("wrong passphrase".into()).await), ErrorCode::WrongCredential);
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let hosts = core.vault.list_hosts().await.unwrap();
    assert_eq!(hosts.iter().map(|h| h.label.as_str()).collect::<Vec<_>>(), ["alpha", "beta", "gamma"]);
    assert_eq!(hosts[0], with_key);
    assert_eq!(hosts[1].auth, HostAuth::StoredPassword);
    let mut expected_key = key;
    expected_key.used_by = 1;
    assert_eq!(core.vault.list_keys().await.unwrap(), vec![expected_key]);

    // Recovery key path, including sloppy typing.
    core.vault.lock().await;
    assert_eq!(code(core.vault.unlock_with_recovery_key("AAAAA-BBBBB".into()).await), ErrorCode::InvalidRecoveryKey);
    core.vault.unlock_with_recovery_key(recovery_key.to_lowercase().replace('-', " ")).await.unwrap();
    assert_eq!(core.vault.list_hosts().await.unwrap().len(), 3);
}

/// INV-04: no sensitive value reaches the database, its WAL or any sibling file in plaintext.
#[tokio::test(flavor = "multi_thread")]
async fn no_plaintext_canary_reaches_any_file_on_disk() {
    let dir = TempDir::new().unwrap();
    let (core, recovery_key) = created(&dir).await;
    let canaries = [
        "CANARY-LABEL-7f3a9c",
        "canary-address-51be.example",
        "canary-user-88d2",
        "CANARY-PASSWORD-e41f07",
        "CANARY-KEYLABEL-2b6d",
        "CANARY-KEY-PASSPHRASE-9a0c",
        "CANARY-REASON-4d1e",
    ];
    core.vault
        .save_host(HostInput {
            id: None,
            label: canaries[0].into(),
            address: canaries[1].into(),
            port: 2222,
            username: canaries[2].into(),
            auth: HostAuthInput::StoredPassword { password: Some(canaries[3].into()) },
        })
        .await
        .unwrap();
    let generated = core.vault.generate_key(canaries[4]).await.unwrap();
    // Editing rewrites the record: the old revision's plaintext must not linger either.
    let listed = core.vault.list_hosts().await.unwrap();
    let mut edit = host(canaries[0], HostAuthInput::StoredPassword { password: None });
    edit.id = Some(listed[0].id.clone());
    edit.address = canaries[1].into();
    edit.username = canaries[2].into();
    core.vault.save_host(edit).await.unwrap();

    let scan = |stage: &str| {
        let mut files = 0;
        let fingerprint_body = generated.fingerprint.trim_start_matches("SHA256:").to_owned();
        let key_blob = generated.public_key.split(' ').nth(1).unwrap().to_owned();
        let mut needles: Vec<Vec<u8>> = canaries.iter().map(|c| c.as_bytes().to_vec()).collect();
        needles.extend([
            PASSPHRASE.as_bytes().to_vec(),
            recovery_key.as_bytes().to_vec(),
            recovery_key.replace('-', "").into_bytes(),
            b"OPENSSH PRIVATE KEY".to_vec(),
            b"ssh-ed25519".to_vec(),
            fingerprint_body.into_bytes(),
            key_blob.into_bytes(),
            b"\"label\"".to_vec(),
            b"private_key".to_vec(),
            b"deploy".to_vec(),
        ]);
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let path = entry.unwrap().path();
            // The WAL and shared-memory files come and go as SQLite checkpoints and closes.
            let Ok(bytes) = std::fs::read(&path) else { continue };
            files += 1;
            for needle in &needles {
                assert!(
                    !bytes.windows(needle.len()).any(|w| w == needle.as_slice()),
                    "{stage}: plaintext {:?} found in {}",
                    String::from_utf8_lossy(needle),
                    path.file_name().unwrap().to_string_lossy()
                );
            }
        }
        files
    };

    // While unlocked, with the WAL still holding recent writes.
    assert!(scan("unlocked with live WAL") >= 2, "expected the database and its WAL to exist");
    core.vault.lock().await;
    scan("locked");
    drop(core);
    scan("after clean shutdown (WAL checkpointed)");

    // And the data is really there, encrypted: reopening recovers every canary.
    let core = open(&dir);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let hosts = core.vault.list_hosts().await.unwrap();
    assert_eq!(
        (hosts[0].label.as_str(), hosts[0].address.as_str(), hosts[0].username.as_str()),
        (canaries[0], canaries[1], canaries[2])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tampered_swapped_and_relabelled_records_fail_the_whole_unlock() {
    let build = || async {
        let dir = TempDir::new().unwrap();
        let (core, _) = created(&dir).await;
        core.vault.save_host(host("one", HostAuthInput::AskPassword)).await.unwrap();
        core.vault
            .save_host(host("two", HostAuthInput::StoredPassword { password: Some("pw-two".into()) }))
            .await
            .unwrap();
        let hosts = core.vault.list_hosts().await.unwrap();
        core.vault.delete_host(&hosts[0].id).await.unwrap(); // leaves one live row and one tombstone
        core.vault.save_host(host("three", HostAuthInput::AskPassword)).await.unwrap();
        drop(core);
        dir
    };
    let attacks: [(&str, &str); 7] = [
        (
            "bit flip in a ciphertext",
            "UPDATE records SET ciphertext = zeroblob(length(ciphertext)) WHERE record_id IN (SELECT record_id FROM records WHERE deleted = 0 LIMIT 1)",
        ),
        ("nonce replaced", "UPDATE records SET nonce = zeroblob(24) WHERE deleted = 0"),
        ("revision relabelled", "UPDATE records SET revision = revision + 1 WHERE deleted = 0"),
        ("kind relabelled", "UPDATE records SET kind = 2 WHERE deleted = 0"),
        ("tombstone resurrected by flipping the hint", "UPDATE records SET deleted = 0 WHERE deleted = 1"),
        ("live record hidden by flipping the hint", "UPDATE records SET deleted = 1 WHERE deleted = 0"),
        ("key version relabelled", "UPDATE records SET key_version = 2"),
    ];
    for (name, sql) in attacks {
        let dir = build().await;
        assert!(raw(&dir).execute(sql, []).unwrap() > 0, "{name}: attack touched no rows");
        let core = open(&dir);
        let result = core.vault.unlock_with_passphrase(PASSPHRASE.into()).await;
        assert_eq!(code(result), ErrorCode::VaultDamaged, "{name}");
        assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked, "{name}");
        assert_eq!(code(core.vault.list_hosts().await), ErrorCode::VaultLocked, "{name}: no partial data");
    }

    // Swapping two records' ciphertexts (both valid under the same key) is caught by the AAD.
    let dir = build().await;
    {
        let conn = raw(&dir);
        let rows: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = conn
            .prepare("SELECT record_id, nonce, ciphertext FROM records WHERE deleted = 0 ORDER BY record_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows.len(), 2);
        for (target, source) in [(&rows[0], &rows[1]), (&rows[1], &rows[0])] {
            conn.execute(
                "UPDATE records SET nonce = ?2, ciphertext = ?3 WHERE record_id = ?1",
                rusqlite::params![target.0, source.1, source.2],
            )
            .unwrap();
        }
    }
    let core = open(&dir);
    assert_eq!(code(core.vault.unlock_with_passphrase(PASSPHRASE.into()).await), ErrorCode::VaultDamaged);
}

#[tokio::test(flavor = "multi_thread")]
async fn records_from_another_vault_or_a_newer_build_are_refused() {
    // A row copied in from a different vault (same passphrase) does not authenticate.
    let (dir_a, dir_b) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    for dir in [&dir_a, &dir_b] {
        let (core, _) = created(dir).await;
        core.vault.save_host(host("only", HostAuthInput::AskPassword)).await.unwrap();
    }
    {
        let conn = raw(&dir_a);
        conn.execute("ATTACH DATABASE ?1 AS other", [db_path(&dir_b).to_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO records SELECT * FROM other.records", []).unwrap();
    }
    let core = open(&dir_a);
    assert_eq!(code(core.vault.unlock_with_passphrase(PASSPHRASE.into()).await), ErrorCode::VaultDamaged);

    // The whole header replaced with another vault's header: the passphrase "works" for that
    // header, but the records then fail authentication rather than open under the wrong vault.
    {
        let conn = raw(&dir_a);
        conn.execute("ATTACH DATABASE ?1 AS other", [db_path(&dir_b).to_str().unwrap()]).unwrap();
        conn.execute("UPDATE vault_header SET header = (SELECT header FROM other.vault_header)", []).unwrap();
    }
    let core = open(&dir_a);
    assert_eq!(code(core.vault.unlock_with_passphrase(PASSPHRASE.into()).await), ErrorCode::VaultDamaged);

    // A header from a future format version is refused before any key derivation.
    let dir = TempDir::new().unwrap();
    drop(created(&dir).await);
    {
        let conn = raw(&dir);
        let mut header: Vec<u8> = conn.query_row("SELECT header FROM vault_header", [], |r| r.get(0)).unwrap();
        header[9] = 2;
        conn.execute("UPDATE vault_header SET header = ?1", [header]).unwrap();
    }
    let core = open(&dir);
    assert_eq!(code(core.vault.status().await), ErrorCode::VaultUnsupportedVersion);
    assert_eq!(code(core.vault.unlock_with_passphrase(PASSPHRASE.into()).await), ErrorCode::VaultUnsupportedVersion);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_unlocks_are_refused_not_queued_and_lock_wins_over_an_unlock_in_flight() {
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    core.vault.save_host(host("kept", HostAuthInput::AskPassword)).await.unwrap();
    core.vault.lock().await;

    // Eight simultaneous attempts: exactly one runs the KDF, the rest are told the vault is busy.
    let attempts: Vec<_> = (0..8)
        .map(|_| {
            let vault = Arc::clone(&core.vault);
            tokio::spawn(async move { vault.unlock_with_passphrase(PASSPHRASE.into()).await })
        })
        .collect();
    let mut ok = 0;
    let mut busy = 0;
    for attempt in attempts {
        match attempt.await.unwrap() {
            Ok(()) => ok += 1,
            Err(e) if e.code == ErrorCode::VaultBusy => busy += 1,
            Err(e) => panic!("unexpected {e:?}"),
        }
    }
    assert!(ok >= 1 && ok + busy == 8, "ok={ok} busy={busy}");
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Unlocked);

    // Lock requested while an unlock is deriving the key: the unlock must not publish its result.
    core.vault.lock().await;
    let vault = Arc::clone(&core.vault);
    let unlocking = tokio::spawn(async move { vault.unlock_with_passphrase(PASSPHRASE.into()).await });
    let mut status = core.vault.subscribe();
    status.wait_for(|s| s.state == VaultState::Unlocking).await.unwrap();
    core.vault.lock().await;
    assert_eq!(code(unlocking.await.unwrap()), ErrorCode::Cancelled);
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked);
    assert_eq!(code(core.vault.list_hosts().await), ErrorCode::VaultLocked);
}

/// Writers racing a lock: each write either fully happened or was refused. After reopening,
/// exactly the acknowledged hosts exist.
#[tokio::test(flavor = "multi_thread")]
async fn writes_racing_a_lock_are_atomic() {
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    let writers: Vec<_> = (0..40)
        .map(|i| {
            let vault = Arc::clone(&core.vault);
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                vault.save_host(host(&format!("host-{i:02}"), HostAuthInput::AskPassword)).await.map(|h| h.label)
            })
        })
        .collect();
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    core.vault.lock().await;
    let mut acknowledged = Vec::new();
    for writer in writers {
        match writer.await.unwrap() {
            Ok(label) => acknowledged.push(label),
            Err(e) => assert_eq!(e.code, ErrorCode::VaultLocked),
        }
    }
    acknowledged.sort();
    drop(core);

    let core = open(&dir);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let stored: Vec<String> = core.vault.list_hosts().await.unwrap().into_iter().map(|h| h.label).collect();
    assert_eq!(stored, acknowledged);
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_the_passphrase_and_rotating_the_recovery_key() {
    let dir = TempDir::new().unwrap();
    let (core, old_recovery) = created(&dir).await;
    core.vault.save_host(host("kept", HostAuthInput::StoredPassword { password: Some("pw".into()) })).await.unwrap();
    let header_before: Vec<u8> = raw(&dir).query_row("SELECT header FROM vault_header", [], |r| r.get(0)).unwrap();

    // The current passphrase is really verified, and failures change nothing on disk.
    assert_eq!(
        code(core.vault.change_passphrase("not it".into(), "a brand new passphrase".into()).await),
        ErrorCode::WrongCredential
    );
    assert_eq!(code(core.vault.change_passphrase(PASSPHRASE.into(), "short".into()).await), ErrorCode::InvalidInput);
    let header_now: Vec<u8> = raw(&dir).query_row("SELECT header FROM vault_header", [], |r| r.get(0)).unwrap();
    assert_eq!(header_now, header_before);

    core.vault.change_passphrase(PASSPHRASE.into(), "a brand new passphrase".into()).await.unwrap();
    let new_recovery = core.vault.rotate_recovery_key("a brand new passphrase".into()).await.unwrap().recovery_key;
    assert_ne!(new_recovery, old_recovery);
    assert_eq!(code(core.vault.rotate_recovery_key(PASSPHRASE.into()).await), ErrorCode::WrongCredential);
    drop(core);

    let core = open(&dir);
    assert_eq!(code(core.vault.unlock_with_passphrase(PASSPHRASE.into()).await), ErrorCode::WrongCredential);
    assert_eq!(code(core.vault.unlock_with_recovery_key(old_recovery).await), ErrorCode::WrongCredential);
    core.vault.unlock_with_recovery_key(new_recovery).await.unwrap();
    core.vault.lock().await;
    core.vault.unlock_with_passphrase("a brand new passphrase".into()).await.unwrap();
    assert_eq!(core.vault.list_hosts().await.unwrap()[0].label, "kept");
    // Locked vaults refuse both operations.
    core.vault.lock().await;
    assert_eq!(
        code(core.vault.change_passphrase("a brand new passphrase".into(), "yet another one".into()).await),
        ErrorCode::VaultLocked
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn hosts_keys_and_references_keep_their_integrity() {
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    let v = &core.vault;
    assert_eq!(code(v.create(PASSPHRASE.into()).await), ErrorCode::VaultAlreadyExists);

    // No dangling key references, at creation or by deletion.
    let ghost = HostAuthInput::Key { key_id: "00000000000000000000000000000000".into() };
    assert_eq!(code(v.save_host(host("h", ghost)).await), ErrorCode::NotFound);
    let key = v.generate_key("k").await.unwrap();
    let h = v.save_host(host("h", HostAuthInput::Key { key_id: key.id.clone() })).await.unwrap();
    assert_eq!(code(v.delete_key(&key.id).await), ErrorCode::InUse);

    // "Keep the stored password" only works when one is stored.
    let mut edit = host("h", HostAuthInput::StoredPassword { password: None });
    edit.id = Some(h.id.clone());
    assert_eq!(code(v.save_host(edit).await), ErrorCode::InvalidInput);
    let mut edit = host("h renamed", HostAuthInput::StoredPassword { password: Some("first-password".into()) });
    edit.id = Some(h.id.clone());
    assert_eq!(v.save_host(edit).await.unwrap().label, "h renamed");
    let mut keep = host("h renamed again", HostAuthInput::StoredPassword { password: None });
    keep.id = Some(h.id.clone());
    assert_eq!(v.save_host(keep).await.unwrap().auth, HostAuth::StoredPassword);

    // Now unreferenced, the key can go; deletions survive a restart as tombstones.
    v.delete_key(&key.id).await.unwrap();
    assert_eq!(code(v.delete_key(&key.id).await), ErrorCode::NotFound);
    v.delete_host(&h.id).await.unwrap();
    assert_eq!(code(v.delete_host(&h.id).await), ErrorCode::NotFound);
    let mut gone = host("zombie", HostAuthInput::AskPassword);
    gone.id = Some(h.id.clone());
    assert_eq!(code(v.save_host(gone).await), ErrorCode::NotFound);
    drop(core);
    let core = open(&dir);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert!(core.vault.list_hosts().await.unwrap().is_empty());
    assert!(core.vault.list_keys().await.unwrap().is_empty());

    // Invalid inputs are rejected natively, whatever the UI allowed.
    let v = &core.vault;
    for (label, address, port, username) in [
        ("", "a.example", 22, "u"),
        ("ok", "user@a.example", 22, "u"),
        ("ok", "a.example", 0, "u"),
        ("ok", "a.example", 22, "-oProxyCommand=x"),
        ("esc\u{1b}[2J", "a.example", 22, "u"),
    ] {
        let input = HostInput {
            id: None,
            label: label.into(),
            address: address.into(),
            port,
            username: username.into(),
            auth: HostAuthInput::AskPassword,
        };
        assert_eq!(
            code(v.save_host(input).await),
            ErrorCode::InvalidInput,
            "{label:?} {address:?} {port} {username:?}"
        );
    }
    assert_eq!(code(v.delete_host("../../etc/passwd").await), ErrorCode::InvalidInput);
    assert_eq!(code(v.generate_key("   ").await), ErrorCode::InvalidInput);
}

#[tokio::test(flavor = "multi_thread")]
async fn key_import_validates_before_storing_and_never_echoes_secrets() {
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    let v = &core.vault;
    let import = |private_key: &str, passphrase: Option<&str>, remember: bool| KeyImportInput {
        label: "imported".into(),
        private_key: private_key.into(),
        passphrase: passphrase.map(Into::into),
        remember_passphrase: remember,
    };
    assert_eq!(code(v.import_key(import("not a key", None, false)).await), ErrorCode::KeyInvalid);
    assert_eq!(code(v.import_key(import(&"A".repeat(1024 * 1024 + 1), None, false)).await), ErrorCode::LimitExceeded);
    assert!(v.list_keys().await.unwrap().is_empty(), "nothing is stored for a rejected import");

    let generated = v.generate_key("generated").await.unwrap();
    v.generate_key("generated two").await.unwrap();
    let listed = v.list_keys().await.unwrap();
    assert_eq!(listed.len(), 2);
    let rendered = format!("{listed:?} {generated:?}");
    assert!(!rendered.contains("PRIVATE KEY"), "summaries carry public data only");
    for summary in &listed {
        assert!(!summary.passphrase_protected && !summary.passphrase_stored && summary.used_by == 0);
    }

    // Error messages are fixed text: they never include what was submitted.
    let secretish = "CANARY-SUBMITTED-KEY-TEXT";
    let e = v.import_key(import(secretish, Some("CANARY-PASSPHRASE"), true)).await.unwrap_err();
    assert!(!format!("{e:?} {e}").contains("CANARY"));
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_wrong_passphrases_are_slowed_down_and_reset_on_success() {
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    core.vault.lock().await;
    let timed = |passphrase: &'static str| {
        let vault = Arc::clone(&core.vault);
        async move {
            let started = std::time::Instant::now();
            let result = vault.unlock_with_passphrase(passphrase.into()).await;
            (result, started.elapsed())
        }
    };
    let mut baseline = std::time::Duration::ZERO;
    for _ in 0..3 {
        let (result, elapsed) = timed("wrong wrong wrong").await;
        assert_eq!(code(result), ErrorCode::WrongCredential);
        baseline = baseline.max(elapsed);
    }
    // Fourth and fifth consecutive failures carry an added delay of 250 ms and 500 ms.
    let (result, fourth) = timed("wrong wrong wrong").await;
    assert_eq!(code(result), ErrorCode::WrongCredential);
    assert!(fourth >= std::time::Duration::from_millis(250), "fourth attempt took {fourth:?}");
    let (result, fifth) = timed("wrong wrong wrong").await;
    assert_eq!(code(result), ErrorCode::WrongCredential);
    assert!(fifth >= std::time::Duration::from_millis(500), "fifth attempt took {fifth:?}");
    // The right passphrase still works (after its delay) and clears the counter.
    timed(PASSPHRASE).await.0.unwrap();
    core.vault.lock().await;
    let (result, after_reset) = timed("wrong wrong wrong").await;
    assert_eq!(code(result), ErrorCode::WrongCredential);
    assert!(after_reset < baseline + std::time::Duration::from_millis(200), "counter was not reset: {after_reset:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn uninitialized_vault_reports_its_state_and_refuses_everything_else() {
    let dir = TempDir::new().unwrap();
    let core = open(&dir);
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Uninitialized);
    assert_eq!(code(core.vault.unlock_with_passphrase(PASSPHRASE.into()).await), ErrorCode::VaultNotInitialized);
    assert_eq!(code(core.vault.list_hosts().await), ErrorCode::VaultLocked);
    core.vault.lock().await; // harmless
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Uninitialized);
    assert_eq!(code(core.vault.create("short".into()).await), ErrorCode::InvalidInput);
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Uninitialized);
    assert!(Path::new(&db_path(&dir)).exists());
}

/// The idle lock is enforced by the core. Activity postpones it; silence locks; it re-arms after
/// every unlock.
#[tokio::test(flavor = "multi_thread")]
async fn the_core_locks_the_vault_after_inactivity_and_rearms_after_unlock() {
    use std::time::{Duration, Instant};
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    let timeout = Duration::from_millis(400);
    let timer = tokio::spawn(Arc::clone(&core.vault).run_idle_lock(timeout));
    let mut status = core.vault.subscribe();

    // Steady activity for three timeouts: still unlocked.
    let started = Instant::now();
    while started.elapsed() < timeout * 3 {
        core.vault.note_activity();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Unlocked);

    // Silence: locked within one timeout (plus scheduling slack), not before.
    let quiet_from = Instant::now();
    tokio::time::timeout(timeout * 4, status.wait_for(|s| s.state == VaultState::Locked))
        .await
        .expect("idle lock fired")
        .unwrap();
    assert!(
        quiet_from.elapsed() >= timeout - Duration::from_millis(60),
        "locked too early: {:?}",
        quiet_from.elapsed()
    );
    assert_eq!(code(core.vault.list_hosts().await), ErrorCode::VaultLocked);

    // Re-armed after unlocking again, with no activity reported at all.
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    tokio::time::timeout(timeout * 4, status.wait_for(|s| s.state == VaultState::Locked))
        .await
        .expect("idle lock re-armed")
        .unwrap();

    // Activity while locked does not unlock anything.
    core.vault.note_activity();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(core.vault.status().await.unwrap().state, VaultState::Locked);
    timer.abort();
}

/// Snippets (SNP-01..04): encrypted records with folders and multi-line text; validated; they
/// persist across restarts, never appear in plaintext on disk, and are gone from memory on lock.
#[tokio::test(flavor = "multi_thread")]
async fn snippets_are_encrypted_records_that_persist_and_disappear_on_lock() {
    use tyrminal_core::contracts::SnippetInput;
    let dir = TempDir::new().unwrap();
    let (core, _) = created(&dir).await;
    let canary = "echo SNIPPET-CANARY-7f3e";
    let input = |id: Option<String>, name: &str, folder: &str, text: &str| SnippetInput {
        id,
        name: name.into(),
        folder: folder.into(),
        text: text.into(),
    };
    let deploy = core
        .vault
        .save_snippet(input(None, "Deploy", " /Ops/ Staging/ ", &format!("{canary}\r\nuptime")))
        .await
        .unwrap();
    assert_eq!(deploy.folder, "Ops/Staging");
    assert_eq!(deploy.text, format!("{canary}\nuptime"));
    core.vault.save_snippet(input(None, "Disk", "", "df -h")).await.unwrap();

    // Validation happens natively, whatever the UI sent.
    for bad in [
        input(None, "", "", "ls"),
        input(None, "x", "", "  "),
        input(None, "x", "a//b", "ls"),
        input(None, "x", "", "printf '\u{1b}]52;c;AAAA\u{7}'"),
        input(None, "x", "", &"y".repeat(64 * 1024 + 1)),
    ] {
        assert!(core.vault.save_snippet(bad).await.is_err());
    }
    assert_eq!(code(core.vault.save_snippet(input(Some("0".repeat(32)), "x", "", "ls")).await), ErrorCode::NotFound);

    let edited = core.vault.save_snippet(input(Some(deploy.id.clone()), "Deploy v2", "Ops", "uptime")).await.unwrap();
    assert_eq!(edited.id, deploy.id);
    let list = core.vault.list_snippets().await.unwrap();
    assert_eq!(list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Disk", "Deploy v2"]);

    // Nothing in plaintext on disk (the edited-away canary included).
    core.vault.save_snippet(input(Some(deploy.id.clone()), "Deploy v3", "Ops", canary)).await.unwrap();
    core.vault.lock().await;
    assert_eq!(code(core.vault.list_snippets().await), ErrorCode::VaultLocked);
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(canary.len()).any(|w| w == canary.as_bytes()), "snippet text found on disk");
    }
    drop(core);

    let core = open(&dir);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let list = core.vault.list_snippets().await.unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[1].text, canary);
    core.vault.delete_snippet(&list[0].id).await.unwrap();
    assert_eq!(core.vault.list_snippets().await.unwrap().len(), 1);
    assert_eq!(code(core.vault.delete_snippet(&list[0].id).await), ErrorCode::NotFound);
}

/// Preferences are not vault data: readable while locked, validated, and stored owner-only.
#[tokio::test(flavor = "multi_thread")]
async fn preferences_are_available_while_locked_and_validated() {
    use tyrminal_core::contracts::{Preferences, ThemePreference};
    let dir = TempDir::new().unwrap();
    let core = open(&dir);
    assert_eq!(core.preferences.get(), Preferences::default());
    let mut prefs = Preferences { theme: ThemePreference::Dark, ..Preferences::default() };
    prefs.terminal.font_size = 99.0;
    let stored = core.preferences.set(prefs).unwrap();
    assert!((stored.terminal.font_size - 32.0).abs() < f32::EPSILON);
    drop(core);
    assert_eq!(open(&dir).preferences.get().theme, ThemePreference::Dark);
}

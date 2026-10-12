//! Host and group notes against a real vault (P-30): encrypted at rest, validated, shown with
//! their groups' notes, carried by an encrypted backup, and gone with their host or group.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    BackupCredentialKind, ErrorCode, GroupInput, HostAuthInput, HostInput, HostProtocol, IpcError, NoteFormat,
    NoteInput, SettingOrigin, SettingsTarget,
};

const PASSPHRASE: &str = "correct horse battery staple";
const HOST_CANARY: &str = "note-canary-7f3a host runbook";
const GROUP_CANARY: &str = "note-canary-91bd group runbook";

fn code<T: std::fmt::Debug>(result: Result<T, IpcError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

fn host(label: &str, group: Option<&str>) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{label}.example"),
        port: None,
        username: "deploy".into(),
        auth: HostAuthInput::AskPassword,
        group_id: group.map(Into::into),
        tags: Vec::new(),
        protocol: HostProtocol::Ssh,
        terminal: Default::default(),
        forward_agent: false,
    }
}

fn group(name: &str) -> GroupInput {
    GroupInput { id: None, name: name.into(), parent_id: None, username: None, port: None, key_id: None }
}

fn on_host(id: &str) -> SettingsTarget {
    SettingsTarget::Host { host_id: id.into() }
}

fn on_group(id: &str) -> SettingsTarget {
    SettingsTarget::Group { group_id: id.into() }
}

fn markdown(text: &str) -> Option<NoteInput> {
    Some(NoteInput { text: text.into(), format: NoteFormat::Markdown })
}

fn all_bytes(dir: &Path) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(all_bytes(&path));
        } else {
            out.extend(std::fs::read(&path).unwrap());
        }
    }
    out
}

/// Live (not tombstoned) host/group settings records, where notes are stored (kind 204).
fn live_settings_records(dir: &Path) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("vault.db")).unwrap();
    conn.query_row("SELECT count(*) FROM records WHERE kind = 204 AND deleted = 0", [], |r| r.get(0)).unwrap()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_are_encrypted_survive_a_backup_and_go_with_their_host_or_group() {
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let ops = core.vault.save_group(group("Ops")).await.unwrap();
    let web = core.vault.save_host(host("web", Some(&ops.id))).await.unwrap();
    let other = core.vault.save_host(host("other", None)).await.unwrap();

    // Nothing yet; an unknown or malformed target is refused.
    assert_eq!(core.vault.note(on_host(&web.id)).await.unwrap(), None);
    assert!(core.vault.host_notes(&web.id).await.unwrap().is_empty());
    assert_eq!(code(core.vault.note(on_host("not-an-id")).await), ErrorCode::InvalidInput);
    assert_eq!(code(core.vault.set_note(on_group(&web.id), markdown("x")).await), ErrorCode::NotFound);

    let host_text = format!("# Runbook\r\n\n{HOST_CANARY}\n\n```sh\nsudo systemctl restart app\n```\n");
    let saved = core.vault.set_note(on_host(&web.id), markdown(&host_text)).await.unwrap().unwrap();
    assert_eq!(saved.text, host_text.replace("\r\n", "\n"));
    assert_eq!(saved.format, NoteFormat::Markdown);
    core.vault
        .set_note(on_group(&ops.id), Some(NoteInput { text: GROUP_CANARY.into(), format: NoteFormat::Plain }))
        .await
        .unwrap();

    // The host shows its own note first, then its group's; another host shows none.
    let notes = core.vault.host_notes(&web.id).await.unwrap();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0].origin, SettingOrigin::Host);
    assert!(notes[0].note.text.contains(HOST_CANARY));
    assert_eq!(notes[1].origin, SettingOrigin::Group { group_id: ops.id.clone(), name: "Ops".into() });
    assert_eq!(notes[1].note.text, GROUP_CANARY);
    assert!(core.vault.host_notes(&other.id).await.unwrap().is_empty());

    // Validation: control and invisible characters and oversized text are refused and change nothing.
    for bad in ["\u{1b}]52;c;AAAA\u{7}", "run \u{202E}txt.exe", &"x".repeat(64 * 1024 + 1)] {
        assert_eq!(code(core.vault.set_note(on_host(&web.id), markdown(bad)).await), ErrorCode::InvalidInput);
    }
    assert!(core.vault.note(on_host(&web.id)).await.unwrap().unwrap().text.contains(HOST_CANARY));

    assert_eq!(live_settings_records(dir.path()), 2, "one encrypted record per note");

    // Encrypted at rest: neither note is anywhere on disk in plaintext.
    let disk = all_bytes(dir.path());
    for needle in [HOST_CANARY, GROUP_CANARY, "systemctl restart app"] {
        assert!(!contains(&disk, needle), "{needle:?} is on disk in plaintext");
    }

    // Locked: notes cannot be read or written.
    core.vault.lock().await;
    assert_eq!(code(core.vault.note(on_host(&web.id)).await), ErrorCode::VaultLocked);
    assert_eq!(code(core.vault.host_notes(&web.id).await), ErrorCode::VaultLocked);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();

    // An encrypted backup carries them (and holds no plaintext); a fresh install gets them back.
    let backup = core.vault.export_backup().await.unwrap();
    assert!(!contains(&backup, HOST_CANARY) && !contains(&backup, GROUP_CANARY), "no plaintext in the backup");
    let fresh_dir = TempDir::new().unwrap();
    let fresh = Core::open(&fresh_dir.path().join("vault.db")).unwrap();
    fresh.vault.restore_backup(backup, BackupCredentialKind::Passphrase, PASSPHRASE.into(), false).await.unwrap();
    fresh.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let restored = fresh.vault.host_notes(&web.id).await.unwrap();
    assert_eq!(restored.iter().map(|n| n.note.text.as_str()).collect::<Vec<_>>(), [saved.text.as_str(), GROUP_CANARY]);
    assert_eq!(restored[0].note.format, NoteFormat::Markdown);
    assert!(!contains(&all_bytes(fresh_dir.path()), HOST_CANARY));

    // Clearing a note deletes it; whitespace counts as empty.
    core.vault.set_note(on_group(&ops.id), markdown(" \n\t")).await.unwrap();
    assert_eq!(core.vault.note(on_group(&ops.id)).await.unwrap(), None);
    core.vault.set_note(on_group(&ops.id), markdown(GROUP_CANARY)).await.unwrap();
    core.vault.set_note(on_group(&ops.id), None).await.unwrap();
    assert_eq!(core.vault.host_notes(&web.id).await.unwrap().len(), 1);

    // Deleting the host deletes its note; deleting the group deletes the group's.
    core.vault.set_note(on_group(&ops.id), markdown(GROUP_CANARY)).await.unwrap();
    core.vault.delete_host(&web.id).await.unwrap();
    assert_eq!(code(core.vault.note(on_host(&web.id)).await), ErrorCode::NotFound);
    core.vault.delete_group(&ops.id).await.unwrap();
    assert_eq!(code(core.vault.note(on_group(&ops.id)).await), ErrorCode::NotFound);
    assert_eq!(live_settings_records(dir.path()), 0, "the note records are tombstoned with their host and group");
    // A host created later never sees them, and nothing comes back after a restart.
    let later = core.vault.save_host(host("later", None)).await.unwrap();
    assert!(core.vault.host_notes(&later.id).await.unwrap().is_empty());
    let after = core.vault.export_backup().await.unwrap();
    drop(core);

    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(code(core.vault.note(on_host(&web.id)).await), ErrorCode::NotFound);
    assert!(core.vault.host_notes(&later.id).await.unwrap().is_empty());
    // The backup made after the deletion restores no note either.
    let again_dir = TempDir::new().unwrap();
    let again = Core::open(&again_dir.path().join("vault.db")).unwrap();
    again.vault.restore_backup(after, BackupCredentialKind::Passphrase, PASSPHRASE.into(), false).await.unwrap();
    again.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    for h in again.vault.list_hosts().await.unwrap() {
        assert!(again.vault.host_notes(&h.id).await.unwrap().is_empty(), "{} has a note", h.label);
    }
}

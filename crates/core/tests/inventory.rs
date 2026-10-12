//! Host inventory against a real vault (Phase 04): nested groups with inherited settings, tags,
//! search, duplication and bulk changes.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Instant;

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    BulkHostChange, ErrorCode, GroupInput, HostAuth, HostAuthInput, HostInput, HostProtocol, IdentityInput,
    InheritedFields, IpcError, SecretChange, SettingOrigin, SettingsTarget,
};

const PASSPHRASE: &str = "correct horse battery staple";

async fn unlocked(dir: &TempDir) -> Core {
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    core
}

fn code<T: std::fmt::Debug>(result: Result<T, IpcError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

fn group(name: &str, parent: Option<&str>) -> GroupInput {
    GroupInput {
        id: None,
        name: name.into(),
        parent_id: parent.map(Into::into),
        username: None,
        port: None,
        key_id: None,
    }
}

fn host(label: &str, group: Option<&str>) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{label}.example"),
        port: None,
        username: String::new(),
        auth: HostAuthInput::Inherit,
        group_id: group.map(Into::into),
        tags: Vec::new(),
        protocol: HostProtocol::Ssh,
        terminal: Default::default(),
        forward_agent: false,
    }
}

#[tokio::test]
async fn hosts_inherit_from_the_nearest_group_and_their_own_values_win() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v.generate_key("fleet key").await.unwrap();
    let root = v
        .save_group(GroupInput {
            username: Some("ops".into()),
            port: Some(2200),
            key_id: Some(key.id.clone()),
            ..group("Prod", None)
        })
        .await
        .unwrap();
    let child =
        v.save_group(GroupInput { username: Some("dbadmin".into()), ..group("DB", Some(&root.id)) }).await.unwrap();

    // Nothing set on the host: user from the child, port and key from the root.
    let h = v.save_host(host("db-1", Some(&child.id))).await.unwrap();
    assert_eq!(h.username, "dbadmin");
    assert_eq!(h.port, 2200);
    assert_eq!(h.auth, HostAuth::Key { key_id: key.id.clone() });
    assert_eq!(h.inherited, InheritedFields { username: true, port: true, auth: true });

    // The host's own values override every group.
    let own = v
        .save_host(HostInput {
            username: "me".into(),
            port: Some(22),
            auth: HostAuthInput::AskPassword,
            ..host("db-2", Some(&child.id))
        })
        .await
        .unwrap();
    assert_eq!((own.username.as_str(), own.port, own.auth.clone()), ("me", 22, HostAuth::AskPassword));
    assert_eq!(own.inherited, InheritedFields::default());

    // No group at all: default port, ask for the password, no user name (connect refuses).
    let bare = v.save_host(host("bare", None)).await.unwrap();
    assert_eq!((bare.username.as_str(), bare.port, bare.auth), ("", 22, HostAuth::AskPassword));

    // Changing the group changes the effective settings of its hosts, and survives a reopen.
    v.save_group(GroupInput { id: Some(child.id.clone()), username: None, ..group("DB", Some(&root.id)) })
        .await
        .unwrap();
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let listed = v.list_hosts().await.unwrap();
    let db1 = listed.iter().find(|h| h.label == "db-1").unwrap();
    assert_eq!(db1.username, "ops", "the root's user name now applies");
    assert_eq!(db1.group_id.as_deref(), Some(child.id.as_str()));
}

#[tokio::test]
async fn group_trees_refuse_cycles_dangling_references_and_non_empty_deletes() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let a = v.save_group(group("A", None)).await.unwrap();
    let b = v.save_group(group("B", Some(&a.id))).await.unwrap();
    let c = v.save_group(group("C", Some(&b.id))).await.unwrap();

    // A under its own grandchild, or under itself.
    assert_eq!(
        code(v.save_group(GroupInput { id: Some(a.id.clone()), ..group("A", Some(&c.id)) }).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(v.save_group(GroupInput { id: Some(a.id.clone()), ..group("A", Some(&a.id)) }).await),
        ErrorCode::InvalidInput
    );
    // A parent, host group or key that does not exist.
    let missing = "0".repeat(32);
    assert_eq!(code(v.save_group(group("X", Some(&missing))).await), ErrorCode::NotFound);
    assert_eq!(code(v.save_host(host("h", Some(&missing))).await), ErrorCode::NotFound);
    assert_eq!(
        code(v.save_group(GroupInput { key_id: Some(missing.clone()), ..group("Y", None) }).await),
        ErrorCode::NotFound
    );
    // Names are single path segments.
    assert_eq!(code(v.save_group(group("a/b", None)).await), ErrorCode::InvalidInput);

    // A group with a subgroup or a host cannot be deleted; an empty one can.
    assert_eq!(code(v.delete_group(&b.id).await), ErrorCode::InUse);
    let h = v.save_host(host("in-c", Some(&c.id))).await.unwrap();
    assert_eq!(code(v.delete_group(&c.id).await), ErrorCode::InUse);
    v.delete_host(&h.id).await.unwrap();
    v.delete_group(&c.id).await.unwrap();
    v.delete_group(&b.id).await.unwrap();

    // A key a group uses cannot be deleted.
    let key = v.generate_key("k").await.unwrap();
    v.save_group(GroupInput { id: Some(a.id.clone()), key_id: Some(key.id.clone()), ..group("A", None) })
        .await
        .unwrap();
    assert_eq!(code(v.delete_key(&key.id).await), ErrorCode::InUse);

    // Groups list in path order and survive a reopen.
    v.save_group(group("Z-child", Some(&a.id))).await.unwrap();
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let names: Vec<String> = v.list_groups().await.unwrap().into_iter().map(|g| g.name).collect();
    assert_eq!(names, ["A", "Z-child"]);
}

#[tokio::test]
async fn tags_are_normalized_and_bulk_changes_are_all_or_nothing() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let h = v
        .save_host(HostInput {
            tags: vec![" prod ".into(), "PROD".into(), "linux".into(), String::new()],
            ..host("a", None)
        })
        .await
        .unwrap();
    assert_eq!(h.tags, ["linux", "prod"]);
    assert_eq!(
        code(v.save_host(HostInput { tags: vec!["a,b".into()], ..host("b", None) }).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(v.save_host(HostInput { tags: (0..17).map(|i| format!("t{i}")).collect(), ..host("c", None) }).await),
        ErrorCode::InvalidInput
    );

    let b = v.save_host(host("b", None)).await.unwrap();
    let g = v.save_group(group("G", None)).await.unwrap();
    let ids = vec![h.id.clone(), b.id.clone()];
    assert_eq!(v.bulk_update_hosts(&ids, BulkHostChange::AddTag { tag: "web".into() }).await.unwrap(), 2);
    assert_eq!(
        v.bulk_update_hosts(&ids, BulkHostChange::MoveToGroup { group_id: Some(g.id.clone()) }).await.unwrap(),
        2
    );
    let listed = v.list_hosts().await.unwrap();
    assert!(listed.iter().all(|h| h.tags.contains(&"web".to_owned()) && h.group_id.as_deref() == Some(g.id.as_str())));

    // One missing host: nothing changes at all.
    let with_missing = vec![h.id.clone(), "f".repeat(32)];
    assert_eq!(code(v.bulk_update_hosts(&with_missing, BulkHostChange::Delete).await), ErrorCode::NotFound);
    assert_eq!(v.list_hosts().await.unwrap().len(), 2);

    assert_eq!(v.bulk_update_hosts(&ids, BulkHostChange::RemoveTag { tag: "WEB".into() }).await.unwrap(), 2);
    assert!(v.list_hosts().await.unwrap().iter().all(|h| !h.tags.contains(&"web".to_owned())));
    assert_eq!(v.bulk_update_hosts(&ids, BulkHostChange::Delete).await.unwrap(), 2);
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert!(v.list_hosts().await.unwrap().is_empty(), "the bulk delete was persisted");
}

#[tokio::test]
async fn duplicating_a_host_copies_its_settings_but_not_its_history() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let g = v.save_group(group("G", None)).await.unwrap();
    let original = v
        .save_host(HostInput {
            username: "deploy".into(),
            port: Some(2222),
            auth: HostAuthInput::StoredPassword { password: Some("pw".into()) },
            tags: vec!["prod".into()],
            ..host("web", Some(&g.id))
        })
        .await
        .unwrap();
    let copy = v.duplicate_host(&original.id).await.unwrap();
    assert_ne!(copy.id, original.id);
    assert_eq!(copy.label, "web (copy)");
    assert_eq!(
        (copy.address, copy.port, copy.username, copy.auth),
        (original.address, 2222, original.username, HostAuth::StoredPassword)
    );
    assert_eq!((copy.group_id, copy.tags), (original.group_id, original.tags));
    assert_eq!(copy.last_connected_at, None);
}

#[tokio::test]
async fn search_matches_every_term_and_stays_fast_with_ten_thousand_hosts() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let eu = v.save_group(group("Europe", None)).await.unwrap();
    let west = v.save_group(group("West", Some(&eu.id))).await.unwrap();
    // 10,000 hosts, half in Europe/West, every 100th tagged.
    for i in 0..10_000u32 {
        let tags = if i % 100 == 0 { vec!["canary".to_owned()] } else { Vec::new() };
        let group_id = if i % 2 == 0 { Some(west.id.clone()) } else { None };
        v.save_host(HostInput { tags, group_id, username: "u".into(), ..host(&format!("node-{i:05}"), None) })
            .await
            .unwrap();
    }

    let started = Instant::now();
    let canaries = v.search_hosts("tag:canary").await.unwrap();
    let in_west = v.search_hosts("group:west node-0001").await.unwrap();
    let both = v.search_hosts("canary europe").await.unwrap();
    let elapsed = started.elapsed();

    assert_eq!(canaries.len(), 100);
    assert_eq!(
        in_west.iter().map(|h| h.label.as_str()).collect::<Vec<_>>(),
        ["node-00010", "node-00012", "node-00014", "node-00016", "node-00018"]
    );
    assert_eq!(both.len(), 100, "every canary index is even, so all are in Europe/West");
    assert_eq!(v.search_hosts("").await.unwrap().len(), 10_000);
    assert_eq!(code(v.search_hosts(&"x".repeat(257)).await), ErrorCode::InvalidInput);
    eprintln!("three searches over 10,000 hosts: {elapsed:?}");
    // Generous bound for a debug build on a shared CI runner; the measured value is printed.
    assert!(elapsed.as_secs_f64() < 3.0, "search took {elapsed:?}");
}

#[tokio::test]
async fn imports_preview_first_then_create_hosts_and_groups_in_one_transaction() {
    use tyrminal_core::contracts::{ImportFormat, ImportHost};
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let existing_root = v.save_group(group("Prod", None)).await.unwrap();
    v.save_host(HostInput { username: "u".into(), ..host("web-1", None) }).await.unwrap();

    let csv = "label,address,port,username,group,tags\n\
               web-1,10.0.0.1,22,deploy,Prod/Web,web\n\
               web-2,10.0.0.2,2222,deploy,Prod/Web,web;canary\n\
               db-1,10.0.0.3,,dba,Prod/DB,\n";
    let preview = v.import_preview(ImportFormat::Csv, csv).await.unwrap();
    assert_eq!(preview.hosts.len(), 3);
    assert_eq!(preview.duplicates, ["web-1"], "an existing label is flagged, not merged");
    assert_eq!(v.list_hosts().await.unwrap().len(), 1, "previewing writes nothing");

    // A host altered after the preview (it came back through the renderer) fails validation
    // and nothing at all is imported.
    let mut tampered = preview.hosts.clone();
    tampered[2].address = "bad host".into();
    assert_eq!(code(v.import_hosts(tampered, None).await), ErrorCode::InvalidInput);
    assert_eq!(v.list_hosts().await.unwrap().len(), 1);
    assert_eq!(v.list_groups().await.unwrap().len(), 1);

    assert_eq!(v.import_hosts(preview.hosts.clone(), None).await.unwrap(), 3);
    let groups = v.list_groups().await.unwrap();
    let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, ["Prod", "DB", "Web"], "the existing Prod group is reused, children created once");
    assert!(
        groups.iter().filter(|g| g.name != "Prod").all(|g| g.parent_id.as_deref() == Some(existing_root.id.as_str()))
    );
    let hosts = v.search_hosts("group:prod/web").await.unwrap();
    assert_eq!(hosts.len(), 2);
    assert!(hosts.iter().all(|h| h.auth == HostAuth::AskPassword));
    assert_eq!(v.search_hosts("tag:canary").await.unwrap()[0].port, 2222);

    // Persisted as one unit.
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(v.list_hosts().await.unwrap().len(), 4);

    // An import into a missing group changes nothing.
    let one = vec![ImportHost {
        label: "x".into(),
        address: "x.example".into(),
        port: 22,
        username: String::new(),
        group: String::new(),
        tags: Vec::new(),
        notes: Vec::new(),
        jump_via: None,
    }];
    assert_eq!(code(v.import_hosts(one, Some("0".repeat(32))).await), ErrorCode::NotFound);
    assert_eq!(v.list_hosts().await.unwrap().len(), 4);
}

/// IMP-02: ProxyJump chains from an OpenSSH config become saved jump hosts, written in the same
/// transaction; a preview that names a missing jump host or forms a loop changes nothing.
#[tokio::test]
async fn proxy_jump_chains_are_imported_as_jump_hosts_and_bad_ones_change_nothing() {
    use tyrminal_core::contracts::{ImportFormat, ImportHost};
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let config = "Host bastion\n  HostName bastion.example\nHost inner\n  HostName 10.0.0.9\n  ProxyJump bastion\n\
                  Host deep\n  HostName 10.0.0.10\n  ProxyJump bastion,inner\nHost edge-only\n  ProxyJump ops@edge.example:2222\n";
    let preview = v.import_preview(ImportFormat::OpensshConfig, config).await.unwrap();
    assert_eq!(v.import_hosts(preview.hosts.clone(), None).await.unwrap(), 5);
    let hosts = v.list_hosts().await.unwrap();
    let id = |label: &str| hosts.iter().find(|h| h.label == label).unwrap().id.clone();
    let chain: Vec<String> = v.host_chain(&id("deep")).await.unwrap().into_iter().map(|h| h.label).collect();
    assert_eq!(chain, ["bastion", "inner", "deep"]);
    let chain: Vec<String> = v.host_chain(&id("edge-only")).await.unwrap().into_iter().map(|h| h.label).collect();
    assert_eq!(chain, ["ops@edge.example:2222", "edge-only"]);
    assert_eq!(v.host_connection(&id("bastion")).await.unwrap().jump_host_id, None);

    // Crafted previews: a jump host outside the import, and a loop. Nothing is written.
    let host = |label: &str, via: Option<&str>| ImportHost {
        label: label.into(),
        address: format!("{label}.example"),
        port: 22,
        username: String::new(),
        group: String::new(),
        tags: Vec::new(),
        notes: Vec::new(),
        jump_via: via.map(Into::into),
    };
    let outside = vec![host("x", Some("bastion"))];
    assert_eq!(code(v.import_hosts(outside, None).await), ErrorCode::InvalidInput);
    let looped = vec![host("a", Some("b")), host("b", Some("a"))];
    assert_eq!(code(v.import_hosts(looped, None).await), ErrorCode::InvalidInput);
    let control = vec![host("c", Some("bad\u{1b}[2J"))];
    assert_eq!(code(v.import_hosts(control, None).await), ErrorCode::InvalidInput);
    assert_eq!(v.list_hosts().await.unwrap().len(), 5);
}

// agent D: inventory and snippets

#[tokio::test]
async fn host_os_is_set_in_bulk_follows_duplicates_and_goes_with_deleted_hosts() {
    use tyrminal_core::contracts::HostOs;
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let a = v.save_host(host("web-1", None)).await.unwrap();
    let b = v.save_host(host("web-2", None)).await.unwrap();
    let c = v.save_host(host("win-1", None)).await.unwrap();

    // All or nothing: one unknown host refuses the whole change.
    let missing = "0".repeat(32);
    assert_eq!(code(v.set_host_os(&[a.id.clone(), missing], Some(HostOs::Debian)).await), ErrorCode::NotFound);
    assert!(v.list_host_appearances().await.unwrap().is_empty());
    assert_eq!(code(v.set_host_os(&["../etc".into()], Some(HostOs::Debian)).await), ErrorCode::InvalidInput);

    assert_eq!(v.set_host_os(&[a.id.clone(), b.id.clone(), a.id.clone()], Some(HostOs::Debian)).await.unwrap(), 2);
    assert_eq!(v.set_host_os(std::slice::from_ref(&c.id), Some(HostOs::Windows)).await.unwrap(), 1);
    // Setting the same value again changes nothing.
    assert_eq!(v.set_host_os(std::slice::from_ref(&a.id), Some(HostOs::Debian)).await.unwrap(), 0);
    assert_eq!(v.set_host_os(std::slice::from_ref(&b.id), None).await.unwrap(), 1);

    let copy = v.duplicate_host(&c.id).await.unwrap();
    let os_of = |list: &[tyrminal_core::contracts::HostAppearance], id: &str| {
        list.iter().find(|x| x.host_id == id).map(|x| x.os)
    };
    let list = v.list_host_appearances().await.unwrap();
    assert_eq!(os_of(&list, &a.id), Some(HostOs::Debian));
    assert_eq!(os_of(&list, &b.id), None);
    assert_eq!(os_of(&list, &copy.id), Some(HostOs::Windows));

    // Deleting hosts deletes their appearance in the same transaction, single and in bulk.
    v.delete_host(&a.id).await.unwrap();
    v.bulk_update_hosts(std::slice::from_ref(&c.id), BulkHostChange::Delete).await.unwrap();
    let list = v.list_host_appearances().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(os_of(&list, &copy.id), Some(HostOs::Windows));

    // Survives a fresh process opening the same file.
    drop(core);
    let reopened = Core::open(&dir.path().join("vault.db")).unwrap();
    reopened.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let list = reopened.vault.list_host_appearances().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(os_of(&list, &copy.id), Some(HostOs::Windows));
}

/// A fixture from `tests/fixtures/import`, decoded the way the import dialog does (UTF-16 with a
/// byte-order mark, as regedit writes, or UTF-8).
fn fixture(name: &str) -> String {
    let bytes = std::fs::read(format!("{}/../../tests/fixtures/import/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    match bytes.as_slice() {
        [0xff, 0xfe, rest @ ..] => {
            String::from_utf16(&rest.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).unwrap()
        }
        _ => String::from_utf8(bytes).unwrap(),
    }
}

#[tokio::test]
async fn putty_mobaxterm_and_securecrt_exports_preview_then_import_in_one_transaction() {
    use tyrminal_core::contracts::ImportFormat;
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let labels =
        |hosts: &[tyrminal_core::contracts::ImportHost]| hosts.iter().map(|h| h.label.clone()).collect::<Vec<_>>();

    let putty = v.import_preview(ImportFormat::PuttyReg, &fixture("putty-sessions.reg")).await.unwrap();
    assert_eq!(labels(&putty.hosts), ["prod web 1", "bastion"]);
    assert_eq!((putty.hosts[1].username.as_str(), putty.hosts[1].port), ("ops", 2222));
    assert!(putty.hosts[0].notes.iter().any(|n| n.contains("prod-web.ppk")));
    assert!(putty.hosts[1].notes.iter().any(|n| n.contains("proxy")));
    // Telnet, serial and PuTTY's defaults are listed as left out, never silently dropped.
    assert_eq!(putty.skipped.len(), 3, "{:?}", putty.skipped);

    let moba = v.import_preview(ImportFormat::Mobaxterm, &fixture("mobaxterm-sessions.mxtsessions")).await.unwrap();
    assert_eq!(labels(&moba.hosts), ["jump host", "db primary", "db files", "pi"]);
    assert_eq!(moba.hosts[1].group, "Production/Databases");
    assert!(!format!("{moba:?}").contains("synthetic-encrypted"), "stored passwords never reach the preview");

    let crt = v.import_preview(ImportFormat::Securecrt, &fixture("securecrt-export.xml")).await.unwrap();
    assert_eq!(labels(&crt.hosts), ["api-eu-1", "nas"]);
    assert_eq!(crt.hosts[0].group, "Production/EU & UK");
    assert_eq!((crt.hosts[1].username.as_str(), crt.hosts[1].address.as_str()), ("admin", "nas.lab.example"));
    assert!(!format!("{crt:?}").contains("NOTAREALPASSWORD"));

    // Previews write nothing; the import creates hosts and missing groups together.
    assert!(v.list_hosts().await.unwrap().is_empty());
    assert_eq!(v.import_hosts(moba.hosts.clone(), None).await.unwrap(), 4);
    assert_eq!(v.import_hosts(crt.hosts, None).await.unwrap(), 2);
    let groups = v.list_groups().await.unwrap();
    let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    for name in ["Production", "Databases", "Lab", "EU & UK"] {
        assert_eq!(names.iter().filter(|n| **n == name).count(), 1, "{name} once: {names:?}");
    }
    // A preview that went bad on the way back is refused as a whole.
    let mut tampered = putty.hosts.clone();
    tampered[1].address = "evil host; rm -rf /".into();
    assert_eq!(code(v.import_hosts(tampered, None).await), ErrorCode::InvalidInput);
    assert_eq!(v.list_hosts().await.unwrap().len(), 6);
}

fn key_fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/../../tests/fixtures/keys/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

#[tokio::test]
async fn ecdsa_and_rsa_keys_are_generated_and_putty_keys_import() {
    use tyrminal_core::contracts::{KeyImportInput, KeyKind};
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    for (kind, algorithm) in [
        (KeyKind::EcdsaP256, "ecdsa-sha2-nistp256"),
        (KeyKind::EcdsaP384, "ecdsa-sha2-nistp384"),
        (KeyKind::EcdsaP521, "ecdsa-sha2-nistp521"),
        (KeyKind::Rsa3072, "ssh-rsa"),
    ] {
        let key = v.generate_key_of(&format!("{kind:?}"), kind).await.unwrap();
        assert_eq!(key.algorithm, algorithm);
        assert!(key.public_key.starts_with(algorithm));
    }

    // PuTTY v3, encrypted: refused without the passphrase, stored protected with it.
    let ppk = key_fixture("ecdsa-v3-enc.ppk");
    let input = |passphrase: Option<&str>, remember| KeyImportInput {
        label: "putty".into(),
        private_key: ppk.clone(),
        passphrase: passphrase.map(Into::into),
        remember_passphrase: remember,
    };
    assert_eq!(code(v.import_key(input(None, false)).await), ErrorCode::KeyInvalid);
    assert_eq!(code(v.import_key(input(Some("nope"), false)).await), ErrorCode::WrongCredential);
    let imported = v.import_key(input(Some("fixture passphrase"), false)).await.unwrap();
    assert!(imported.passphrase_protected && !imported.passphrase_stored);
    assert_eq!(imported.algorithm, "ecdsa-sha2-nistp256");
    let v2 = KeyImportInput {
        label: "putty v2".into(),
        private_key: key_fixture("rsa-v2-enc.ppk"),
        passphrase: Some("fixture passphrase".into()),
        remember_passphrase: true,
    };
    assert!(v.import_key(v2).await.unwrap().passphrase_stored);
    let plain = KeyImportInput {
        label: "putty plain".into(),
        private_key: key_fixture("ed25519-v3.ppk"),
        passphrase: None,
        remember_passphrase: false,
    };
    assert!(!v.import_key(plain).await.unwrap().passphrase_protected);
}

/// Signs `public_key` with a fresh CA using the real `ssh-keygen`; returns (certificate, CA key).
fn sign_with_ssh_keygen(dir: &std::path::Path, public_key: &str, cert_type_host: bool, validity: &str) -> String {
    use std::process::Command;
    let ca = dir.join("ca");
    if !ca.exists() {
        let ok = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "synthetic-ca", "-f"])
            .arg(&ca)
            .status()
            .unwrap();
        assert!(ok.success());
    }
    let user = dir.join("user.pub");
    std::fs::write(&user, format!("{public_key}\n")).unwrap();
    let mut cmd = Command::new("ssh-keygen");
    cmd.args(["-q", "-s"]).arg(&ca).args(["-I", "synthetic-user", "-n", "tyr", "-V", validity]);
    if cert_type_host {
        cmd.arg("-h");
    }
    assert!(cmd.arg(&user).status().unwrap().success());
    std::fs::read_to_string(dir.join("user-cert.pub")).unwrap()
}

#[tokio::test]
async fn certificates_attach_only_to_their_key_and_go_with_it() {
    use tyrminal_core::contracts::{KeyImportInput, KeyKind};
    let dir = TempDir::new().unwrap();
    let work = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v.generate_key_of("certified", KeyKind::Ed25519).await.unwrap();
    let other = v.generate_key("other").await.unwrap();
    // The summary's public key ends with the label; the key itself is the first two fields.
    let public: String = key.public_key.split(' ').take(2).collect::<Vec<_>>().join(" ");

    let cert = sign_with_ssh_keygen(work.path(), &public, false, "-5m:+1h");
    assert_eq!(code(v.attach_key_certificate(&other.id, &cert).await), ErrorCode::KeyInvalid);
    assert_eq!(
        code(v.attach_key_certificate(&key.id, "ssh-ed25519-cert-v01@openssh.com AAAA").await),
        ErrorCode::KeyInvalid
    );
    let host_cert = sign_with_ssh_keygen(work.path(), &public, true, "-5m:+1h");
    assert_eq!(code(v.attach_key_certificate(&key.id, &host_cert).await), ErrorCode::KeyInvalid);
    let expired = sign_with_ssh_keygen(work.path(), &public, false, "20200101:20200102");
    assert_eq!(code(v.attach_key_certificate(&key.id, &expired).await), ErrorCode::KeyInvalid);
    assert!(v.list_key_certificates().await.unwrap().is_empty());

    let attached = v.attach_key_certificate(&key.id, &cert).await.unwrap();
    assert_eq!(attached.principals, ["tyr"]);
    assert_eq!(attached.cert_key_id, "synthetic-user");
    assert_eq!(attached.algorithm, "ssh-ed25519-cert-v01@openssh.com");
    // Replacing keeps one certificate per key.
    v.attach_key_certificate(&key.id, &sign_with_ssh_keygen(work.path(), &public, false, "-5m:+2h")).await.unwrap();
    assert_eq!(v.list_key_certificates().await.unwrap().len(), 1);

    // An encrypted key takes a certificate without its passphrase (checked against the public key).
    let ppk = v
        .import_key(KeyImportInput {
            label: "putty".into(),
            private_key: key_fixture("ecdsa-v3-enc.ppk"),
            passphrase: Some("fixture passphrase".into()),
            remember_passphrase: false,
        })
        .await
        .unwrap();
    let ppk_public: String = ppk.public_key.split(' ').take(2).collect::<Vec<_>>().join(" ");
    v.attach_key_certificate(&ppk.id, &sign_with_ssh_keygen(work.path(), &ppk_public, false, "-5m:+1h")).await.unwrap();

    // Deleting a key deletes its certificate in the same transaction; it survives a reopen.
    v.delete_key(&key.id).await.unwrap();
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let left = v.list_key_certificates().await.unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].key_id, ppk.id);
    v.remove_key_certificate(&ppk.id).await.unwrap();
    assert!(v.list_key_certificates().await.unwrap().is_empty());
    assert_eq!(code(v.remove_key_certificate(&ppk.id).await), ErrorCode::NotFound);
}

#[tokio::test]
async fn execution_targets_keep_existing_hosts_and_snippets_move_copy_and_rename_folders() {
    use tyrminal_core::contracts::{ExecutionTargetInput, SnippetInput};
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let a = v.save_host(host("a", None)).await.unwrap();
    let b = v.save_host(host("b", None)).await.unwrap();
    let target = |hosts: Vec<String>| ExecutionTargetInput { id: None, name: "web fleet".into(), host_ids: hosts };
    assert_eq!(code(v.save_execution_target(target(vec![])).await), ErrorCode::InvalidInput);
    assert_eq!(code(v.save_execution_target(target(vec!["0".repeat(32)])).await), ErrorCode::NotFound);
    let saved = v.save_execution_target(target(vec![a.id.clone(), b.id.clone(), a.id.clone()])).await.unwrap();
    assert_eq!(saved.host_ids, [a.id.clone(), b.id.clone()]);
    // A deleted host drops out and is counted as missing; the target itself stays.
    v.delete_host(&b.id).await.unwrap();
    let listed = v.list_execution_targets().await.unwrap();
    assert_eq!((listed[0].host_ids.clone(), listed[0].missing), (vec![a.id.clone()], 1));
    v.delete_execution_target(&saved.id).await.unwrap();
    assert!(v.list_execution_targets().await.unwrap().is_empty());

    let snippet = |name: &str, folder: &str| SnippetInput {
        id: None,
        name: name.into(),
        folder: folder.into(),
        text: "uptime".into(),
    };
    let s1 = v.save_snippet(snippet("one", "Ops")).await.unwrap();
    let s2 = v.save_snippet(snippet("two", "Ops/Deep")).await.unwrap();
    let s3 = v.save_snippet(snippet("three", "Other")).await.unwrap();

    let copies = v.move_snippets(std::slice::from_ref(&s3.id), "Ops", true).await.unwrap();
    assert_eq!(copies[0].folder, "Ops");
    assert_ne!(copies[0].id, s3.id);
    assert_eq!(v.list_snippets().await.unwrap().len(), 4);
    assert_eq!(code(v.move_snippets(&[s1.id.clone(), "0".repeat(32)], "X", false).await), ErrorCode::NotFound);
    assert!(v.list_snippets().await.unwrap().iter().all(|s| s.folder != "X"), "all or nothing");

    // Renaming a folder moves its subfolders along; a folder cannot go inside itself.
    assert_eq!(code(v.rename_snippet_folder("Ops", "Ops/Inner").await), ErrorCode::InvalidInput);
    assert_eq!(v.rename_snippet_folder("Ops", "Team/Ops").await.unwrap(), 3);
    let all = v.list_snippets().await.unwrap();
    let folder_of = |id: &str| all.iter().find(|s| s.id == id).unwrap().folder.clone();
    assert_eq!(folder_of(&s1.id), "Team/Ops");
    assert_eq!(folder_of(&s2.id), "Team/Ops/Deep");
    assert_eq!(folder_of(&s3.id), "Other");
    v.move_snippets(std::slice::from_ref(&s2.id), "", false).await.unwrap();
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(v.list_snippets().await.unwrap().iter().find(|s| s.id == s2.id).unwrap().folder, "");
}

fn identity(label: &str, username: &str, password: SecretChange, key_id: Option<&str>) -> IdentityInput {
    IdentityInput { id: None, label: label.into(), username: username.into(), password, key_id: key_id.map(Into::into) }
}

fn host_target(id: &str) -> SettingsTarget {
    SettingsTarget::Host { host_id: id.into() }
}

fn group_target(id: &str) -> SettingsTarget {
    SettingsTarget::Group { group_id: id.into() }
}

/// KEY-15..17: identities are stored once and referenced; a host's own identity wins, a group's
/// applies to hosts that inherit their sign-in method (nearest group first); the password never
/// comes back out; references go with deleted hosts, groups and identities, all persisted.
#[tokio::test]
async fn identities_are_referenced_inherited_by_group_and_cleaned_up_with_their_users() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v.generate_key("deploy key").await.unwrap();

    // Validation first: something to sign in with, an existing key, a valid secret.
    assert_eq!(code(v.save_identity(identity("empty", "", SecretChange::Keep, None)).await), ErrorCode::InvalidInput);
    assert_eq!(
        code(v.save_identity(identity("x", "ops", SecretChange::Keep, Some("00000000000000000000000000000000"))).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(v.save_identity(identity("x", "ops", SecretChange::Set { value: String::new() }, None)).await),
        ErrorCode::InvalidInput
    );

    let ops = v
        .save_identity(identity("Ops", "ops", SecretChange::Set { value: "hunter2-identity".into() }, None))
        .await
        .unwrap();
    assert!(ops.has_password && ops.key_id.is_none() && ops.used_by == 0);
    let deploy = v.save_identity(identity("Deploy", "deploy", SecretChange::Keep, Some(&key.id))).await.unwrap();
    assert!(!deploy.has_password);
    // The password is write-only: no summary or assignment carries it.
    let listed = format!("{:?}", v.list_identities().await.unwrap());
    assert!(!listed.contains("hunter2-identity"), "{listed}");

    let root = v.save_group(group("prod", None)).await.unwrap();
    let web = v.save_group(group("web", Some(&root.id))).await.unwrap();
    let inherits = v.save_host(host("web1", Some(&web.id))).await.unwrap();
    let own_key = v
        .save_host(HostInput { auth: HostAuthInput::Key { key_id: key.id.clone() }, ..host("web2", Some(&web.id)) })
        .await
        .unwrap();
    let pinned = v.save_host(host("web3", Some(&web.id))).await.unwrap();

    // Unknown targets and identities are refused.
    assert_eq!(
        code(v.set_identity(host_target("00000000000000000000000000000000"), Some(ops.id.clone())).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(v.set_identity(host_target(&inherits.id), Some("00000000000000000000000000000000".into())).await),
        ErrorCode::NotFound
    );

    // A group's identity reaches hosts that inherit their sign-in method, through subgroups.
    let on_root = v.set_identity(group_target(&root.id), Some(ops.id.clone())).await.unwrap();
    assert_eq!(on_root.identity_id.as_deref(), Some(ops.id.as_str()));
    let assignments = v.list_identity_assignments().await.unwrap();
    let of = |id: &str| assignments.iter().find(|a| a.target == host_target(id)).unwrap().clone();
    assert_eq!(of(&inherits.id).effective_identity_id.as_deref(), Some(ops.id.as_str()));
    assert_eq!(of(&inherits.id).origin, Some(SettingOrigin::Group { group_id: root.id.clone(), name: "prod".into() }));
    // A host with its own sign-in method keeps it.
    assert_eq!(of(&own_key.id).effective_identity_id, None);

    // The nearest group wins; the host's own identity wins over every group.
    v.set_identity(group_target(&web.id), Some(deploy.id.clone())).await.unwrap();
    let pinned_now = v.set_identity(host_target(&pinned.id), Some(ops.id.clone())).await.unwrap();
    assert_eq!(
        (pinned_now.effective_identity_id.as_deref(), pinned_now.origin),
        (Some(ops.id.as_str()), Some(SettingOrigin::Host))
    );
    let assignments = v.list_identity_assignments().await.unwrap();
    let of = |id: &str| assignments.iter().find(|a| a.target == host_target(id)).unwrap().clone();
    assert_eq!(of(&inherits.id).effective_identity_id.as_deref(), Some(deploy.id.as_str()));
    assert_eq!(of(&inherits.id).origin, Some(SettingOrigin::Group { group_id: web.id.clone(), name: "web".into() }));

    // A key an identity uses cannot be deleted from under it.
    assert_eq!(code(v.delete_key(&key.id).await), ErrorCode::InUse);

    // Duplicating a host keeps its identity; deleting hosts and groups takes their references.
    let copy = v.duplicate_host(&pinned.id).await.unwrap();
    let uses = |list: &[tyrminal_core::contracts::IdentitySummary], id: &str| {
        list.iter().find(|i| i.id == id).unwrap().used_by
    };
    assert_eq!(uses(&v.list_identities().await.unwrap(), &ops.id), 3, "root group, pinned host and its copy");
    v.delete_host(&copy.id).await.unwrap();
    v.bulk_update_hosts(std::slice::from_ref(&pinned.id), BulkHostChange::Delete).await.unwrap();
    assert_eq!(uses(&v.list_identities().await.unwrap(), &ops.id), 1);

    // Editing an identity keeps its password unless asked; every user follows the change.
    let edited = v
        .save_identity(IdentityInput {
            id: Some(deploy.id.clone()),
            ..identity("Deploy", "release", SecretChange::Keep, Some(&key.id))
        })
        .await
        .unwrap();
    assert_eq!((edited.username.as_str(), edited.used_by), ("release", 1));
    let kept = v
        .save_identity(IdentityInput { id: Some(ops.id.clone()), ..identity("Ops", "ops", SecretChange::Keep, None) })
        .await
        .unwrap();
    assert!(kept.has_password);

    // Deleting an identity clears its references in the same transaction; hosts fall back.
    assert_eq!(v.delete_identity(&deploy.id).await.unwrap(), 1);
    let assignments = v.list_identity_assignments().await.unwrap();
    let of = |id: &str| assignments.iter().find(|a| a.target == host_target(id)).unwrap().clone();
    assert_eq!(
        of(&inherits.id).effective_identity_id.as_deref(),
        Some(ops.id.as_str()),
        "falls back to the root group"
    );

    // Everything above survives a restart (no stale references, no lost ones).
    v.delete_host(&inherits.id).await.unwrap();
    v.delete_host(&own_key.id).await.unwrap();
    v.delete_key(&key.id).await.unwrap();
    v.delete_group(&web.id).await.unwrap();
    drop(core);
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let list = core.vault.list_identities().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].used_by, list[0].has_password), (1, true));
    core.vault.delete_group(&root.id).await.unwrap();
    assert_eq!(core.vault.list_identities().await.unwrap()[0].used_by, 0);
    assert!(core.vault.list_identity_assignments().await.unwrap().is_empty());
}

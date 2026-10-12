//! Host inventory against a real vault (Phase 04): nested groups with inherited settings, tags,
//! search, duplication and bulk changes.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Instant;

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    BulkHostChange, ErrorCode, GroupInput, HostAuth, HostAuthInput, HostInput, InheritedFields, IpcError,
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
    }];
    assert_eq!(code(v.import_hosts(one, Some("0".repeat(32))).await), ErrorCode::NotFound);
    assert_eq!(v.list_hosts().await.unwrap().len(), 4);
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

//! Reusable identities against a real vault (KEY-15..17): validation, references that never
//! dangle, edits that reach every host and group using the identity, and persistence.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    ErrorCode, GroupInput, HostAuth, HostAuthInput, HostInput, IdentityInput, IdentityPasswordInput, IpcError,
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

fn identity(label: &str, username: &str, password: IdentityPasswordInput, key_id: Option<&str>) -> IdentityInput {
    IdentityInput { id: None, label: label.into(), username: username.into(), password, key_id: key_id.map(Into::into) }
}

fn set(password: &str) -> IdentityPasswordInput {
    IdentityPasswordInput::Set { password: password.into() }
}

fn group(name: &str) -> GroupInput {
    GroupInput {
        id: None,
        name: name.into(),
        parent_id: None,
        username: None,
        port: None,
        key_id: None,
        identity_id: None,
    }
}

fn host(label: &str, auth: HostAuthInput, group: Option<&str>) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{label}.example"),
        port: None,
        username: String::new(),
        auth,
        group_id: group.map(Into::into),
        tags: Vec::new(),
    }
}

#[tokio::test]
async fn invalid_identities_and_dangling_references_are_refused() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let missing = "00".repeat(16);

    assert_eq!(
        code(v.save_identity(identity("", "u", IdentityPasswordInput::Keep, None)).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(v.save_identity(identity("bidi \u{202e}txt", "u", IdentityPasswordInput::Keep, None)).await),
        ErrorCode::InvalidInput,
        "labels are validated like host labels"
    );
    assert_eq!(
        code(v.save_identity(identity("x", "two words", IdentityPasswordInput::Keep, None)).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(v.save_identity(identity("x", "-oProxyCommand", IdentityPasswordInput::Keep, None)).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(code(v.save_identity(identity("x", "u", set(""), None)).await), ErrorCode::InvalidInput);
    assert_eq!(code(v.save_identity(identity("x", "u", set(&"p".repeat(1025)), None)).await), ErrorCode::InvalidInput);
    assert_eq!(
        code(v.save_identity(identity("x", "u", IdentityPasswordInput::Keep, Some(&missing))).await),
        ErrorCode::NotFound,
        "an identity cannot reference a key that does not exist"
    );
    assert_eq!(
        code(v.save_identity(identity("x", "u", IdentityPasswordInput::Keep, Some("../etc"))).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(
            v.save_identity(IdentityInput {
                id: Some(missing.clone()),
                ..identity("x", "", IdentityPasswordInput::Keep, None)
            })
            .await
        ),
        ErrorCode::NotFound
    );
    assert!(v.list_identities().await.unwrap().is_empty(), "nothing was stored by a refused save");

    let host_auth = HostAuthInput::Identity { identity_id: missing.clone() };
    assert_eq!(code(v.save_host(host("h", host_auth, None)).await), ErrorCode::NotFound);
    assert_eq!(
        code(v.save_group(GroupInput { identity_id: Some(missing.clone()), ..group("g") }).await),
        ErrorCode::NotFound
    );

    // A group gives its hosts a key or an identity, never both.
    let key = v.generate_key("k").await.unwrap();
    let ops = v.save_identity(identity("ops", "", IdentityPasswordInput::Keep, None)).await.unwrap();
    assert_eq!(
        code(
            v.save_group(GroupInput { key_id: Some(key.id.clone()), identity_id: Some(ops.id.clone()), ..group("g") })
                .await
        ),
        ErrorCode::InvalidInput
    );
}

#[tokio::test]
async fn hosts_and_groups_pick_up_identity_changes() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v.generate_key("deploy key").await.unwrap();
    let ops = v.save_identity(identity("Ops", "ops", set("s3cret"), None)).await.unwrap();
    assert!(ops.has_password && ops.key_id.is_none());
    assert_eq!((ops.used_by_hosts, ops.used_by_groups), (0, 0));

    // KEY-17: a host chooses the identity; a group gives it to the hosts that inherit.
    let direct =
        v.save_host(host("direct", HostAuthInput::Identity { identity_id: ops.id.clone() }, None)).await.unwrap();
    assert_eq!(direct.auth, HostAuth::Identity { identity_id: ops.id.clone() });
    assert_eq!(direct.username, "ops");
    assert!(!direct.inherited.username, "the host's own identity is not a group value");
    let fleet = v.save_group(GroupInput { identity_id: Some(ops.id.clone()), ..group("Fleet") }).await.unwrap();
    assert_eq!(fleet.identity_id.as_deref(), Some(ops.id.as_str()));
    let member = v.save_host(host("member", HostAuthInput::Inherit, Some(&fleet.id))).await.unwrap();
    assert_eq!(member.auth, HostAuth::Identity { identity_id: ops.id.clone() });
    assert_eq!(member.username, "ops");
    assert!(member.inherited.auth && member.inherited.username);
    let own_name = v
        .save_host(HostInput { username: "me".into(), ..host("own", HostAuthInput::Inherit, Some(&fleet.id)) })
        .await
        .unwrap();
    assert_eq!(own_name.username, "me", "a host's own user name wins over the identity's");

    let listed = v.list_identities().await.unwrap();
    assert_eq!((listed[0].used_by_hosts, listed[0].used_by_groups), (1, 1));

    // KEY-16: edit the identity once; every host using it changes, the password is kept.
    let edited = v
        .save_identity(IdentityInput {
            id: Some(ops.id.clone()),
            ..identity("Ops", "operator", IdentityPasswordInput::Keep, Some(&key.id))
        })
        .await
        .unwrap();
    assert!(edited.has_password, "Keep keeps the stored password");
    assert_eq!(edited.key_id.as_deref(), Some(key.id.as_str()));
    let hosts = v.list_hosts().await.unwrap();
    let user_of = |label: &str| hosts.iter().find(|h| h.label == label).unwrap().username.clone();
    assert_eq!(user_of("direct"), "operator");
    assert_eq!(user_of("member"), "operator");
    assert_eq!(user_of("own"), "me");

    let cleared = v
        .save_identity(IdentityInput {
            id: Some(ops.id.clone()),
            ..identity("Ops", "", IdentityPasswordInput::Clear, None)
        })
        .await
        .unwrap();
    assert!(!cleared.has_password && cleared.key_id.is_none() && cleared.username.is_empty());
    let hosts = v.list_hosts().await.unwrap();
    assert_eq!(hosts.iter().find(|h| h.label == "member").unwrap().username, "", "nothing left to inherit");

    // Identities survive a lock and unlock (they are vault records, encrypted like the rest).
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let after = v.list_identities().await.unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].label, "Ops");
    let member = v.list_hosts().await.unwrap().into_iter().find(|h| h.label == "member").unwrap();
    assert_eq!(member.auth, HostAuth::Identity { identity_id: ops.id.clone() });
}

#[tokio::test]
async fn an_identity_in_use_is_never_deleted_or_left_without_its_key() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v.generate_key("k").await.unwrap();
    let ops = v.save_identity(identity("Ops", "ops", IdentityPasswordInput::Keep, Some(&key.id))).await.unwrap();

    assert_eq!(code(v.delete_key(&key.id).await), ErrorCode::InUse, "the identity still uses the key");

    let h = v.save_host(host("h", HostAuthInput::Identity { identity_id: ops.id.clone() }, None)).await.unwrap();
    let g = v.save_group(GroupInput { identity_id: Some(ops.id.clone()), ..group("G") }).await.unwrap();
    assert_eq!(code(v.delete_identity(&ops.id).await), ErrorCode::InUse);

    // Reassign the host; the group still holds it.
    v.save_host(HostInput { id: Some(h.id.clone()), ..host("h", HostAuthInput::AskPassword, None) }).await.unwrap();
    assert_eq!(code(v.delete_identity(&ops.id).await), ErrorCode::InUse);
    v.save_group(GroupInput { id: Some(g.id.clone()), ..group("G") }).await.unwrap();
    v.delete_identity(&ops.id).await.unwrap();
    assert!(v.list_identities().await.unwrap().is_empty());
    assert_eq!(code(v.delete_identity(&ops.id).await), ErrorCode::NotFound);
    v.delete_key(&key.id).await.unwrap();

    // Gone after a reload too: the tombstone was written, not just the memory entry dropped.
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert!(v.list_identities().await.unwrap().is_empty());
}

#[tokio::test]
async fn identities_need_an_unlocked_vault() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    core.vault.lock().await;
    assert_eq!(code(core.vault.list_identities().await), ErrorCode::VaultLocked);
    assert_eq!(
        code(core.vault.save_identity(identity("x", "", IdentityPasswordInput::Keep, None)).await),
        ErrorCode::VaultLocked
    );
}

//! Group defaults for route and appearance against a real vault (HST-05): hosts inherit their
//! nearest group's jump host and proxy as one route and its OS icon, their own settings win, a
//! jump host is never its own jump host, and a change that would make a loop writes nothing.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    ErrorCode, GroupDefaultsInput, GroupInput, HostAuthInput, HostConnectionInput, HostInput, HostOs, HostProtocol,
    IpcError, ProxyInput, ProxyType, SettingOrigin,
};

const PASSPHRASE: &str = "correct horse battery staple";

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
        production: false,
    }
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
        production: false,
    }
}

fn proxy(password: Option<&str>) -> ProxyInput {
    ProxyInput {
        kind: ProxyType::Socks5,
        host: "proxy.lab.example".into(),
        port: 1080,
        username: "ops".into(),
        password: password.map(Into::into),
    }
}

fn defaults(jump: Option<&str>, proxy: Option<ProxyInput>, os: Option<HostOs>) -> GroupDefaultsInput {
    GroupDefaultsInput { jump_host_id: jump.map(Into::into), proxy, os }
}

async fn chain(core: &Core, host_id: &str) -> Vec<String> {
    core.vault.host_chain(host_id).await.unwrap().into_iter().map(|h| h.label).collect()
}

#[tokio::test]
async fn hosts_use_their_nearest_groups_route_and_icon_unless_they_set_their_own() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("vault.db");
    let core = Core::open(&path).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let v = &core.vault;
    let edge = v.save_group(group("Edge", None)).await.unwrap();
    let internal = v.save_group(group("Internal", None)).await.unwrap();
    let db = v.save_group(group("DB", Some(&internal.id))).await.unwrap();
    let bastion = v.save_host(host("bastion", Some(&edge.id))).await.unwrap();
    let app = v.save_host(host("app", Some(&internal.id))).await.unwrap();
    let pg = v.save_host(host("pg", Some(&db.id))).await.unwrap();

    // Internal goes through bastion; its subgroup DB inherits that, and so do their hosts.
    let saved =
        v.set_group_defaults(&internal.id, defaults(Some(&bastion.id), None, Some(HostOs::Debian))).await.unwrap();
    assert_eq!(saved.jump_host_id.as_deref(), Some(bastion.id.as_str()));
    assert_eq!(chain(&core, &app.id).await, ["bastion", "app"]);
    assert_eq!(chain(&core, &pg.id).await, ["bastion", "pg"]);
    let connection = v.host_connection(&pg.id).await.unwrap();
    assert!(!connection.own);
    let inherited = connection.inherited.unwrap();
    assert_eq!(inherited.jump_host_id.as_deref(), Some(bastion.id.as_str()));
    assert_eq!(inherited.origin, SettingOrigin::Group { group_id: internal.id.clone(), name: "Internal".into() });
    let db_defaults = v.group_defaults(&db.id).await.unwrap();
    assert_eq!(db_defaults.jump_host_id, None);
    assert_eq!(db_defaults.inherited_route.unwrap().origin, inherited.origin);
    assert_eq!(db_defaults.inherited_os.unwrap().0, HostOs::Debian);

    // A nearer group that sets a route (here a proxy only) replaces the whole route.
    v.set_group_defaults(&db.id, defaults(None, Some(proxy(Some("canary-group-proxy"))), Some(HostOs::Alpine)))
        .await
        .unwrap();
    assert_eq!(chain(&core, &pg.id).await, ["pg"], "a proxy-only route connects directly");
    let pg_route = v.host_connection(&pg.id).await.unwrap().inherited.unwrap();
    assert_eq!(pg_route.proxy.as_ref().map(|p| (p.port, p.password_stored)), Some((1080, true)));
    // Saving again without a password keeps the stored one.
    v.set_group_defaults(&db.id, defaults(None, Some(proxy(None)), Some(HostOs::Alpine))).await.unwrap();
    assert!(v.group_defaults(&db.id).await.unwrap().proxy.unwrap().password_stored);

    // The icon: own beats the nearest group's, which beats a parent's.
    v.set_host_os(std::slice::from_ref(&app.id), Some(HostOs::Ubuntu)).await.unwrap();
    let icons = v.list_host_appearances().await.unwrap();
    let icon = |id: &str| icons.iter().find(|a| a.host_id == id).map(|a| (a.os, a.inherited));
    assert_eq!(icon(&app.id), Some((HostOs::Ubuntu, false)));
    assert_eq!(icon(&pg.id), Some((HostOs::Alpine, true)));
    assert_eq!(icon(&bastion.id), None);

    // A host's own route wins; asking to inherit again restores the group's.
    let direct =
        HostConnectionInput { jump_host_id: None, proxy: None, inherit: false, key_exchange: Default::default() };
    v.set_host_connection(&app.id, direct).await.unwrap();
    assert!(v.host_connection(&app.id).await.unwrap().own);
    assert_eq!(chain(&core, &app.id).await, ["app"], "set here: connect directly");
    let inherit =
        HostConnectionInput { jump_host_id: None, proxy: None, inherit: true, key_exchange: Default::default() };
    assert_eq!(
        v.set_host_connection(&app.id, inherit).await.unwrap().into_iter().map(|h| h.label).collect::<Vec<_>>(),
        ["bastion", "app"]
    );

    // A jump host inside the group that uses it connects directly, not through itself.
    let jumpbox = v.save_host(host("jumpbox", Some(&internal.id))).await.unwrap();
    v.set_group_defaults(&internal.id, defaults(Some(&jumpbox.id), None, None)).await.unwrap();
    assert_eq!(chain(&core, &jumpbox.id).await, ["jumpbox"]);
    assert_eq!(chain(&core, &app.id).await, ["jumpbox", "app"]);

    // Persisted encrypted (the proxy password included) and read back after a fresh open.
    v.lock().await;
    drop(core);
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.windows(18).any(|w| w == b"canary-group-proxy"), "the proxy password is encrypted at rest");
    let core = Core::open(&path).unwrap();
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(chain(&core, &app.id).await, ["jumpbox", "app"]);
    assert!(core.vault.group_defaults(&db.id).await.unwrap().proxy.unwrap().password_stored);
}

#[tokio::test]
async fn group_defaults_that_would_loop_or_point_nowhere_are_refused_and_nothing_changes() {
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let v = &core.vault;
    let a_group = v.save_group(group("A", None)).await.unwrap();
    let b_group = v.save_group(group("B", None)).await.unwrap();
    let a = v.save_host(host("a", Some(&a_group.id))).await.unwrap();
    let b = v.save_host(host("b", Some(&b_group.id))).await.unwrap();

    // Hosts in A go through b; making hosts in B go through a would loop a -> b -> a.
    v.set_group_defaults(&a_group.id, defaults(Some(&b.id), None, None)).await.unwrap();
    assert_eq!(
        code(v.set_group_defaults(&b_group.id, defaults(Some(&a.id), None, None)).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(v.group_defaults(&b_group.id).await.unwrap().jump_host_id, None, "nothing was written");
    assert_eq!(chain(&core, &a.id).await, ["b", "a"]);

    // A host's own setting cannot loop through an inherited route either.
    let looped = HostConnectionInput {
        jump_host_id: Some(a.id.clone()),
        proxy: None,
        inherit: false,
        key_exchange: Default::default(),
    };
    assert_eq!(code(v.set_host_connection(&b.id, looped).await), ErrorCode::InvalidInput);

    // Unknown jump host, unknown group, bad id, bad proxy, locked.
    assert_eq!(
        code(v.set_group_defaults(&a_group.id, defaults(Some(&"0".repeat(32)), None, None)).await),
        ErrorCode::NotFound
    );
    assert_eq!(code(v.set_group_defaults(&"1".repeat(32), defaults(None, None, None)).await), ErrorCode::NotFound);
    assert_eq!(code(v.group_defaults("../etc").await), ErrorCode::InvalidInput);
    let bad_proxy = ProxyInput { host: "bad host".into(), ..proxy(Some("x")) };
    assert_eq!(
        code(v.set_group_defaults(&a_group.id, defaults(None, Some(bad_proxy), None)).await),
        ErrorCode::InvalidInput
    );
    assert_eq!(chain(&core, &a.id).await, ["b", "a"], "still unchanged");
    v.lock().await;
    assert_eq!(code(v.group_defaults(&a_group.id).await), ErrorCode::VaultLocked);
    assert_eq!(code(v.set_group_defaults(&a_group.id, defaults(None, None, None)).await), ErrorCode::VaultLocked);
}

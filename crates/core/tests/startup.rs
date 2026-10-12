//! Startup snippets of hosts and groups against a real vault (SNP-08): validation, inheritance,
//! persistence, deleted snippets, and that they live beside (not instead of) other host settings.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    EnvVar, ErrorCode, GroupInput, HostAuthInput, HostInput, HostProtocol, IpcError, SettingOrigin, SettingsTarget,
    SnippetInput,
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

async fn snippet(core: &Core, name: &str) -> String {
    let input = SnippetInput { id: None, name: name.into(), folder: String::new(), text: format!("echo {name}") };
    core.vault.save_snippet(input).await.unwrap().id
}

#[tokio::test]
async fn startup_lists_inherit_whole_persist_and_report_deleted_snippets() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("vault.db");
    let core = Core::open(&path).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let v = &core.vault;
    let prompt = snippet(&core, "prompt").await;
    let status = snippet(&core, "status").await;
    let root = v.save_group(group("Prod", None)).await.unwrap();
    let child = v.save_group(group("DB", Some(&root.id))).await.unwrap();
    let h = v.save_host(host("db-1", Some(&child.id))).await.unwrap();
    let other = v.save_host(host("db-2", Some(&child.id))).await.unwrap();
    let root_target = SettingsTarget::Group { group_id: root.id.clone() };
    let host_target = SettingsTarget::Host { host_id: h.id.clone() };

    // Nothing set anywhere.
    let none = v.effective_startup_snippets(&h.id).await.unwrap();
    assert!(none.snippets.is_empty() && none.origin.is_none());

    // The root group's list reaches hosts two levels down, in order.
    v.set_startup_snippets(root_target.clone(), Some(vec![prompt.clone(), status.clone()])).await.unwrap();
    let inherited = v.effective_startup_snippets(&h.id).await.unwrap();
    let names: Vec<_> = inherited.snippets.iter().map(|s| s.name.as_deref()).collect();
    assert_eq!(names, [Some("prompt"), Some("status")]);
    assert_eq!(inherited.origin, Some(SettingOrigin::Group { group_id: root.id.clone(), name: "Prod".into() }));

    // A host's own list replaces the group's entirely; an empty one opts out.
    v.set_startup_snippets(host_target.clone(), Some(vec![status.clone()])).await.unwrap();
    let own = v.effective_startup_snippets(&h.id).await.unwrap();
    assert_eq!(own.snippets.len(), 1);
    assert_eq!(own.origin, Some(SettingOrigin::Host));
    v.set_startup_snippets(SettingsTarget::Host { host_id: other.id.clone() }, Some(Vec::new())).await.unwrap();
    let quiet = v.effective_startup_snippets(&other.id).await.unwrap();
    assert!(quiet.snippets.is_empty());
    assert_eq!(quiet.origin, Some(SettingOrigin::Host));

    // Startup lives beside the host's variables: setting one keeps the other.
    let vars = vec![EnvVar { name: "TYR_APP".into(), value: "orders".into() }];
    v.set_env_vars(host_target.clone(), vars.clone()).await.unwrap();
    assert_eq!(v.startup_snippets(host_target.clone()).await.unwrap(), Some(vec![status.clone()]));
    v.set_startup_snippets(host_target.clone(), None).await.unwrap();
    assert_eq!(v.env_vars(host_target.clone()).await.unwrap(), vars);
    assert_eq!(v.startup_snippets(host_target.clone()).await.unwrap(), None);
    assert_eq!(v.effective_startup_snippets(&h.id).await.unwrap(), inherited);

    // Editing the group in its own editor keeps its list.
    v.save_group(GroupInput { id: Some(root.id.clone()), username: Some("ops".into()), ..group("Prod", None) })
        .await
        .unwrap();
    assert_eq!(v.effective_startup_snippets(&h.id).await.unwrap(), inherited);

    // A snippet deleted later is shown without a name (and skipped when connecting).
    v.delete_snippet(&status).await.unwrap();
    let after = v.effective_startup_snippets(&h.id).await.unwrap();
    assert_eq!(after.snippets[1].name, None);

    // Encrypted at rest and read back after a fresh open.
    v.lock().await;
    drop(core);
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.windows(prompt.len()).any(|w| w == prompt.as_bytes()), "snippet ids are inside encrypted records");
    let reopened = Core::open(&path).unwrap();
    reopened.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(reopened.vault.effective_startup_snippets(&h.id).await.unwrap(), after);
}

#[tokio::test]
async fn invalid_startup_lists_are_refused_and_nothing_changes() {
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let v = &core.vault;
    let one = snippet(&core, "one").await;
    let h = v.save_host(host("web-1", None)).await.unwrap();
    let target = SettingsTarget::Host { host_id: h.id.clone() };
    v.set_startup_snippets(target.clone(), Some(vec![one.clone()])).await.unwrap();

    let many: Vec<String> = (0..17).map(|i| format!("{i:032x}")).collect();
    for bad in [vec![one.clone(), one.clone()], vec!["not an id".to_owned()], many] {
        assert_eq!(code(v.set_startup_snippets(target.clone(), Some(bad)).await), ErrorCode::InvalidInput);
    }
    // A snippet that does not exist is refused, not stored as a dangling reference.
    assert_eq!(code(v.set_startup_snippets(target.clone(), Some(vec!["0".repeat(32)])).await), ErrorCode::NotFound);
    let nobody = SettingsTarget::Group { group_id: "1".repeat(32) };
    assert_eq!(code(v.set_startup_snippets(nobody, None).await), ErrorCode::NotFound);
    assert_eq!(v.startup_snippets(target.clone()).await.unwrap(), Some(vec![one]));

    v.lock().await;
    assert_eq!(code(v.startup_snippets(target.clone()).await), ErrorCode::VaultLocked);
    assert_eq!(code(v.set_startup_snippets(target, None).await), ErrorCode::VaultLocked);
    assert_eq!(code(v.effective_startup_snippets(&h.id).await), ErrorCode::VaultLocked);
}

//! Layout templates (WSP-08, WSP-09, WSP-11) against real vault files: encrypted records that
//! persist, validated natively, refused while locked, and never pointing at an unsaved host.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    ErrorCode, HostAuthInput, HostInput, HostProtocol, IpcError, LayoutDirection, LayoutNode, LayoutTab, LayoutTarget,
    LayoutTemplateInput,
};

const PASSPHRASE: &str = "correct horse battery staple";

fn code<T: std::fmt::Debug>(result: Result<T, IpcError>) -> ErrorCode {
    result.expect_err("expected an error").code
}

fn host(label: &str) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: "host.example".into(),
        port: Some(22),
        username: "deploy".into(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
        protocol: HostProtocol::Ssh,
        terminal: Default::default(),
        forward_agent: false,
    }
}

fn pair(host_id: &str, title: Option<&str>) -> LayoutTab {
    LayoutTab {
        title: title.map(Into::into),
        panes: vec![LayoutTarget::Ssh { host_id: host_id.into() }, LayoutTarget::Local],
        layout: LayoutNode::Split {
            dir: LayoutDirection::Column,
            ratio: 0.6,
            a: Box::new(LayoutNode::Leaf { pane: 0 }),
            b: Box::new(LayoutNode::Leaf { pane: 1 }),
        },
        focused: 1,
        focus_mode: false,
        directories: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn templates_persist_encrypted_and_restore_exactly() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("vault.db");
    let core = Core::open(&db).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let web = core.vault.save_host(host("web")).await.unwrap();
    let canary = "LAYOUT-CANARY-51c2";

    let saved = core
        .vault
        .save_layout(LayoutTemplateInput {
            id: None,
            name: format!("{canary} ops"),
            tabs: vec![pair(&web.id, Some(canary))],
        })
        .await
        .unwrap();
    assert_eq!(saved.tabs, vec![pair(&web.id, Some(canary))]);

    // An explicit save of the same template replaces it (same id); a second one is listed apart.
    let mut changed = pair(&web.id, None);
    changed.focus_mode = true;
    let replaced = core
        .vault
        .save_layout(LayoutTemplateInput {
            id: Some(saved.id.clone()),
            name: "Ops".into(),
            tabs: vec![changed.clone()],
        })
        .await
        .unwrap();
    assert_eq!(replaced.id, saved.id);
    core.vault
        .save_layout(LayoutTemplateInput { id: None, name: "alpha".into(), tabs: vec![pair(&web.id, None)] })
        .await
        .unwrap();
    let names: Vec<_> = core.vault.list_layouts().await.unwrap().into_iter().map(|l| l.name).collect();
    assert_eq!(names, ["alpha", "Ops"]);

    core.vault.lock().await;
    assert_eq!(code(core.vault.list_layouts().await), ErrorCode::VaultLocked);
    assert_eq!(
        code(
            core.vault
                .save_layout(LayoutTemplateInput { id: None, name: "x".into(), tabs: vec![pair(&web.id, None)] })
                .await
        ),
        ErrorCode::VaultLocked
    );
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(canary.len()).any(|w| w == canary.as_bytes()), "template text found on disk");
    }
    drop(core);

    let core = Core::open(&db).unwrap();
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let list = core.vault.list_layouts().await.unwrap();
    let ops = list.iter().find(|l| l.name == "Ops").unwrap();
    assert_eq!(ops.tabs, vec![changed]);

    core.vault.delete_layout(&ops.id).await.unwrap();
    assert_eq!(code(core.vault.delete_layout(&ops.id).await), ErrorCode::NotFound);
    assert_eq!(core.vault.list_layouts().await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn templates_are_validated_natively() {
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let web = core.vault.save_host(host("web")).await.unwrap();
    let save = |name: &str, tabs: Vec<LayoutTab>| {
        core.vault.save_layout(LayoutTemplateInput { id: None, name: name.into(), tabs })
    };

    // A destination that is not a saved host.
    assert_eq!(code(save("x", vec![pair(&"a".repeat(32), None)]).await), ErrorCode::NotFound);
    // A host deleted after the template was drafted.
    let gone = core.vault.save_host(host("gone")).await.unwrap();
    core.vault.delete_host(&gone.id).await.unwrap();
    assert_eq!(code(save("x", vec![pair(&gone.id, None)]).await), ErrorCode::NotFound);
    // Display-unsafe names, an unknown template id, and more than 16 panes.
    assert_eq!(code(save("evil\u{1b}]0;x\u{7}", vec![pair(&web.id, None)]).await), ErrorCode::InvalidInput);
    assert_eq!(code(save("", vec![pair(&web.id, None)]).await), ErrorCode::InvalidInput);
    let unknown = LayoutTemplateInput { id: Some("b".repeat(32)), name: "x".into(), tabs: vec![pair(&web.id, None)] };
    assert_eq!(code(core.vault.save_layout(unknown).await), ErrorCode::NotFound);
    assert_eq!(code(save("x", (0..9).map(|_| pair(&web.id, None)).collect()).await), ErrorCode::InvalidInput);
    assert!(core.vault.list_layouts().await.unwrap().is_empty());
}

#[test]
fn ipc_input_with_a_hostile_nesting_depth_is_rejected_while_parsing() {
    // The renderer sends JSON; a tree nested far past any real layout fails in serde's
    // recursion limit before any of it reaches validation.
    let mut json = String::from(r#"{"kind":"leaf","pane":0}"#);
    for _ in 0..300 {
        json = format!(r#"{{"kind":"split","dir":"row","ratio":0.5,"a":{json},"b":{{"kind":"leaf","pane":0}}}}"#);
    }
    assert!(serde_json::from_str::<LayoutNode>(&json).is_err());
}

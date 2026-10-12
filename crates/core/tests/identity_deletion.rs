//! Deleting an identity that is in use (BUILD_SPEC §10.2) against a real vault: refused unless
//! the user chooses to reassign its users or remove it from them, after a preview that names
//! how each affected host signs in instead. Nothing falls back silently.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    ErrorCode, GroupInput, HostAuthInput, HostInput, IdentityInput, IdentityReferences, IdentityUse, SecretChange,
    SettingsTarget, SignInAfter,
};

const PASSPHRASE: &str = "correct horse battery staple";

async fn unlocked(dir: &TempDir) -> Core {
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    core
}

fn identity(label: &str) -> IdentityInput {
    IdentityInput {
        id: None,
        label: label.into(),
        username: label.to_lowercase(),
        password: SecretChange::Set { value: format!("{label}-synthetic") },
        key_id: None,
    }
}

fn group(name: &str, parent: Option<&str>, key_id: Option<&str>) -> GroupInput {
    GroupInput {
        id: None,
        name: name.into(),
        parent_id: parent.map(Into::into),
        username: None,
        port: None,
        key_id: key_id.map(Into::into),
    }
}

fn host(label: &str, auth: HostAuthInput, group_id: Option<&str>) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{label}.example"),
        port: None,
        username: "u".into(),
        auth,
        group_id: group_id.map(Into::into),
        tags: Vec::new(),
    }
}

fn find<'a>(uses: &'a [IdentityUse], label: &str) -> &'a IdentityUse {
    uses.iter().find(|u| u.label == label).unwrap_or_else(|| panic!("{label} not in {uses:?}"))
}

#[tokio::test]
async fn deleting_a_used_identity_needs_a_choice_and_the_preview_names_every_fallback() {
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v.generate_key("fleet key").await.unwrap();
    let ops = v.save_identity(identity("Ops")).await.unwrap();
    let base = v.save_identity(identity("Base")).await.unwrap();
    let release = v.save_identity(identity("Release")).await.unwrap();

    // Root (identity Base) > Team (identity Ops); Keyed (a key) > Inner (identity Ops).
    let root = v.save_group(group("Root", None, None)).await.unwrap();
    let team = v.save_group(group("Team", Some(&root.id), None)).await.unwrap();
    let keyed = v.save_group(group("Keyed", None, Some(&key.id))).await.unwrap();
    let inner = v.save_group(group("Inner", Some(&keyed.id), None)).await.unwrap();
    for (g, i) in [(&root.id, &base.id), (&team.id, &ops.id), (&inner.id, &ops.id)] {
        v.set_identity(SettingsTarget::Group { group_id: g.clone() }, Some(i.clone())).await.unwrap();
    }
    let in_team = v.save_host(host("in-team", HostAuthInput::Inherit, Some(&team.id))).await.unwrap();
    let in_inner = v.save_host(host("in-inner", HostAuthInput::Inherit, Some(&inner.id))).await.unwrap();
    let stored = v
        .save_host(host("stored", HostAuthInput::StoredPassword { password: Some("host-own-secret".into()) }, None))
        .await
        .unwrap();
    let asks = v.save_host(host("asks", HostAuthInput::AskPassword, None)).await.unwrap();
    let unrelated = v.save_host(host("unrelated", HostAuthInput::Inherit, Some(&root.id))).await.unwrap();
    for h in [&stored.id, &asks.id] {
        v.set_identity(SettingsTarget::Host { host_id: h.clone() }, Some(ops.id.clone())).await.unwrap();
    }

    // The preview lists every host and group Ops applies to and what each host uses without it.
    let uses = v.identity_usage(&ops.id).await.unwrap();
    let labels: Vec<&str> = uses.iter().map(|u| u.label.as_str()).collect();
    assert_eq!(labels, ["asks", "in-inner", "in-team", "Inner", "stored", "Team"]);
    assert!(!labels.contains(&"unrelated"), "a host that does not use the identity is not listed");
    assert_eq!(
        find(&uses, "in-team").after_removal,
        Some(SignInAfter::Identity { identity_id: base.id.clone(), label: "Base".into() }),
        "the next group up still names an identity"
    );
    assert_eq!(
        find(&uses, "in-inner").after_removal,
        Some(SignInAfter::Key { key_id: key.id.clone(), label: "fleet key".into() })
    );
    assert_eq!(find(&uses, "stored").after_removal, Some(SignInAfter::StoredPassword), "named, not silent");
    assert_eq!(find(&uses, "asks").after_removal, Some(SignInAfter::AskPassword));
    assert!(find(&uses, "stored").direct && !find(&uses, "in-team").direct);
    assert_eq!((find(&uses, "Team").direct, find(&uses, "Team").after_removal.clone()), (true, None));

    // No choice: refused, nothing written.
    let refused = v.delete_identity(&ops.id, None).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::InUse);
    assert_eq!(v.identity_usage(&ops.id).await.unwrap(), uses);

    // A replacement must be another identity that exists.
    let missing = "00".repeat(16);
    let to = |identity_id: &str| Some(IdentityReferences::Reassign { identity_id: identity_id.into() });
    assert_eq!(v.delete_identity(&ops.id, to(&ops.id)).await.unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(v.delete_identity(&ops.id, to(&missing)).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(v.delete_identity(&ops.id, to("../x")).await.unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(v.identity_usage(&ops.id).await.unwrap(), uses, "refusals change nothing");

    // Reassign: every host and group that named Ops names Release, in one transaction.
    assert_eq!(v.delete_identity(&ops.id, to(&release.id)).await.unwrap(), 4);
    assert_eq!(v.identity_usage(&ops.id).await.unwrap_err().code, ErrorCode::NotFound);
    let moved: Vec<String> = v.identity_usage(&release.id).await.unwrap().into_iter().map(|u| u.label).collect();
    assert_eq!(moved, ["asks", "in-inner", "in-team", "Inner", "stored", "Team"]);

    // Remove: each host then signs in exactly as the preview said.
    assert_eq!(v.delete_identity(&release.id, Some(IdentityReferences::Remove)).await.unwrap(), 4);
    let assignments = v.list_identity_assignments().await.unwrap();
    let effective = |id: &str| {
        assignments
            .iter()
            .find(|a| a.target == SettingsTarget::Host { host_id: id.into() })
            .unwrap()
            .effective_identity_id
            .clone()
    };
    assert_eq!(effective(&in_team.id).as_deref(), Some(base.id.as_str()));
    assert_eq!(effective(&in_inner.id), None);
    assert_eq!(effective(&stored.id), None);
    assert_eq!(effective(&unrelated.id).as_deref(), Some(base.id.as_str()));

    // Persisted: a reload sees the same, and an unused identity deletes without a choice.
    v.lock().await;
    v.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let labels: Vec<String> = v.list_identities().await.unwrap().into_iter().map(|i| i.label).collect();
    assert_eq!(labels, ["Base"]);
    let spare = v.save_identity(identity("Spare")).await.unwrap();
    assert_eq!(v.delete_identity(&spare.id, None).await.unwrap(), 0);
}

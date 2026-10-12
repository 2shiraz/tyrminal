//! Security review (P-27) against a real vault: weak and unprotected keys, password sign-in
//! (own, inherited and through an identity), certificates near and past expiry, and known hosts
//! that no host uses or that are trusted only by an RSA key. Keys and certificates are made with
//! `ssh-keygen` in a temporary directory; nothing is read from the user's own files.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    ErrorCode, FindingSeverity, GroupInput, HostAuthInput, HostInput, HostProtocol, IdentityInput, KeyImportInput,
    KeyKind, SecretChange, SecurityFinding, SettingsTarget,
};

const PASSPHRASE: &str = "correct horse battery staple";
const HOST_PASSWORD: &str = "synthetic-host-password-7f3a";
const IDENTITY_PASSWORD: &str = "synthetic-identity-password-91c2";
const KEY_PASSPHRASE: &str = "synthetic-key-passphrase-55d0";
const DAY: u64 = 24 * 60 * 60;
// Public halves of throwaway keys; see tests/fixtures/review/README.md.
const RSA_KNOWN_HOST: &str = include_str!("../../../tests/fixtures/review/rsa3072.pub");

async fn unlocked(dir: &TempDir) -> Core {
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    core
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn keygen(dir: &Path, name: &str, args: &[&str], passphrase: &str) -> String {
    let path = dir.join(name);
    let ok = Command::new("ssh-keygen")
        .args(["-q", "-C", "synthetic-review", "-N", passphrase])
        .args(args)
        .arg("-f")
        .arg(&path)
        .status()
        .unwrap();
    assert!(ok.success(), "ssh-keygen {args:?}");
    std::fs::read_to_string(&path).unwrap()
}

fn sign_user_certificate(dir: &Path, public_key: &str, validity: &str) -> String {
    let ca = dir.join("ca");
    if !ca.exists() {
        keygen(dir, "ca", &["-t", "ed25519"], "");
    }
    let user = dir.join("user.pub");
    std::fs::write(&user, format!("{public_key}\n")).unwrap();
    let ok = Command::new("ssh-keygen")
        .args(["-q", "-s"])
        .arg(&ca)
        .args(["-I", "synthetic-user", "-n", "tyr", "-V", validity])
        .arg(&user)
        .status()
        .unwrap();
    assert!(ok.success());
    std::fs::read_to_string(dir.join("user-cert.pub")).unwrap()
}

fn import(label: &str, private_key: String, passphrase: Option<&str>, remember: bool) -> KeyImportInput {
    KeyImportInput {
        label: label.into(),
        private_key,
        passphrase: passphrase.map(Into::into),
        remember_passphrase: remember,
    }
}

fn host(label: &str, auth: HostAuthInput, group: Option<&str>) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{label}.example"),
        port: None,
        username: "tyr".into(),
        auth,
        group_id: group.map(Into::into),
        tags: Vec::new(),
        protocol: HostProtocol::Ssh,
        terminal: Default::default(),
        forward_agent: false,
        production: false,
    }
}

fn kinds(findings: &[SecurityFinding]) -> Vec<String> {
    findings.iter().map(|f| serde_json::to_value(f).unwrap()["kind"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn the_review_reads_the_vault_and_reports_what_needs_attention() {
    let dir = TempDir::new().unwrap();
    let work = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;

    // Keys: a 2048-bit RSA key, an encrypted key with its passphrase remembered, an encrypted key
    // without it, a generated Ed25519 key and a generated RSA 3072 key.
    let rsa2048 = v
        .import_key(import("legacy rsa", keygen(work.path(), "rsa2048", &["-t", "rsa", "-b", "2048"], ""), None, false))
        .await
        .unwrap();
    let remembered = v
        .import_key(import(
            "remembered",
            keygen(work.path(), "remembered", &["-t", "ed25519"], KEY_PASSPHRASE),
            Some(KEY_PASSPHRASE),
            true,
        ))
        .await
        .unwrap();
    let protected = v
        .import_key(import(
            "protected",
            keygen(work.path(), "protected", &["-t", "ed25519"], KEY_PASSPHRASE),
            Some(KEY_PASSPHRASE),
            false,
        ))
        .await
        .unwrap();
    let generated = v.generate_key("generated").await.unwrap();
    let modern_rsa = v.generate_key_of("modern rsa", KeyKind::Rsa3072).await.unwrap();

    // Hosts: one per sign-in method, one inheriting a group's key, one using an identity with a
    // password, and a Telnet host (never reviewed for SSH sign-in).
    let group = v
        .save_group(GroupInput {
            id: None,
            name: "Fleet".into(),
            parent_id: None,
            username: None,
            port: Some(2222),
            key_id: Some(rsa2048.id.clone()),
            production: false,
        })
        .await
        .unwrap();
    v.save_host(host("stored", HostAuthInput::StoredPassword { password: Some(HOST_PASSWORD.into()) }, None))
        .await
        .unwrap();
    v.save_host(host("asked", HostAuthInput::AskPassword, None)).await.unwrap();
    v.save_host(host("keyed", HostAuthInput::Key { key_id: modern_rsa.id.clone() }, None)).await.unwrap();
    v.save_host(host("fleet", HostAuthInput::Inherit, Some(&group.id))).await.unwrap();
    let via_identity = v.save_host(host("via-identity", HostAuthInput::AskPassword, None)).await.unwrap();
    let identity = v
        .save_identity(IdentityInput {
            id: None,
            label: "Ops".into(),
            username: "ops".into(),
            password: SecretChange::Set { value: IDENTITY_PASSWORD.into() },
            key_id: None,
        })
        .await
        .unwrap();
    v.set_identity(SettingsTarget::Host { host_id: via_identity.id.clone() }, Some(identity.id.clone())).await.unwrap();
    v.save_host(HostInput { protocol: HostProtocol::Telnet, ..host("router", HostAuthInput::AskPassword, None) })
        .await
        .unwrap();

    // Certificates: one expiring in ten days, one valid for a year.
    let expiring = sign_user_certificate(work.path(), &generated.public_key, "-5m:+10d");
    v.attach_key_certificate(&generated.id, &expiring).await.unwrap();
    let long = sign_user_certificate(work.path(), &modern_rsa.public_key, "-5m:+365d");
    v.attach_key_certificate(&modern_rsa.id, &long).await.unwrap();

    // Known hosts: the fleet host's endpoint (group port 2222), an RSA-only entry for a host no
    // longer in the inventory, and an RSA entry for "keyed" next to an Ed25519 one.
    keygen(work.path(), "hostkey", &["-t", "ed25519"], "");
    let ed25519_public = std::fs::read_to_string(work.path().join("hostkey.pub")).unwrap();
    let rsa_public = RSA_KNOWN_HOST.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let ed_public = ed25519_public.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let file = format!(
        "[fleet.example]:2222 {ed_public}\nretired.example {rsa_public}\nkeyed.example {rsa_public}\nkeyed.example {ed_public}\n"
    );
    let preview = v.known_hosts_file_preview(&file).await.unwrap();
    assert_eq!(v.import_known_hosts(preview.entries).await.unwrap(), 4);

    let review = v.security_review_now().await.unwrap();
    assert_eq!(
        kinds(&review.findings),
        vec![
            "short_rsa_key",
            "certificate_expiring",
            "password_sign_in",
            "password_sign_in",
            "password_sign_in",
            "key_without_passphrase",
            "key_without_passphrase",
            "key_without_passphrase",
            "key_without_passphrase",
            "unused_known_host",
            "ssh_rsa_only_known_host",
        ],
        "{:#?}",
        review.findings
    );
    assert_eq!((review.keys, review.hosts, review.certificates, review.known_hosts), (5, 5, 2, 4));
    assert!(review.findings.contains(&SecurityFinding::ShortRsaKey {
        key_id: rsa2048.id.clone(),
        label: "legacy rsa".into(),
        bits: 2048,
        // Used through the group: the fleet host inherits it.
        used_by: 1,
    }));
    assert!(review.findings.contains(&SecurityFinding::PasswordSignIn {
        host_id: via_identity.id.clone(),
        label: "via-identity".into(),
        stored: true,
    }));
    let labels_without_passphrase: Vec<_> = review
        .findings
        .iter()
        .filter_map(|f| match f {
            SecurityFinding::KeyWithoutPassphrase { label, passphrase_stored, .. } => {
                Some((label.as_str(), *passphrase_stored))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        labels_without_passphrase,
        vec![("generated", false), ("legacy rsa", false), ("modern rsa", false), ("remembered", true)]
    );
    assert!(!labels_without_passphrase.iter().any(|(l, _)| *l == protected.label));
    assert!(review.findings.iter().any(
        |f| matches!(f, SecurityFinding::KeyWithoutPassphrase { key_id, passphrase_stored: true, .. } if *key_id == remembered.id)
    ));
    let unused: Vec<_> = review
        .findings
        .iter()
        .filter_map(|f| match f {
            SecurityFinding::UnusedKnownHost { host, port, .. } => Some((host.as_str(), *port)),
            SecurityFinding::SshRsaOnlyKnownHost { host, port, .. } => Some((host.as_str(), *port)),
            _ => None,
        })
        .collect();
    assert_eq!(unused, vec![("retired.example", 22), ("retired.example", 22)], "fleet:2222 and keyed are in use");
    assert!(review.findings.iter().all(|f| f.severity() != FindingSeverity::High));

    // The same vault forty days on: the certificate has expired and the one-year one has not.
    let later = v.security_review(now() + 40 * DAY).await.unwrap();
    let expired: Vec<_> = later
        .findings
        .iter()
        .filter(|f| {
            matches!(f, SecurityFinding::CertificateExpired { .. } | SecurityFinding::CertificateExpiring { .. })
        })
        .collect();
    assert_eq!(expired.len(), 1);
    assert!(matches!(expired[0], SecurityFinding::CertificateExpired { key_id, .. } if *key_id == generated.id));
    assert_eq!(expired[0].severity(), FindingSeverity::High);

    // Nothing secret is in what the renderer receives, and reviewing changed nothing.
    let json = serde_json::to_string(&later).unwrap();
    for secret in [HOST_PASSWORD, IDENTITY_PASSWORD, KEY_PASSPHRASE, PASSPHRASE, "PRIVATE KEY", "AAAA"] {
        assert!(!json.contains(secret), "{secret} leaked into the review");
    }
    assert_eq!(v.list_keys().await.unwrap().len(), 5);
    assert_eq!(v.list_known_hosts().await.unwrap().len(), 4);
    assert_eq!(v.list_hosts().await.unwrap().len(), 6);

    // A locked vault cannot be reviewed.
    v.lock().await;
    assert_eq!(v.security_review_now().await.unwrap_err().code, ErrorCode::VaultLocked);
}

#[tokio::test]
async fn dsa_and_short_rsa_keys_in_the_keychain_are_high_severity() {
    let dir = TempDir::new().unwrap();
    let work = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    // The importer accepts these old keys (they may still be needed for old servers); the
    // review is where the user learns to replace them.
    let dsa =
        v.import_key(import("old dsa", keygen(work.path(), "dsa", &["-t", "dsa"], ""), None, false)).await.unwrap();
    let rsa = v
        .import_key(import("old rsa", keygen(work.path(), "rsa1024", &["-t", "rsa", "-b", "1024"], ""), None, false))
        .await
        .unwrap();
    v.save_host(host("legacy", HostAuthInput::Key { key_id: dsa.id.clone() }, None)).await.unwrap();
    let review = v.security_review_now().await.unwrap();
    let high: Vec<_> = review.findings.iter().filter(|f| f.severity() == FindingSeverity::High).cloned().collect();
    assert_eq!(
        high,
        vec![
            SecurityFinding::DsaKey { key_id: dsa.id.clone(), label: "old dsa".into(), used_by: 1 },
            SecurityFinding::ShortRsaKey { key_id: rsa.id.clone(), label: "old rsa".into(), bits: 1024, used_by: 0 },
        ]
    );
}

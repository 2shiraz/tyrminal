//! Sign-in with an OpenSSH user certificate against the real OpenSSH lab (`pnpm lab:up`). The lab
//! trusts a per-run user CA; the certified key itself is in no authorized_keys file, so only a
//! certificate the server accepts lets it in.
//!
//! Run with `cargo test -p tyrminal-ssh --test cert_lab -- --ignored`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use serde_json::Value;
use tyrminal_ssh::{
    AuthOutcome, ClientKey, ConnectOptions, Endpoint, HostKeyRequest, HostKeyVerifier, RejectReason, SshError,
    TrustVerdict, VerifiedConnection, connect,
};

struct Lab(Value);

impl Lab {
    fn load() -> Self {
        let path = std::env::var_os("TYRMINAL_LAB")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/ssh-lab/.run/lab.json"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("SSH lab is not running ({}). Run `pnpm lab:up` first.", path.display()));
        Self(serde_json::from_str(&text).expect("lab.json parses"))
    }

    fn str(&self, pointer: &str) -> String {
        self.0.pointer(pointer).and_then(Value::as_str).unwrap_or_else(|| panic!("lab.json: {pointer}")).to_owned()
    }

    fn certificate(&self, name: &str) -> String {
        std::fs::read_to_string(self.str(&format!("/certificates/{name}"))).unwrap()
    }

    fn key(&self, name: &str) -> ClientKey {
        ClientKey::from_openssh(&std::fs::read_to_string(self.str(&format!("/keys/{name}"))).unwrap(), None).unwrap()
    }

    async fn connect(&self) -> VerifiedConnection {
        let port = self.0.pointer("/servers/a/port").and_then(Value::as_u64).unwrap() as u16;
        let options = ConnectOptions::new(Endpoint::new("127.0.0.1", port));
        connect(&options, Pinned(self.str("/servers/a/hostKeyEd25519"))).await.expect("connect")
    }
}

struct Pinned(String);

impl HostKeyVerifier for Pinned {
    async fn verify(&mut self, request: &HostKeyRequest) -> TrustVerdict {
        if request.key.public_key == self.0 {
            TrustVerdict::Accept
        } else {
            TrustVerdict::Reject(RejectReason::Changed)
        }
    }
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_certificate_from_the_trusted_ca_signs_in_a_key_the_server_does_not_list() {
    let lab = Lab::load();
    let key = lab.key("certified");
    let user = lab.str("/user");

    // Without its certificate the key is refused: it is in no authorized_keys file.
    let mut conn = lab.connect().await;
    assert!(matches!(conn.authenticate_key(&user, &key).await.unwrap(), AuthOutcome::Failure { .. }));

    let mut conn = lab.connect().await;
    let outcome = conn.authenticate_key_with_certificate(&user, &key, &lab.certificate("valid")).await.unwrap();
    assert_eq!(outcome, AuthOutcome::Success);
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn expired_wrong_principal_and_untrusted_ca_certificates_are_refused_by_the_server() {
    let lab = Lab::load();
    let key = lab.key("certified");
    let user = lab.str("/user");
    for name in ["expired", "wrongPrincipal", "untrustedCa"] {
        let mut conn = lab.connect().await;
        let outcome = conn.authenticate_key_with_certificate(&user, &key, &lab.certificate(name)).await.unwrap();
        assert!(matches!(outcome, AuthOutcome::Failure { .. }), "{name}: {outcome:?}");
    }
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_certificate_for_another_key_is_refused_before_anything_is_sent() {
    let lab = Lab::load();
    let mut conn = lab.connect().await;
    let other = lab.key("ed25519");
    let result = conn.authenticate_key_with_certificate(&lab.str("/user"), &other, &lab.certificate("valid")).await;
    assert_eq!(result.unwrap_err(), SshError::Protocol);
    let garbage = conn.authenticate_key_with_certificate(&lab.str("/user"), &other, "not a certificate").await;
    assert_eq!(garbage.unwrap_err(), SshError::Protocol);
}

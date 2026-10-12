//! Key exchange policy against the real OpenSSH lab (`pnpm lab:up`): post-quantum first by default
//! with a classical fallback, a compatibility setting without it, and a strict setting that refuses
//! servers without it before any credential is sent.
//!
//! OpenSSH offers `mlkem768x25519-sha256` from 9.9. The container lab (OpenSSH 10.0) has it; the
//! container-free lab uses the machine's own sshd, which may be older. The test that needs it says
//! so (BLOCKED) instead of passing on an older server; `scripts/verify.mjs` runs it on its own.
//!
//! Run with `cargo test -p tyrminal-ssh --test kex_lab -- --ignored`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tyrminal_ssh::{
    AuthOutcome, ClientKey, ConnectOptions, Endpoint, HostKeyRequest, HostKeyVerifier, KeyExchangePolicy,
    POST_QUANTUM_KEX, RejectReason, SshError, TrustVerdict, connect,
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

    fn endpoint(&self) -> Endpoint {
        let port = self.0.pointer("/servers/a/port").and_then(Value::as_u64).unwrap() as u16;
        Endpoint::new("127.0.0.1", port)
    }

    /// Whether the lab's sshd offers the hybrid post-quantum exchange (OpenSSH 9.9 and later).
    fn offers_post_quantum(&self) -> bool {
        let version = self.str("/serverVersion");
        let start = version.find(|c: char| c.is_ascii_digit()).unwrap_or_else(|| panic!("no version in {version:?}"));
        let mut parts = version[start..].split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty());
        let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        (major, minor) >= (9, 9)
    }

    fn server_log(&self) -> String {
        if let Some(file) = self.0.pointer("/servers/a/logFile").and_then(Value::as_str) {
            return std::fs::read_to_string(file).expect("lab sshd log");
        }
        let container = self.str("/servers/a/container");
        let out = Command::new("docker").args(["logs", &container]).output().expect("docker logs");
        format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
    }

    fn auth_log_lines(&self) -> usize {
        self.server_log()
            .lines()
            .filter(|l| ["Accepted ", "Failed ", "Postponed ", "userauth"].iter().any(|n| l.contains(n)))
            .count()
    }
}

/// The tests share one server and one of them counts its authentication log lines, so they run
/// one at a time.
static SERVER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

fn options(lab: &Lab, policy: KeyExchangePolicy) -> ConnectOptions {
    ConnectOptions { key_exchange: policy, ..ConnectOptions::new(lab.endpoint()) }
}

/// Connects and signs in with the lab key, returning the negotiated key exchange.
async fn negotiated_kex(lab: &Lab, policy: KeyExchangePolicy) -> String {
    let mut conn = connect(&options(lab, policy), Pinned(lab.str("/servers/a/hostKeyEd25519"))).await.expect("connect");
    let key = ClientKey::from_openssh(&std::fs::read_to_string(lab.str("/keys/ed25519")).unwrap(), None).unwrap();
    assert_eq!(conn.authenticate_key(&lab.str("/user"), &key).await.unwrap(), AuthOutcome::Success);
    let negotiated = conn.negotiated().expect("negotiated algorithms are recorded");
    assert!(negotiated.strict_kex, "strict key exchange is negotiated with every policy");
    negotiated.kex
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn by_default_post_quantum_is_preferred_and_older_servers_still_connect() {
    let _one_at_a_time = SERVER.lock().await;
    let lab = Lab::load();
    let kex = negotiated_kex(&lab, KeyExchangePolicy::default()).await;
    if lab.offers_post_quantum() {
        assert_eq!(kex, POST_QUANTUM_KEX);
    } else {
        assert_eq!(kex, "curve25519-sha256", "a server without ML-KEM falls back to X25519");
    }
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn the_compatibility_setting_never_negotiates_post_quantum() {
    let _one_at_a_time = SERVER.lock().await;
    let lab = Lab::load();
    assert_eq!(negotiated_kex(&lab, KeyExchangePolicy::Classic).await, "curve25519-sha256");
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn requiring_post_quantum_connects_only_where_offered_and_sends_nothing_otherwise() {
    let _one_at_a_time = SERVER.lock().await;
    let lab = Lab::load();
    if lab.offers_post_quantum() {
        assert_eq!(negotiated_kex(&lab, KeyExchangePolicy::RequirePostQuantum).await, POST_QUANTUM_KEX);
        return;
    }
    let before = lab.auth_log_lines();
    let result =
        connect(&options(&lab, KeyExchangePolicy::RequirePostQuantum), Pinned(lab.str("/servers/a/hostKeyEd25519")))
            .await;
    assert!(matches!(result, Err(SshError::NoCommonAlgorithm)), "{:?}", result.err());
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(lab.auth_log_lines(), before, "the server saw no authentication attempt");
}

/// Proves the hybrid exchange end to end. Needs a lab sshd with ML-KEM (OpenSSH 9.9 or later).
#[tokio::test]
#[ignore = "requires the SSH lab with OpenSSH 9.9 or later"]
async fn post_quantum_key_exchange_is_negotiated_with_a_server_that_offers_it() {
    let _one_at_a_time = SERVER.lock().await;
    let lab = Lab::load();
    if !lab.offers_post_quantum() {
        panic!("BLOCKED: the lab's sshd ({}) does not offer {POST_QUANTUM_KEX}", lab.str("/serverVersion"));
    }
    assert_eq!(negotiated_kex(&lab, KeyExchangePolicy::PreferPostQuantum).await, POST_QUANTUM_KEX);
    assert_eq!(negotiated_kex(&lab, KeyExchangePolicy::RequirePostQuantum).await, POST_QUANTUM_KEX);
}

//! Integration tests against the real OpenSSH lab (`pnpm lab:up`). Nothing here is mocked.
//!
//! Run with `cargo test -p tyrminal-ssh --test lab -- --ignored`. The tests are `#[ignore]`d so a
//! plain `cargo test` does not need Docker; when run, a missing lab is a hard failure, not a skip.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tyrminal_ssh::{
    AuthOutcome, ClientKey, ConnectOptions, Endpoint, HostKeyRequest, HostKeyVerifier, KeyError, KnownHost,
    PresentedHostKey, PtyRequest, RejectReason, ShellEvent, ShellReader, SshError, Stage, TrustStatus, TrustVerdict,
    VerifiedConnection, canonical_host, connect, evaluate,
};
use zeroize::Zeroizing;

// ---------- lab description ----------

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

    fn endpoint(&self, server: &str) -> Endpoint {
        let port = self.0.pointer(&format!("/servers/{server}/port")).and_then(Value::as_u64).unwrap() as u16;
        Endpoint::new("127.0.0.1", port)
    }

    fn addr(&self, server: &str) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.endpoint(server).port))
    }

    fn host_key(&self, server: &str) -> String {
        self.str(&format!("/servers/{server}/hostKeyEd25519"))
    }

    fn user(&self) -> String {
        self.str("/user")
    }

    fn password(&self) -> Zeroizing<String> {
        Zeroizing::new(self.str("/password"))
    }

    fn key(&self, name: &str, passphrase: Option<&str>) -> Result<ClientKey, KeyError> {
        let text = std::fs::read_to_string(self.str(&format!("/keys/{name}"))).unwrap();
        ClientKey::from_openssh(&text, passphrase)
    }

    /// The sshd log: a file in the container-free lab, `docker logs` in the container lab.
    fn server_log(&self, server: &str) -> String {
        if let Some(file) = self.0.pointer(&format!("/servers/{server}/logFile")).and_then(Value::as_str) {
            return std::fs::read_to_string(file).expect("lab sshd log");
        }
        let container = self.str(&format!("/servers/{server}/container"));
        let out = Command::new("docker").args(["logs", &container]).output().expect("docker logs");
        format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
    }

    /// sshd log lines that show any authentication activity.
    fn auth_log_lines(&self, server: &str) -> Vec<String> {
        let text = self.server_log(server);
        text.lines()
            .filter(|l| {
                ["Accepted ", "Failed ", "Postponed ", "Invalid user", "userauth", "authentication failure"]
                    .iter()
                    .any(|needle| l.contains(needle))
            })
            .map(str::to_owned)
            .collect()
    }
}

/// Server "b" is reserved for tests that assert on its auth log, so they run one at a time.
static SERVER_B: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---------- verifiers ----------

/// Accepts exactly one pinned public key.
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

/// Records what it was shown and answers with a fixed verdict.
struct Scripted {
    verdict: TrustVerdict,
    seen: Arc<Mutex<Vec<HostKeyRequest>>>,
}

impl HostKeyVerifier for Scripted {
    async fn verify(&mut self, request: &HostKeyRequest) -> TrustVerdict {
        self.seen.lock().unwrap().push(request.clone());
        self.verdict
    }
}

/// The policy the application uses: known-hosts evaluation with trust-on-first-use standing in
/// for the user pressing "trust" on an unknown key. A changed key is never accepted.
struct KnownHostsPolicy {
    store: Arc<Mutex<Vec<KnownHost>>>,
    trust_unknown: bool,
}

impl HostKeyVerifier for KnownHostsPolicy {
    async fn verify(&mut self, request: &HostKeyRequest) -> TrustVerdict {
        let mut store = self.store.lock().unwrap();
        match evaluate(&store, &request.endpoint, &request.key) {
            TrustStatus::Trusted => TrustVerdict::Accept,
            TrustStatus::Changed { .. } => TrustVerdict::Reject(RejectReason::Changed),
            TrustStatus::Unknown if self.trust_unknown => {
                let (host, port) = request.endpoint.canonical();
                store.push(KnownHost { host, port, public_key: request.key.public_key.clone() });
                TrustVerdict::Accept
            }
            TrustStatus::Unknown => TrustVerdict::Reject(RejectReason::NotTrusted),
        }
    }
}

// ---------- in-test TCP forwarder: one stable endpoint, switchable backend ----------

struct Forwarder {
    local: SocketAddr,
    target: Arc<Mutex<SocketAddr>>,
    cut: watch::Sender<u64>,
}

impl Forwarder {
    async fn start(bind: &str, target: SocketAddr) -> Self {
        let listener = TcpListener::bind(bind).await.expect("bind forwarder");
        let local = listener.local_addr().unwrap();
        let target = Arc::new(Mutex::new(target));
        let (cut, _) = watch::channel(0u64);
        let (target2, cut2) = (Arc::clone(&target), cut.clone());
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let backend = *target2.lock().unwrap();
                let mut cut_rx = cut2.subscribe();
                tokio::spawn(async move {
                    let Ok(mut outbound) = TcpStream::connect(backend).await else {
                        return;
                    };
                    tokio::select! {
                        _ = copy_bidirectional(&mut inbound, &mut outbound) => {}
                        _ = cut_rx.changed() => {}
                    }
                });
            }
        });
        Self { local, target, cut }
    }

    fn retarget(&self, target: SocketAddr) {
        *self.target.lock().unwrap() = target;
    }

    /// Drops every connection currently being forwarded.
    fn cut_all(&self) {
        self.cut.send_modify(|g| *g += 1);
    }
}

// ---------- helpers ----------

fn options(endpoint: Endpoint) -> ConnectOptions {
    ConnectOptions::new(endpoint)
}

async fn connected(lab: &Lab) -> VerifiedConnection {
    let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.expect("connect");
    let key = lab.key("ed25519", None).unwrap();
    assert_eq!(conn.authenticate_key(&lab.user(), &key).await.unwrap(), AuthOutcome::Success);
    conn
}

async fn read_until(reader: &mut ShellReader, needle: &str, limit: Duration) -> String {
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if text.contains(needle) {
            return text;
        }
        match tokio::time::timeout_at(deadline, reader.next()).await {
            Ok(Some(ShellEvent::Output(data))) => text.push_str(&String::from_utf8_lossy(&data)),
            Ok(Some(_)) => {}
            Ok(None) => panic!("channel closed before {needle:?}; got {text:?}"),
            Err(_) => panic!("timed out waiting for {needle:?}; got {text:?}"),
        }
    }
}

// ---------- authentication ----------

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn ed25519_key_authenticates_and_runs_a_fixture_command() {
    let lab = Lab::load();
    let conn = connected(&lab).await;
    assert_eq!(conn.host_key().algorithm, "ssh-ed25519");
    assert_eq!(conn.host_key().fingerprint, lab.str("/servers/a/hostKeyEd25519Fingerprint"));
    let out = conn.exec("echo tyrminal-fixture-ok; id -un", 4096, Duration::from_secs(10)).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("tyrminal-fixture-ok\n{}\n", lab.user()));
    assert_eq!(out.exit_status, Some(0));
    conn.disconnect().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn password_authenticates_and_wrong_password_does_not() {
    let lab = Lab::load();
    let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();

    // Not authenticated yet: channel APIs refuse locally.
    assert_eq!(conn.exec("true", 16, Duration::from_secs(5)).await.err(), Some(SshError::NotAuthenticated));

    let wrong = conn.authenticate_password(&lab.user(), Zeroizing::new("definitely-wrong".into())).await.unwrap();
    match wrong {
        AuthOutcome::Failure { remaining_methods, partial_success } => {
            assert!(!partial_success);
            assert!(remaining_methods.iter().any(|m| m == "password"), "{remaining_methods:?}");
        }
        AuthOutcome::Success => panic!("wrong password must not authenticate"),
    }
    assert!(!conn.is_authenticated());

    assert_eq!(conn.authenticate_password(&lab.user(), lab.password()).await.unwrap(), AuthOutcome::Success);
    let out = conn.exec("echo ok", 64, Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.stdout, b"ok\n");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn encrypted_key_needs_the_right_passphrase() {
    let lab = Lab::load();
    assert_eq!(lab.key("ed25519Encrypted", None).err(), Some(KeyError::PassphraseRequired));
    assert_eq!(lab.key("ed25519Encrypted", Some("not the passphrase")).err(), Some(KeyError::WrongPassphrase));
    let passphrase = lab.str("/keys/ed25519EncryptedPassphrase");
    let key = lab.key("ed25519Encrypted", Some(&passphrase)).expect("decrypts");
    assert!(!format!("{key:?}").contains(&passphrase));

    let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
    assert_eq!(conn.authenticate_key(&lab.user(), &key).await.unwrap(), AuthOutcome::Success);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn rsa_and_ecdsa_keys_authenticate_with_sha2_signatures() {
    let lab = Lab::load();
    for name in ["rsa", "ecdsa"] {
        let key = lab.key(name, None).unwrap();
        let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
        assert_eq!(conn.authenticate_key(&lab.user(), &key).await.unwrap(), AuthOutcome::Success, "{name}");
        let out = conn.exec("echo ok", 64, Duration::from_secs(10)).await.unwrap();
        assert_eq!(out.stdout, b"ok\n");
    }
    // OpenSSH 10 has no ssh-rsa/SHA-1 at all, so success above proves an rsa-sha2-* signature.
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn unauthorized_key_and_unknown_user_are_refused() {
    let lab = Lab::load();
    let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
    let stranger = lab.key("unauthorized", None).unwrap();
    assert!(!conn.authenticate_key(&lab.user(), &stranger).await.unwrap().is_success());
    assert!(!conn.is_authenticated());

    // A valid key for a user that does not exist is refused like any other failure.
    let good = lab.key("ed25519", None).unwrap();
    let mut fresh = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
    assert!(!fresh.authenticate_key("no-such-user", &good).await.unwrap().is_success());

    // OpenSSH drops a connection that switches user name mid-authentication. That must surface as
    // a disconnect, not as a rejected credential.
    let err = conn.authenticate_key("no-such-user", &good).await.expect_err("server disconnects");
    assert_eq!(err, SshError::Disconnected(Stage::Authenticating));
}

// ---------- host trust ----------

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn verifier_sees_endpoint_resolved_address_algorithm_and_fingerprint() {
    let lab = Lab::load();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let verifier = Scripted { verdict: TrustVerdict::Accept, seen: Arc::clone(&seen) };
    let conn = connect(&options(lab.endpoint("a")), verifier).await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "exactly one trust decision per connection");
    assert_eq!(seen[0].endpoint, lab.endpoint("a"));
    assert_eq!(seen[0].resolved, Some(lab.addr("a")));
    assert_eq!(seen[0].key.algorithm, "ssh-ed25519");
    assert_eq!(seen[0].key.fingerprint, lab.str("/servers/a/hostKeyEd25519Fingerprint"));
    assert_eq!(seen[0].key.public_key, lab.host_key("a"));
    assert_eq!(conn.host_key(), &seen[0].key);
}

/// INV-02: declining an unknown key ends the connection with no authentication activity at all on
/// the server. The proof is the server's own VERBOSE log.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn declining_an_unknown_host_key_sends_no_credentials() {
    let lab = Lab::load();
    let _exclusive = SERVER_B.lock().await;
    let before = lab.auth_log_lines("b");

    for reason in [RejectReason::NotTrusted, RejectReason::Cancelled] {
        let verifier = Scripted { verdict: TrustVerdict::Reject(reason), seen: Arc::default() };
        let err = connect(&options(lab.endpoint("b")), verifier).await.expect_err("must not connect");
        assert_eq!(err, SshError::HostKey(reason));
        assert_eq!(err.code(), "HOST_KEY_REJECTED");
    }

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(lab.auth_log_lines("b"), before, "sshd saw authentication activity after a rejected host key");
}

/// INV-03 and the Phase 03 gate: two differently keyed servers behind the same endpoint. The second
/// connection is blocked as CHANGED before any credential is sent, and trust is not replaced.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn changed_host_key_at_the_same_endpoint_blocks_before_credentials() {
    let lab = Lab::load();
    let _exclusive = SERVER_B.lock().await;
    let forwarder = Forwarder::start("127.0.0.1:0", lab.addr("a")).await;
    let endpoint = Endpoint::new("127.0.0.1", forwarder.local.port());
    let store = Arc::new(Mutex::new(Vec::<KnownHost>::new()));
    let key = lab.key("ed25519", None).unwrap();

    // First use: unknown key, the "user" trusts it, authentication succeeds against server A.
    let policy = KnownHostsPolicy { store: Arc::clone(&store), trust_unknown: true };
    let mut first = connect(&options(endpoint.clone()), policy).await.expect("first connection");
    assert_eq!(first.authenticate_key(&lab.user(), &key).await.unwrap(), AuthOutcome::Success);
    first.disconnect().await;
    assert_eq!(store.lock().unwrap().len(), 1);
    let trusted_before = store.lock().unwrap().clone();

    // Same endpoint now answers with server B's key.
    forwarder.retarget(lab.addr("b"));
    let before = lab.auth_log_lines("b");
    for trust_unknown in [true, false] {
        let policy = KnownHostsPolicy { store: Arc::clone(&store), trust_unknown };
        let err = connect(&options(endpoint.clone()), policy).await.expect_err("changed key must block");
        assert_eq!(err, SshError::HostKey(RejectReason::Changed));
        assert_eq!(err.code(), "HOST_KEY_CHANGED");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(lab.auth_log_lines("b"), before, "credentials reached the impostor server");
    assert_eq!(*store.lock().unwrap(), trusted_before, "trust store must not change on a changed key");

    // Back to the original server: still trusted, still works. No silent replacement happened.
    forwarder.retarget(lab.addr("a"));
    let policy = KnownHostsPolicy { store: Arc::clone(&store), trust_unknown: false };
    let mut again = connect(&options(endpoint), policy).await.expect("original server still trusted");
    assert_eq!(again.authenticate_key(&lab.user(), &key).await.unwrap(), AuthOutcome::Success);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn ipv6_loopback_endpoint_connects_and_matches_bracketed_trust_entries() {
    let lab = Lab::load();
    // Docker publishes the lab on IPv4 only; an IPv6 listener in front exercises the client's
    // IPv6 literal handling, connect path and trust canonicalization.
    let forwarder = Forwarder::start("[::1]:0", lab.addr("a")).await;
    let port = forwarder.local.port();
    let store = Arc::new(Mutex::new(Vec::<KnownHost>::new()));

    let policy = KnownHostsPolicy { store: Arc::clone(&store), trust_unknown: true };
    let conn = connect(&options(Endpoint::new("::1", port)), policy).await.expect("ipv6 connect");
    assert_eq!(conn.host_key().public_key, lab.host_key("a"));
    assert_eq!(store.lock().unwrap()[0].host, canonical_host("[::1]"));

    // The bracketed spelling resolves to the same trust entry: accepted without trust_unknown.
    let policy = KnownHostsPolicy { store: Arc::clone(&store), trust_unknown: false };
    let mut conn = connect(&options(Endpoint::new("[::1]", port)), policy).await.expect("bracketed ipv6");
    let key = lab.key("ed25519", None).unwrap();
    assert!(conn.authenticate_key(&lab.user(), &key).await.unwrap().is_success());
}

// ---------- interactive shell ----------

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn interactive_shell_runs_commands_resizes_and_reports_exit_status() {
    let lab = Lab::load();
    let conn = connected(&lab).await;
    let pty = PtyRequest { term: "xterm-256color".into(), cols: 80, rows: 24 };
    let (mut reader, writer) = conn.open_shell(&pty).await.expect("shell");

    writer.write(b"echo TERM=$TERM; stty size; echo first-$((40+2))\n").await.unwrap();
    let text = read_until(&mut reader, "first-42\r\n", Duration::from_secs(10)).await;
    assert!(text.contains("TERM=xterm-256color"), "{text:?}");
    assert!(text.contains("24 80"), "{text:?}");

    writer.resize(132, 43).await.unwrap();
    writer.write(b"stty size; echo second-$((40+2))\n").await.unwrap();
    let text = read_until(&mut reader, "second-42\r\n", Duration::from_secs(10)).await;
    assert!(text.contains("43 132"), "{text:?}");

    // Ctrl+C interrupts a foreground process through the PTY.
    writer.write(b"sleep 600\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    writer.write(&[0x03]).await.unwrap();
    writer.write(b"echo interrupted=$?\n").await.unwrap();
    let text = read_until(&mut reader, "interrupted=130", Duration::from_secs(10)).await;
    assert!(text.contains("interrupted=130"));

    writer.write(b"exit 7\n").await.unwrap();
    let mut status = None;
    while let Some(event) = tokio::time::timeout(Duration::from_secs(10), reader.next()).await.unwrap() {
        assert!(!matches!(event, ShellEvent::ConnectionLost), "a normal exit is not a lost connection");
        if let ShellEvent::ExitStatus(code) = event {
            status = Some(code);
        }
    }
    assert_eq!(status, Some(7));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn hostile_terminal_dimensions_are_clamped_not_forwarded() {
    let lab = Lab::load();
    let conn = connected(&lab).await;
    let pty = PtyRequest { term: "xterm\n$(reboot)\u{1b}[31m".into(), cols: u32::MAX, rows: 70_000 };
    let (mut reader, writer) = conn.open_shell(&pty).await.expect("shell with clamped request");
    writer.write(b"echo T=[$TERM]; stty size; echo done-$((40+2))\n").await.unwrap();
    let text = read_until(&mut reader, "done-42\r\n", Duration::from_secs(10)).await;
    assert!(text.contains("T=[xterm$(reboot)[31m]"), "TERM is filtered to printable ASCII: {text:?}");
    assert!(text.contains("1000 1000"), "{text:?}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn session_channel_denied_by_the_server_is_reported() {
    let lab = Lab::load();
    let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
    assert!(conn.authenticate_password(&lab.str("/noSessionUser"), lab.password()).await.unwrap().is_success());
    let pty = PtyRequest { term: "xterm".into(), cols: 80, rows: 24 };
    let err = conn.open_shell(&pty).await.expect_err("MaxSessions 0 denies the channel");
    assert!(matches!(err, SshError::ChannelDenied | SshError::Disconnected(_)), "{err:?}");
}

// ---------- flow control ----------

/// A producer far faster than the consumer: the consumer stalls, then drains. Every byte must
/// arrive, in order, with no error. An awk counter makes any loss or reordering detectable (not
/// `seq`, which prints large numbers in scientific notation on macOS).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn large_output_survives_a_stalled_consumer_without_loss_or_reordering() {
    let lab = Lab::load();
    let conn = connected(&lab).await;
    const LAST: u64 = 3_000_000; // ~22.9 MiB of text
    let (mut reader, _writer) = conn
        .open_command(&format!("awk 'BEGIN {{ for (i = 1; i <= {LAST}; i++) printf \"%d\\n\", i }}'"))
        .await
        .unwrap();

    let mut expected: u64 = 1;
    let mut partial = String::new();
    let mut total = 0usize;
    let mut stalled = false;
    let mut exit = None;
    while let Some(event) = tokio::time::timeout(Duration::from_secs(60), reader.next()).await.expect("no stall") {
        match event {
            ShellEvent::Output(data) => {
                total += data.len();
                partial.push_str(std::str::from_utf8(&data).expect("ascii"));
                while let Some(nl) = partial.find('\n') {
                    let line: u64 = partial[..nl].parse().expect("a number");
                    assert_eq!(line, expected, "output lost or reordered");
                    expected += 1;
                    partial.drain(..=nl);
                }
                if !stalled && total > 1_000_000 {
                    stalled = true;
                    // Stop reading while the server still has ~20 MiB to send.
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
            ShellEvent::ExitStatus(code) => exit = Some(code),
            _ => {}
        }
    }
    assert!(stalled);
    assert_eq!(expected, LAST + 1, "all lines received");
    assert!(partial.is_empty());
    assert_eq!(exit, Some(0));
    let expected_bytes: usize = (1..=LAST).map(|n| n.to_string().len() + 1).sum();
    assert_eq!(total, expected_bytes);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn binary_and_empty_output_are_delivered_verbatim() {
    let lab = Lab::load();
    let conn = connected(&lab).await;
    // Every byte value, including NUL, ESC and invalid UTF-8, plus a command with no output.
    let out = conn
        .exec(
            "i=0; while [ $i -lt 256 ]; do printf \"\\\\$(printf %03o $i)\"; i=$((i+1)); done",
            4096,
            Duration::from_secs(20),
        )
        .await
        .unwrap();
    assert_eq!(out.stdout, (0..=255u8).collect::<Vec<u8>>());
    let empty = conn.exec("true", 16, Duration::from_secs(10)).await.unwrap();
    assert!(empty.stdout.is_empty() && empty.stderr.is_empty());
    assert_eq!(empty.exit_status, Some(0));
    // The output cap is enforced.
    let err = conn.exec("head -c 100000 /dev/zero", 1000, Duration::from_secs(10)).await.expect_err("capped");
    assert_eq!(err, SshError::LimitExceeded);
}

// ---------- failure handling ----------

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn refused_silent_and_invalid_destinations_fail_promptly() {
    let _lab = Lab::load();
    // Refused: bind then drop to get a port nothing listens on.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let err = connect(&options(Endpoint::new("127.0.0.1", closed.port())), Pinned(String::new())).await.unwrap_err();
    assert_eq!(err, SshError::Unreachable);

    // Accepts TCP but never speaks SSH: the handshake deadline fires.
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = silent.accept().await {
            held.push(socket);
        }
    });
    let mut opts = options(Endpoint::new("127.0.0.1", port));
    opts.handshake_timeout = Duration::from_millis(400);
    let started = std::time::Instant::now();
    let err = connect(&opts, Pinned(String::new())).await.unwrap_err();
    assert_eq!(err, SshError::Timeout(Stage::KeyExchange));
    assert!(started.elapsed() < Duration::from_secs(3));

    for (host, port) in [("", 22), ("host.invalid", 22), ("127.0.0.1", 0)] {
        let err = connect(&options(Endpoint::new(host, port)), Pinned(String::new())).await.unwrap_err();
        assert_eq!(err, SshError::Resolve, "{host}:{port}");
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_slow_trust_decision_is_not_cut_off_by_the_handshake_deadline() {
    struct Slow(String);
    impl HostKeyVerifier for Slow {
        async fn verify(&mut self, request: &HostKeyRequest) -> TrustVerdict {
            tokio::time::sleep(Duration::from_millis(1500)).await; // a human reading a fingerprint
            if request.key.public_key == self.0 {
                TrustVerdict::Accept
            } else {
                TrustVerdict::Reject(RejectReason::Changed)
            }
        }
    }
    let lab = Lab::load();
    let mut opts = options(lab.endpoint("a"));
    opts.handshake_timeout = Duration::from_millis(700);
    let mut conn = connect(&opts, Slow(lab.host_key("a"))).await.expect("prompt time is excluded");
    let key = lab.key("ed25519", None).unwrap();
    assert!(conn.authenticate_key(&lab.user(), &key).await.unwrap().is_success());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn disconnect_during_authentication_and_mid_session_is_reported_not_hung() {
    let lab = Lab::load();
    let forwarder = Forwarder::start("127.0.0.1:0", lab.addr("a")).await;
    let endpoint = Endpoint::new("127.0.0.1", forwarder.local.port());

    // Link drops after host verification, before the authentication reply.
    let mut conn = connect(&options(endpoint.clone()), Pinned(lab.host_key("a"))).await.unwrap();
    forwarder.cut_all();
    let err = conn.authenticate_password(&lab.user(), lab.password()).await.expect_err("link is gone");
    assert!(matches!(err, SshError::Disconnected(Stage::Authenticating)), "{err:?}");
    assert!(!conn.is_authenticated());

    // Link drops while a shell is open: the reader ends instead of waiting forever.
    let mut conn = connect(&options(endpoint), Pinned(lab.host_key("a"))).await.unwrap();
    let key = lab.key("ed25519", None).unwrap();
    assert!(conn.authenticate_key(&lab.user(), &key).await.unwrap().is_success());
    let pty = PtyRequest { term: "xterm".into(), cols: 80, rows: 24 };
    let (mut reader, writer) = conn.open_shell(&pty).await.unwrap();
    writer.write(b"echo alive-$((40+2))\n").await.unwrap();
    read_until(&mut reader, "alive-42\r\n", Duration::from_secs(10)).await;
    forwarder.cut_all();
    let events = tokio::time::timeout(Duration::from_secs(10), async {
        let mut events = Vec::new();
        while let Some(event) = reader.next().await {
            events.push(event);
        }
        events
    })
    .await
    .expect("reader must end after the link drops");
    assert!(
        matches!(events.last(), Some(ShellEvent::ConnectionLost)),
        "a dropped link is reported as lost: {events:?}"
    );

    // The server process dies (as when a host reboots): also lost, not a normal end.
    let conn = connected(&lab).await;
    let (mut reader, writer) = conn.open_shell(&pty).await.unwrap();
    writer.write(b"echo alive-$((40+2)); kill -9 $PPID\n").await.unwrap();
    let events = tokio::time::timeout(Duration::from_secs(10), async {
        let mut events = Vec::new();
        while let Some(event) = reader.next().await {
            events.push(event);
        }
        events
    })
    .await
    .expect("reader must end after the server process dies");
    assert!(matches!(events.last(), Some(ShellEvent::ConnectionLost)), "{events:?}");
    assert!(reader.next().await.is_none(), "nothing follows ConnectionLost");
}

#[test]
fn presented_host_key_is_plain_public_data() {
    // Compile-time shape check used by the trust dialog DTOs.
    let key = PresentedHostKey {
        algorithm: "ssh-ed25519".into(),
        fingerprint: "SHA256:x".into(),
        public_key: "ssh-ed25519 AAAA".into(),
    };
    assert_eq!(key.clone(), key);
}

// ---------- RSA keys whose modulus is not a whole number of 64-bit words ----------

/// An RSA key made by `ssh-keygen` for this run, authorised for the lab user in
/// `~/.ssh/authorized_keys` (tagged with a unique comment) until dropped.
struct GeneratedRsaKey {
    key: ClientKey,
    tag: String,
    dir: PathBuf,
}

impl GeneratedRsaKey {
    async fn new(lab: &Lab, bits: u32) -> Self {
        let tag = format!("tyrminal-lab-rsa{bits}-{}", std::process::id());
        let dir = std::env::temp_dir().join(&tag);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_rsa");
        let status = Command::new("ssh-keygen")
            .args(["-q", "-t", "rsa", "-b", &bits.to_string(), "-N", "", "-C", &tag, "-f"])
            .arg(&path)
            .status()
            .expect("ssh-keygen runs");
        assert!(status.success(), "ssh-keygen -b {bits}");
        let public = std::fs::read_to_string(path.with_extension("pub")).unwrap();
        let key = ClientKey::from_openssh(&std::fs::read_to_string(&path).unwrap(), None).unwrap();
        // Authorised through the server itself, signed in with the lab password.
        let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
        assert!(conn.authenticate_password(&lab.user(), lab.password()).await.unwrap().is_success());
        let cmd = format!(
            "umask 077; mkdir -p ~/.ssh && printf '%s\\n' '{}' >> ~/.ssh/authorized_keys && echo added",
            public.trim()
        );
        let out = conn.exec(&cmd, 64, Duration::from_secs(10)).await.unwrap();
        assert_eq!(out.stdout, b"added\n");
        Self { key, tag, dir }
    }

    async fn remove(self, lab: &Lab) {
        let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
        assert!(conn.authenticate_password(&lab.user(), lab.password()).await.unwrap().is_success());
        let cmd = format!(
            "grep -vF '{tag}' ~/.ssh/authorized_keys > ~/.ssh/ak.{tag}; mv ~/.ssh/ak.{tag} ~/.ssh/authorized_keys",
            tag = self.tag
        );
        conn.exec(&cmd, 64, Duration::from_secs(10)).await.unwrap();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn rsa_keys_of_any_size_sign_in_with_a_signature_of_exactly_the_modulus_length() {
    let lab = Lab::load();
    // 4048 and 4000 bits are not multiples of 64, which is where a signature padded to whole
    // words came out longer than the modulus and OpenSSH refused the key. 3072 is the control.
    for bits in [4048, 4000, 3072] {
        let generated = GeneratedRsaKey::new(&lab, bits).await;
        let mut conn = connect(&options(lab.endpoint("a")), Pinned(lab.host_key("a"))).await.unwrap();
        let outcome = conn.authenticate_key(&lab.user(), &generated.key).await.unwrap();
        generated.remove(&lab).await;
        assert_eq!(outcome, AuthOutcome::Success, "a {bits}-bit RSA key signs in");
        let out = conn.exec("echo ok", 64, Duration::from_secs(10)).await.unwrap();
        assert_eq!(out.stdout, b"ok\n");
    }
}

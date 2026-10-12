//! Compromised-password check (SEC-11) end to end against a stub range server started in this
//! test on loopback. The real service is never contacted. The test client speaks plain HTTP to
//! the stub; what matters here is what the core hands it: only 5-character hash prefixes.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tyrminal_core::Core;
use tyrminal_core::contracts::{
    ErrorCode, HostAuthInput, HostInput, IdentityInput, PasswordCheckPreferences, SecretChange, StoredPasswordKind,
};
use tyrminal_core::password_check::{HashPrefix, MAX_RANGE_RESPONSE, NoRangeSource, RangeError, RangeSource};

const PASSPHRASE: &str = "correct horse battery staple";
/// SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8.
const BREACHED: &str = "password";
const BREACHED_SUFFIX: &str = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

/// What the stub answers for a prefix.
#[derive(Clone, Copy)]
enum Mode {
    Normal,
    Garbled,
    ServerError,
}

struct Stub {
    addr: SocketAddr,
    /// Every request head the stub received, verbatim.
    requests: Arc<Mutex<Vec<String>>>,
    mode: Arc<Mutex<Mode>>,
}

async fn start_stub() -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mode = Arc::new(Mutex::new(Mode::Normal));
    let (seen, how) = (Arc::clone(&requests), Arc::clone(&mode));
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let (seen, how) = (Arc::clone(&seen), Arc::clone(&how));
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                seen.lock().unwrap().push(head);
                let prefix = path.rsplit('/').next().unwrap_or("");
                let mode = *how.lock().unwrap();
                let (status, body) = match mode {
                    Mode::ServerError => ("500 Internal Server Error", "oops".to_owned()),
                    Mode::Garbled => ("200 OK", "<html>not a range</html>".to_owned()),
                    Mode::Normal => {
                        // Padded like the real service: real-looking entries plus count-0 lines.
                        let mut lines: Vec<String> = (0..40).map(|i| format!("{:035X}:{}", i * 7919, i + 1)).collect();
                        lines.extend((0..60).map(|i| format!("{:035X}:0", 0xF000_0000u64 + i)));
                        if prefix == "5BAA6" {
                            lines.push(format!("{BREACHED_SUFFIX}:10434004"));
                        }
                        ("200 OK", lines.join("\r\n"))
                    }
                };
                let reply =
                    format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    Stub { addr, requests, mode }
}

/// A test-only HTTP/1.1 client for the stub: GET `<endpoint path><prefix>` with padding asked for.
struct StubSource {
    addr: SocketAddr,
}

impl RangeSource for StubSource {
    fn available(&self) -> bool {
        true
    }
    fn fetch<'a>(
        &'a self,
        endpoint: &'a str,
        prefix: &'a HashPrefix,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, RangeError>> + Send + 'a>> {
        Box::pin(async move {
            let path = endpoint.strip_prefix("https://").and_then(|r| r.find('/').map(|i| &r[i..])).unwrap_or("/");
            let mut stream = TcpStream::connect(self.addr).await.map_err(|_| RangeError::Unreachable)?;
            let request = format!(
                "GET {path}{} HTTP/1.1\r\nHost: stub.test\r\nAdd-Padding: true\r\nConnection: close\r\n\r\n",
                prefix.as_str()
            );
            stream.write_all(request.as_bytes()).await.map_err(|_| RangeError::Unreachable)?;
            let mut reply = Vec::new();
            stream
                .take((MAX_RANGE_RESPONSE + 4096) as u64)
                .read_to_end(&mut reply)
                .await
                .map_err(|_| RangeError::Unreachable)?;
            let split = reply.windows(4).position(|w| w == b"\r\n\r\n").ok_or(RangeError::Malformed)?;
            if !reply.starts_with(b"HTTP/1.1 200 ") {
                return Err(RangeError::Unreachable);
            }
            Ok(reply[split + 4..].to_vec())
        })
    }
}

async fn vault_with_passwords(dir: &TempDir) -> Core {
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let v = &core.vault;
    for (label, password) in [("web", BREACHED), ("db", BREACHED), ("cache", "Unique-Synthetic-9f2c71")] {
        v.save_host(HostInput {
            id: None,
            label: label.into(),
            address: format!("{label}.example"),
            port: None,
            username: "u".into(),
            auth: HostAuthInput::StoredPassword { password: Some(password.into()) },
            group_id: None,
            tags: Vec::new(),
            protocol: tyrminal_core::contracts::HostProtocol::Ssh,
            terminal: Default::default(),
            forward_agent: false,
            production: false,
        })
        .await
        .unwrap();
    }
    v.save_identity(IdentityInput {
        id: None,
        label: "Ops".into(),
        username: "ops".into(),
        password: SecretChange::Set { value: "Another-Synthetic-4410aa".into() },
        key_id: None,
    })
    .await
    .unwrap();
    core
}

fn enable(core: &Core, endpoint: &str) {
    let mut prefs = core.preferences.get();
    prefs.password_check = PasswordCheckPreferences { enabled: true, endpoint: endpoint.into() };
    core.preferences.set(prefs).unwrap();
}

#[tokio::test]
async fn off_by_default_and_nothing_is_sent_until_turned_on() {
    let dir = TempDir::new().unwrap();
    let core = vault_with_passwords(&dir).await;
    let stub = start_stub().await;
    let source = StubSource { addr: stub.addr };

    assert!(!core.preferences.get().password_check.enabled, "off on a new install");
    let status = core.password_check_status(&source).await.unwrap();
    assert_eq!((status.enabled, status.available, status.stored_passwords), (false, true, 3));
    let refused = core.check_stored_passwords(&source).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::InvalidInput);
    assert!(stub.requests.lock().unwrap().is_empty(), "no request while the check is off");

    // A plain-http or credential-carrying endpoint is refused when it is saved.
    let mut prefs = core.preferences.get();
    prefs.password_check = PasswordCheckPreferences { enabled: true, endpoint: "http://stub.test/range/".into() };
    assert!(core.preferences.set(prefs.clone()).is_err());
    prefs.password_check.endpoint = "https://user:pw@stub.test/range/".into();
    assert!(core.preferences.set(prefs).is_err());
}

#[tokio::test]
async fn only_hash_prefixes_leave_and_matches_are_found_through_padding() {
    let dir = TempDir::new().unwrap();
    let core = vault_with_passwords(&dir).await;
    let stub = start_stub().await;
    enable(&core, "https://stub.test/range");

    let report = core.check_stored_passwords(&StubSource { addr: stub.addr }).await.unwrap();
    let found: Vec<(&str, u64)> = report.items.iter().map(|i| (i.label.as_str(), i.breach_count)).collect();
    assert_eq!(found, [("db", 10_434_004), ("web", 10_434_004), ("Ops", 0), ("cache", 0)]);
    assert_eq!(report.items.iter().find(|i| i.label == "Ops").unwrap().kind, StoredPasswordKind::Identity);
    // "password" is stored twice but looked up once: three distinct prefixes, three requests.
    assert_eq!(report.requests, 3);

    let requests = stub.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    for head in &requests {
        let path = head.split_whitespace().nth(1).unwrap();
        let prefix = path.strip_prefix("/range/").expect("the configured path plus the prefix");
        assert!(
            prefix.len() == 5 && prefix.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase()),
            "{path}"
        );
        assert!(head.contains("Add-Padding: true"));
        // Nothing else about the passwords is in the request.
        for secret in [BREACHED, BREACHED_SUFFIX, "Unique-Synthetic-9f2c71", "Another-Synthetic-4410aa"] {
            assert!(!head.contains(secret), "{head}");
        }
    }
}

#[tokio::test]
async fn failures_never_read_as_all_clear() {
    let dir = TempDir::new().unwrap();
    let core = vault_with_passwords(&dir).await;
    let stub = start_stub().await;
    enable(&core, "https://stub.test/range/");
    let source = StubSource { addr: stub.addr };

    *stub.mode.lock().unwrap() = Mode::Garbled;
    assert_eq!(core.check_stored_passwords(&source).await.unwrap_err().code, ErrorCode::ProtocolError);
    *stub.mode.lock().unwrap() = Mode::ServerError;
    assert_eq!(core.check_stored_passwords(&source).await.unwrap_err().code, ErrorCode::Unreachable);
    // Nobody listening.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    assert_eq!(
        core.check_stored_passwords(&StubSource { addr: closed }).await.unwrap_err().code,
        ErrorCode::Unreachable
    );

    // This build's own source cannot make requests: the status says so and a run is refused.
    let status = core.password_check_status(&NoRangeSource).await.unwrap();
    assert!(!status.available && status.unavailable_reason.is_some());
    assert_eq!(core.check_stored_passwords(&NoRangeSource).await.unwrap_err().code, ErrorCode::Unreachable);

    // Locked vault: nothing to read, nothing sent.
    *stub.mode.lock().unwrap() = Mode::Normal;
    let before = stub.requests.lock().unwrap().len();
    core.vault.lock().await;
    assert_eq!(core.check_stored_passwords(&source).await.unwrap_err().code, ErrorCode::VaultLocked);
    assert_eq!(stub.requests.lock().unwrap().len(), before);
}

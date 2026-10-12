//! Saved tunnels through the application core against the real OpenSSH lab: vault rule →
//! connected session (host trust and authentication as for the terminal) → forward → cleanup.
//!
//! Run with `pnpm lab:up && cargo test -p tyrminal-core --test tunnels_lab -- --ignored`. The
//! forwarding paths need the container-free lab (`TYRMINAL_LAB_MODE=local`), whose sshd shares
//! this machine's loopback with the test's destination services.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tyrminal_core::contracts::{
    ActiveTunnel, ErrorCode, HostAuthInput, HostInput, KeyImportInput, SessionEvent, SessionState, TrustDecision,
    TunnelInput, TunnelKind, TunnelState,
};
use tyrminal_core::{Core, SessionSink};

const PASSPHRASE: &str = "correct horse battery staple";
const WINDOW: &str = "main";
const OTHER_WINDOW: &str = "other";
const WAIT: Duration = Duration::from_secs(20);

struct Lab(Value);

impl Lab {
    fn load() -> Self {
        let path = std::env::var_os("TYRMINAL_LAB")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/ssh-lab/.run/lab.json"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("SSH lab is not running ({}). Run `pnpm lab:up` first.", path.display()));
        let lab = Self(serde_json::from_str(&text).unwrap());
        assert_eq!(
            lab.0.pointer("/mode").and_then(Value::as_str),
            Some("local"),
            "tunnel tests need the container-free lab (TYRMINAL_LAB_MODE=local)"
        );
        lab
    }
    fn str(&self, pointer: &str) -> String {
        self.0.pointer(pointer).and_then(Value::as_str).unwrap_or_else(|| panic!("lab.json: {pointer}")).to_owned()
    }
    fn port(&self) -> u16 {
        self.port_of("a")
    }
    fn port_of(&self, server: &str) -> u16 {
        self.0.pointer(&format!("/servers/{server}/port")).and_then(Value::as_u64).unwrap() as u16
    }
    /// Authentication activity in a lab server's sshd log (local lab: a file).
    fn auth_log_lines(&self, server: &str) -> usize {
        let file = self.str(&format!("/servers/{server}/logFile"));
        let text = std::fs::read_to_string(file).expect("lab sshd log");
        text.lines()
            .filter(|l| ["Accepted ", "Failed ", "Postponed ", "userauth"].iter().any(|n| l.contains(n)))
            .count()
    }
}

/// Tests that assert on a server's authentication log run one at a time.
static AUTH_LOG: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One stable local endpoint whose backend can be switched (to present a different host key).
struct Forwarder {
    port: u16,
    target: Arc<std::sync::Mutex<SocketAddr>>,
}

impl Forwarder {
    async fn start(target: SocketAddr) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = Arc::new(std::sync::Mutex::new(target));
        let shared = Arc::clone(&target);
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let backend = *shared.lock().unwrap();
                tokio::spawn(async move {
                    if let Ok(mut outbound) = TcpStream::connect(backend).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
            }
        });
        Self { port, target }
    }
    fn retarget(&self, target: SocketAddr) {
        *self.target.lock().unwrap() = target;
    }
}

struct EventSink(mpsc::UnboundedSender<SessionEvent>);

impl SessionSink for EventSink {
    fn output(&self, _data: Vec<u8>) -> bool {
        true
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.0.send(event).is_ok()
    }
}

struct Fixture {
    _dir: TempDir,
    core: Core,
    lab: Lab,
}

async fn fixture() -> Fixture {
    let lab = Lab::load();
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    Fixture { _dir: dir, core, lab }
}

/// An open SSH session that has reached the shell.
struct Session {
    id: String,
    events: mpsc::UnboundedReceiver<SessionEvent>,
}

impl Session {
    async fn closed(&mut self) -> Option<ErrorCode> {
        loop {
            match tokio::time::timeout(WAIT, self.events.recv()).await.expect("session closes in time") {
                Some(SessionEvent::Closed { error, .. }) => return error.map(|e| e.code),
                Some(_) => {}
                None => panic!("event channel closed"),
            }
        }
    }
}

impl Fixture {
    async fn host(&self, user: &str) -> String {
        self.host_at(user, &format!("lab {user}"), self.lab.port()).await
    }

    async fn host_at(&self, user: &str, label: &str, port: u16) -> String {
        let key_id = match self.core.vault.list_keys().await.unwrap().into_iter().next() {
            Some(key) => key.id,
            None => {
                let key = KeyImportInput {
                    label: "lab ed25519".into(),
                    private_key: std::fs::read_to_string(self.lab.str("/keys/ed25519")).unwrap(),
                    passphrase: None,
                    remember_passphrase: false,
                };
                self.core.vault.import_key(key).await.unwrap().id
            }
        };
        let input = HostInput {
            id: None,
            label: label.into(),
            address: "127.0.0.1".into(),
            port: Some(port),
            username: user.into(),
            auth: HostAuthInput::Key { key_id },
            group_id: None,
            tags: Vec::new(),
        };
        self.core.vault.save_host(input).await.unwrap().id
    }

    /// Opens a session, trusting the host key once, and waits for the shell.
    async fn connect(&self, window: &str, host_id: &str) -> Session {
        self.connect_trusting(window, host_id, TrustDecision::Once).await
    }

    /// Opens a session, answering every trust prompt with `decision`, and waits for the shell.
    async fn connect_trusting(&self, window: &str, host_id: &str, decision: TrustDecision) -> Session {
        let (tx, mut events) = mpsc::unbounded_channel();
        let opened = self.core.sessions.open_ssh(window, host_id, 80, 24, Arc::new(EventSink(tx))).await.unwrap();
        loop {
            match tokio::time::timeout(WAIT, events.recv()).await.expect("connect in time").unwrap() {
                SessionEvent::TrustPrompt { prompt_id, .. } => {
                    self.core.sessions.answer_trust(window, &opened.session_id, &prompt_id, decision).unwrap();
                }
                SessionEvent::State { state: SessionState::Connected } => break,
                SessionEvent::Closed { error, .. } => panic!("session closed while connecting: {error:?}"),
                _ => {}
            }
        }
        Session { id: opened.session_id, events }
    }

    async fn rule(&self, host_id: &str, kind: TunnelKind, dest_port: u16) -> String {
        self.save(TunnelInput {
            id: None,
            name: format!("{kind:?} rule"),
            host_id: host_id.into(),
            kind,
            bind_host: String::new(),
            bind_port: 0,
            dest_host: "127.0.0.1".into(),
            dest_port,
            allow_external: false,
            auto_start: false,
        })
        .await
    }

    async fn save(&self, input: TunnelInput) -> String {
        self.core.vault.save_tunnel(input).await.unwrap().id
    }

    fn active(&self, window: &str) -> Vec<ActiveTunnel> {
        self.core.sessions.active_tunnels(window)
    }

    /// Waits until the run reaches `state`.
    async fn until_state(&self, window: &str, run_id: &str, state: TunnelState) -> ActiveTunnel {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(run) = self.active(window).into_iter().find(|r| r.run_id == run_id && r.state == state) {
                return run;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "run {run_id} never reached {state:?}: {:?}",
                self.active(window)
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

async fn echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = stream.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

async fn echoes(addr: SocketAddr, payload: &[u8]) -> bool {
    let Ok(mut s) = TcpStream::connect(addr).await else { return false };
    s.write_all(payload).await.unwrap();
    let mut back = vec![0u8; payload.len()];
    matches!(tokio::time::timeout(WAIT, s.read_exact(&mut back)).await, Ok(Ok(_))) && back == payload
}

fn loopback(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_saved_local_rule_runs_on_a_session_and_stops_on_request() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let echo = echo_server().await;
    let rule = f.rule(&host, TunnelKind::Local, echo).await;
    let mut session = f.connect(WINDOW, &host).await;

    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &rule).await.unwrap();
    assert_eq!((run.state, run.bind_host.as_str()), (TunnelState::Running, "127.0.0.1"));
    assert_ne!(run.bound_port, 0);
    assert!(echoes(loopback(run.bound_port), b"via the saved rule").await);

    // The same rule twice on one session is refused; the listener stays as it was.
    let again = f.core.sessions.start_tunnel(WINDOW, &session.id, &rule).await.unwrap_err();
    assert_eq!(again.code, ErrorCode::Conflict);

    let listed = f.active(WINDOW);
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].total_connections, listed[0].bytes_out), (1, 18));

    f.core.sessions.stop_tunnel(WINDOW, &run.run_id).await.unwrap();
    assert!(TcpStream::connect(loopback(run.bound_port)).await.is_err(), "stopped means the listener is closed");
    assert_eq!(f.active(WINDOW)[0].state, TunnelState::Stopped);
    f.core.sessions.clear_ended_tunnels(WINDOW);
    assert!(f.active(WINDOW).is_empty());

    f.core.sessions.close(WINDOW, &session.id).unwrap();
    assert_eq!(session.closed().await, None);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn closing_or_locking_ends_every_forward_of_the_session() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let echo = echo_server().await;
    let local = f.rule(&host, TunnelKind::Local, echo).await;
    let socks = f.rule(&host, TunnelKind::Dynamic, 0).await;
    let remote = f.rule(&host, TunnelKind::Remote, echo).await;

    let mut session = f.connect(WINDOW, &host).await;
    let mut ports = Vec::new();
    for rule in [&local, &socks, &remote] {
        ports.push(f.core.sessions.start_tunnel(WINDOW, &session.id, rule).await.unwrap());
    }
    // The remote listener is on the server, which is this machine in the local lab.
    assert!(echoes(loopback(ports[2].bound_port), b"remote").await);

    f.core.sessions.close(WINDOW, &session.id).unwrap();
    assert_eq!(session.closed().await, None);
    for run in &ports {
        let ended = f.until_state(WINDOW, &run.run_id, TunnelState::SessionEnded).await;
        assert_eq!(ended.active_connections, 0);
        if run.kind == TunnelKind::Remote {
            // The server's listener: sshd closes it once it sees the connection end, which can
            // trail our side by a moment. Bounded wait, never an open-ended one.
            let deadline = tokio::time::Instant::now() + WAIT;
            while TcpStream::connect(loopback(run.bound_port)).await.is_ok() {
                assert!(tokio::time::Instant::now() < deadline, "the server kept listening after the session ended");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        } else {
            // Our own listeners are closed by the time the run reports that it ended.
            assert!(
                TcpStream::connect(loopback(run.bound_port)).await.is_err(),
                "{:?} listener outlived its session",
                run.kind
            );
        }
    }

    // Locking ends the session and its forwards, and nothing about them is listed afterwards.
    let mut session = f.connect(WINDOW, &host).await;
    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &local).await.unwrap();
    f.core.vault.lock().await;
    assert_eq!(session.closed().await, Some(ErrorCode::VaultLocked));
    assert!(TcpStream::connect(loopback(run.bound_port)).await.is_err());
    assert!(f.active(WINDOW).is_empty(), "runs of a locked vault generation are not shown");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn auto_start_rules_start_with_each_connection_and_failures_are_listed() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let echo = echo_server().await;
    let taken = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut input = TunnelInput {
        id: None,
        name: "auto".into(),
        host_id: host.clone(),
        kind: TunnelKind::Local,
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        dest_host: "127.0.0.1".into(),
        dest_port: echo,
        allow_external: false,
        auto_start: true,
    };
    f.save(input.clone()).await;
    input.name = "busy port".into();
    input.bind_port = taken.local_addr().unwrap().port();
    f.save(input).await;

    for _ in 0..2 {
        let mut session = f.connect(WINDOW, &host).await;
        let deadline = tokio::time::Instant::now() + WAIT;
        let (running, failed) = loop {
            let list = f.active(WINDOW);
            let running = list.iter().find(|r| r.name == "auto" && r.state == TunnelState::Running).cloned();
            let failed = list.iter().find(|r| r.name == "busy port" && r.state == TunnelState::Failed).cloned();
            if let (Some(r), Some(x)) = (running, failed) {
                break (r, x);
            }
            assert!(tokio::time::Instant::now() < deadline, "auto-start did not settle: {list:?}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        assert_eq!(failed.error.map(|e| e.code), Some(ErrorCode::InUse));
        assert!(echoes(loopback(running.bound_port), b"auto").await);
        f.core.sessions.close(WINDOW, &session.id).unwrap();
        session.closed().await;
        f.until_state(WINDOW, &running.run_id, TunnelState::SessionEnded).await;
        f.core.sessions.clear_ended_tunnels(WINDOW);
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn forwards_are_scoped_to_the_window_session_and_host() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let other_host = f.host(&f.lab.str("/noForwardUser")).await;
    let echo = echo_server().await;
    let rule = f.rule(&host, TunnelKind::Local, echo).await;
    let foreign_rule = f.rule(&other_host, TunnelKind::Local, echo).await;
    let session = f.connect(WINDOW, &host).await;

    // Another window can neither start a forward on this session nor see or stop one.
    let denied = f.core.sessions.start_tunnel(OTHER_WINDOW, &session.id, &rule).await.unwrap_err();
    assert_eq!(denied.code, ErrorCode::AccessDenied);
    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &rule).await.unwrap();
    assert!(f.active(OTHER_WINDOW).is_empty());
    assert_eq!(f.core.sessions.stop_tunnel(OTHER_WINDOW, &run.run_id).await.unwrap_err().code, ErrorCode::AccessDenied);
    assert!(echoes(loopback(run.bound_port), b"still running").await);

    // A rule for a different host never runs over this session's server.
    let wrong = f.core.sessions.start_tunnel(WINDOW, &session.id, &foreign_rule).await.unwrap_err();
    assert_eq!(wrong.code, ErrorCode::InvalidInput);
    // Guessed ids answer nothing.
    let guessed = f.core.sessions.start_tunnel(WINDOW, &session.id, "00000000000000000000000000000000").await;
    assert_eq!(guessed.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(f.core.sessions.stop_tunnel(WINDOW, "nope").await.unwrap_err().code, ErrorCode::AccessDenied);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_server_that_denies_forwarding_is_reported() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/noForwardUser")).await;
    let echo = echo_server().await;
    let remote = f.rule(&host, TunnelKind::Remote, echo).await;
    let local = f.rule(&host, TunnelKind::Local, echo).await;
    let session = f.connect(WINDOW, &host).await;

    let refused = f.core.sessions.start_tunnel(WINDOW, &session.id, &remote).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::ChannelDenied);

    // The local listener opens, but every connection through it is refused by the server and
    // counted as failed, never as carried.
    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &local).await.unwrap();
    assert!(!echoes(loopback(run.bound_port), b"x").await);
    let deadline = tokio::time::Instant::now() + WAIT;
    while f.active(WINDOW)[0].failed_connections == 0 {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(f.active(WINDOW)[0].bytes_in, 0);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn an_approved_external_rule_binds_and_an_unapproved_one_cannot_be_saved() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let mut input = TunnelInput {
        id: None,
        name: "lan".into(),
        host_id: host.clone(),
        kind: TunnelKind::Dynamic,
        bind_host: "0.0.0.0".into(),
        bind_port: 0,
        dest_host: String::new(),
        dest_port: 0,
        allow_external: false,
        auto_start: false,
    };
    let refused = f.core.vault.save_tunnel(input.clone()).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::InvalidInput);
    assert!(f.core.vault.list_tunnels().await.unwrap().is_empty());

    input.allow_external = true;
    let saved = f.core.vault.save_tunnel(input).await.unwrap();
    assert!(saved.allow_external);
    let session = f.connect(WINDOW, &host).await;
    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &saved.id).await.unwrap();
    assert_eq!(run.bind_host, "0.0.0.0");
    assert!(TcpStream::connect(loopback(run.bound_port)).await.is_ok());

    // Rules survive a lock and unlock (they are vault records), duplicates never auto-start.
    let copy = f.core.vault.duplicate_tunnel(&saved.id).await.unwrap();
    assert_eq!((copy.name.as_str(), copy.auto_start, copy.allow_external), ("lan (copy)", false, true));
    f.core.vault.lock().await;
    f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let names: Vec<_> = f.core.vault.list_tunnels().await.unwrap().into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["lan", "lan (copy)"]);
}

// ---------- jump hosts ----------

/// Opens a session and returns the events up to the first that needs an answer or ends it.
async fn open_until_prompt(f: &Fixture, host_id: &str) -> (String, mpsc::UnboundedReceiver<SessionEvent>) {
    let (tx, events) = mpsc::unbounded_channel();
    let opened = f.core.sessions.open_ssh(WINDOW, host_id, 80, 24, Arc::new(EventSink(tx))).await.unwrap();
    (opened.session_id, events)
}

/// The next event other than progress (state changes, negotiated algorithms, banners).
async fn next_decision(events: &mut mpsc::UnboundedReceiver<SessionEvent>) -> SessionEvent {
    loop {
        match tokio::time::timeout(WAIT, events.recv()).await.expect("event in time").expect("channel open") {
            SessionEvent::State { state } if state != SessionState::Connected => {}
            SessionEvent::Negotiated { .. } | SessionEvent::Banner { .. } => {}
            other => return other,
        }
    }
}

async fn jump_to(f: &Fixture, host: &str, via: &str) {
    let connection = tyrminal_core::contracts::HostConnection { jump_host_id: Some(via.into()) };
    f.core.vault.set_host_connection(host, connection).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_jump_chain_verifies_and_signs_in_to_every_hop_in_order() {
    let f = fixture().await;
    let _log = AUTH_LOG.lock().await;
    let user = f.lab.str("/user");
    let bastion = f.host_at(&user, "bastion", f.lab.port_of("a")).await;
    let inner = f.host_at(&user, "inner", f.lab.port_of("b")).await;
    jump_to(&f, &inner, &bastion).await;
    let chain = f.core.vault.host_chain(&inner).await.unwrap();
    let ports: Vec<_> = chain.iter().map(|h| (h.label.as_str(), h.port)).collect();
    assert_eq!(ports, [("bastion", f.lab.port_of("a")), ("inner", f.lab.port_of("b"))]);
    let b_before = f.lab.auth_log_lines("b");

    let (session, mut events) = open_until_prompt(&f, &inner).await;
    // First the bastion's key, and nothing has reached the inner server yet.
    let SessionEvent::TrustPrompt { prompt_id, port, fingerprint, .. } = next_decision(&mut events).await else {
        panic!("expected the bastion's trust prompt")
    };
    assert_eq!((port, fingerprint), (f.lab.port_of("a"), f.lab.str("/servers/a/hostKeyEd25519Fingerprint")));
    assert_eq!(f.lab.auth_log_lines("b"), b_before);
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Always).unwrap();
    // Then the inner server's own key, verified end to end through the bastion's channel.
    let SessionEvent::TrustPrompt { prompt_id, port, fingerprint, resolved_address, .. } =
        next_decision(&mut events).await
    else {
        panic!("expected the inner host's trust prompt")
    };
    assert_eq!((port, fingerprint), (f.lab.port_of("b"), f.lab.str("/servers/b/hostKeyEd25519Fingerprint")));
    assert_eq!(resolved_address, None, "a hop reached through a bastion has no locally resolved address");
    assert_eq!(f.lab.auth_log_lines("b"), b_before, "no credential before the inner key is trusted");
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Always).unwrap();
    assert_eq!(next_decision(&mut events).await, SessionEvent::State { state: SessionState::Connected });
    assert!(f.lab.auth_log_lines("b") > b_before, "the inner server saw the sign-in");

    // A tunnel on the chained session runs through every hop (FWD-09).
    let echo = echo_server().await;
    let rule = f.rule(&inner, TunnelKind::Local, echo).await;
    let run = f.core.sessions.start_tunnel(WINDOW, &session, &rule).await.unwrap();
    assert!(echoes(loopback(run.bound_port), b"through two hops").await);

    f.core.sessions.close(WINDOW, &session).unwrap();
    // Both keys are remembered: the next connection asks nothing.
    let mut again = f.connect(WINDOW, &inner).await;
    f.core.sessions.close(WINDOW, &again.id).unwrap();
    assert_eq!(again.closed().await, None);
    assert_eq!(f.core.vault.list_known_hosts().await.unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_changed_bastion_key_blocks_the_chain_before_any_credential_is_sent() {
    let f = fixture().await;
    let _log = AUTH_LOG.lock().await;
    let user = f.lab.str("/user");
    let forwarder = Forwarder::start(SocketAddr::from(([127, 0, 0, 1], f.lab.port_of("a")))).await;
    let bastion = f.host_at(&user, "bastion", forwarder.port).await;
    let inner = f.host_at(&user, "inner", f.lab.port_of("b")).await;
    jump_to(&f, &inner, &bastion).await;

    let mut first = f.connect_trusting(WINDOW, &inner, TrustDecision::Always).await;
    f.core.sessions.close(WINDOW, &first.id).unwrap();
    first.closed().await;

    assert_eq!(f.core.vault.list_known_hosts().await.unwrap().len(), 2, "both hops trusted");
    // The bastion's endpoint now answers with another server's key.
    forwarder.retarget(SocketAddr::from(([127, 0, 0, 1], f.lab.port_of("kbd"))));
    let (impostor_before, inner_before) = (f.lab.auth_log_lines("kbd"), f.lab.auth_log_lines("b"));
    let (_session, mut events) = open_until_prompt(&f, &inner).await;
    match next_decision(&mut events).await {
        SessionEvent::HostKeyChanged { port, presented_fingerprint, .. } => {
            assert_eq!(port, forwarder.port);
            assert_eq!(presented_fingerprint, f.lab.str("/servers/kbd/hostKeyEd25519Fingerprint"));
        }
        other => panic!("expected the changed bastion key to block, got {other:?}"),
    }
    match next_decision(&mut events).await {
        SessionEvent::Closed { error, .. } => assert_eq!(error.map(|e| e.code), Some(ErrorCode::HostKeyChanged)),
        other => panic!("expected the chain to end, got {other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.lab.auth_log_lines("kbd"), impostor_before, "a credential reached the impostor bastion");
    assert_eq!(f.lab.auth_log_lines("b"), inner_before, "the chain went past a bastion that failed verification");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_bastion_that_refuses_forwarding_ends_the_chain_with_a_clear_error() {
    let f = fixture().await;
    let _log = AUTH_LOG.lock().await;
    let bastion = f.host_at(&f.lab.str("/noForwardUser"), "strict bastion", f.lab.port_of("a")).await;
    let inner = f.host_at(&f.lab.str("/user"), "inner", f.lab.port_of("b")).await;
    jump_to(&f, &inner, &bastion).await;
    let inner_before = f.lab.auth_log_lines("b");

    let (session, mut events) = open_until_prompt(&f, &inner).await;
    let SessionEvent::TrustPrompt { prompt_id, .. } = next_decision(&mut events).await else { panic!("trust prompt") };
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Once).unwrap();
    match next_decision(&mut events).await {
        SessionEvent::Closed { error, .. } => assert_eq!(error.map(|e| e.code), Some(ErrorCode::ChannelDenied)),
        other => panic!("expected the chain to stop at the bastion, got {other:?}"),
    }
    assert_eq!(f.lab.auth_log_lines("b"), inner_before);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn jump_host_settings_refuse_loops_and_survive_host_edits() {
    let f = fixture().await;
    let user = f.lab.str("/user");
    let a = f.host_at(&user, "a", f.lab.port_of("a")).await;
    let b = f.host_at(&user, "b", f.lab.port_of("b")).await;
    jump_to(&f, &b, &a).await;
    let looped = tyrminal_core::contracts::HostConnection { jump_host_id: Some(b.clone()) };
    assert_eq!(f.core.vault.set_host_connection(&a, looped).await.unwrap_err().code, ErrorCode::InvalidInput);
    let itself = tyrminal_core::contracts::HostConnection { jump_host_id: Some(a.clone()) };
    assert_eq!(f.core.vault.set_host_connection(&a, itself).await.unwrap_err().code, ErrorCode::InvalidInput);
    let missing =
        tyrminal_core::contracts::HostConnection { jump_host_id: Some("00000000000000000000000000000000".into()) };
    assert_eq!(f.core.vault.set_host_connection(&a, missing).await.unwrap_err().code, ErrorCode::NotFound);

    // Editing the host's basics keeps its jump host; the setting survives a lock.
    let mut edit = f.core.vault.list_hosts().await.unwrap().into_iter().find(|h| h.id == b).unwrap();
    edit.label = "b renamed".into();
    let input = HostInput {
        id: Some(b.clone()),
        label: edit.label.clone(),
        address: edit.address.clone(),
        port: Some(edit.port),
        username: edit.username.clone(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
    };
    f.core.vault.save_host(input).await.unwrap();
    f.core.vault.lock().await;
    f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(f.core.vault.host_connection(&b).await.unwrap().jump_host_id, Some(a.clone()));
    // Duplicates keep the route.
    let copy = f.core.vault.duplicate_host(&b).await.unwrap();
    assert_eq!(f.core.vault.host_connection(&copy.id).await.unwrap().jump_host_id, Some(a));
}

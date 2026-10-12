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
            protocol: Default::default(),
            terminal: Default::default(),
            forward_agent: false,
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
                SessionEvent::TrustPrompt { prompt_id, hop, .. } => {
                    let direct = self.core.vault.host_connection(host_id).await.unwrap().jump_host_id.is_none();
                    if direct {
                        assert_eq!(hop, None, "a direct connection's prompt names no hop");
                    }
                    self.core.sessions.answer_trust(window, &opened.session_id, &prompt_id, decision).unwrap();
                }
                SessionEvent::State { state: SessionState::Connected, .. } => break,
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
            SessionEvent::State { state, .. } if state != SessionState::Connected => {}
            SessionEvent::Negotiated { .. } | SessionEvent::Banner { .. } => {}
            other => return other,
        }
    }
}

async fn jump_to(f: &Fixture, host: &str, via: &str) {
    let connection = tyrminal_core::contracts::HostConnectionInput {
        proxy: None,
        jump_host_id: Some(via.into()),
        inherit: false,
        key_exchange: Default::default(),
        no_port_suggestions: false,
    };
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
    let SessionEvent::TrustPrompt { prompt_id, port, fingerprint, hop, .. } = next_decision(&mut events).await else {
        panic!("expected the bastion's trust prompt")
    };
    assert_eq!((port, fingerprint), (f.lab.port_of("a"), f.lab.str("/servers/a/hostKeyEd25519Fingerprint")));
    // The prompt names the hop by its saved label and position, so it cannot pass for the host.
    let position =
        |index, label: &str| Some(tyrminal_core::contracts::ChainPosition { index, total: 2, label: label.into() });
    assert_eq!(hop, position(1, "bastion"));
    assert_eq!(f.lab.auth_log_lines("b"), b_before);
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Always).unwrap();
    // Then the inner server's own key, verified end to end through the bastion's channel.
    let SessionEvent::TrustPrompt { prompt_id, port, fingerprint, resolved_address, hop, .. } =
        next_decision(&mut events).await
    else {
        panic!("expected the inner host's trust prompt")
    };
    assert_eq!(hop, position(2, "inner"));
    assert_eq!((port, fingerprint), (f.lab.port_of("b"), f.lab.str("/servers/b/hostKeyEd25519Fingerprint")));
    assert_eq!(resolved_address, None, "a hop reached through a bastion has no locally resolved address");
    assert_eq!(f.lab.auth_log_lines("b"), b_before, "no credential before the inner key is trusted");
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Always).unwrap();
    assert_eq!(next_decision(&mut events).await, SessionEvent::State { state: SessionState::Connected, hop: None });
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
    let looped = tyrminal_core::contracts::HostConnectionInput {
        proxy: None,
        jump_host_id: Some(b.clone()),
        inherit: false,
        key_exchange: Default::default(),
        no_port_suggestions: false,
    };
    assert_eq!(f.core.vault.set_host_connection(&a, looped).await.unwrap_err().code, ErrorCode::InvalidInput);
    let itself = tyrminal_core::contracts::HostConnectionInput {
        proxy: None,
        jump_host_id: Some(a.clone()),
        inherit: false,
        key_exchange: Default::default(),
        no_port_suggestions: false,
    };
    assert_eq!(f.core.vault.set_host_connection(&a, itself).await.unwrap_err().code, ErrorCode::InvalidInput);
    let missing = tyrminal_core::contracts::HostConnectionInput {
        proxy: None,
        jump_host_id: Some("00000000000000000000000000000000".into()),
        inherit: false,
        key_exchange: Default::default(),
        no_port_suggestions: false,
    };
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
        protocol: Default::default(),
        terminal: Default::default(),
        forward_agent: false,
    };
    f.core.vault.save_host(input).await.unwrap();
    f.core.vault.lock().await;
    f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(f.core.vault.host_connection(&b).await.unwrap().jump_host_id, Some(a.clone()));
    // Duplicates keep the route.
    let copy = f.core.vault.duplicate_host(&b).await.unwrap();
    assert_eq!(f.core.vault.host_connection(&copy.id).await.unwrap().jump_host_id, Some(a));
}

// ---------- proxies ----------

const PROXY_USER: &str = "proxy-user";
const PROXY_PASSWORD: &str = "canary-proxy-pass-91c2";

/// Base64 of `user:password` for the expected proxy header; a small encoder of its own, so the
/// test does not trust the client's.
fn basic(user: &str, password: &str) -> String {
    let input = format!("{user}:{password}").into_bytes();
    let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= chunk.len() { table[((n >> (18 - 6 * i)) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// A minimal HTTP CONNECT proxy with Basic authentication; counts the tunnels it opened.
async fn http_proxy() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tunnels = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&tunnels);
    // Encoded here, independently of the client, so no encoded credential sits in the source.
    let expected = format!("Proxy-Authorization: Basic {}\r\n", basic("proxy-user", "canary-proxy-pass-91c2"));
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let count = Arc::clone(&count);
            let expected = expected.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8(head).unwrap();
                if !head.contains(&expected) {
                    let _ = client.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").await;
                    return;
                }
                let target = head.split(' ').nth(1).unwrap().to_owned();
                let mut upstream = TcpStream::connect(target.as_str()).await.unwrap();
                count.fetch_add(1, Ordering::SeqCst);
                client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    (port, tunnels)
}

fn proxy_input(port: u16, password: Option<&str>) -> tyrminal_core::contracts::HostConnectionInput {
    tyrminal_core::contracts::HostConnectionInput {
        jump_host_id: None,
        proxy: Some(tyrminal_core::contracts::ProxyInput {
            kind: tyrminal_core::contracts::ProxyType::Http,
            host: "127.0.0.1".into(),
            port,
            username: PROXY_USER.into(),
            password: password.map(Into::into),
        }),
        inherit: false,
        key_exchange: Default::default(),
        no_port_suggestions: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_host_behind_an_authenticated_proxy_connects_and_a_wrong_password_is_refused() {
    use std::sync::atomic::Ordering;
    let f = fixture().await;
    let (proxy_port, tunnels) = http_proxy().await;
    let host = f.host(&f.lab.str("/user")).await;
    f.core.vault.set_host_connection(&host, proxy_input(proxy_port, Some(PROXY_PASSWORD))).await.unwrap();

    // The password is write-only: the settings say one is stored, never what it is.
    let settings = f.core.vault.host_connection(&host).await.unwrap();
    let proxy = settings.proxy.clone().unwrap();
    assert!(proxy.password_stored);
    assert!(!format!("{settings:?}").contains(PROXY_PASSWORD));

    let mut session = f.connect(WINDOW, &host).await;
    assert_eq!(tunnels.load(Ordering::SeqCst), 1, "the session went through the proxy");
    // A tunnel on the proxied session (FWD-09): its traffic rides the same proxied link.
    let echo = echo_server().await;
    let rule = f.rule(&host, TunnelKind::Local, echo).await;
    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &rule).await.unwrap();
    assert!(echoes(loopback(run.bound_port), b"through the proxy").await);
    assert_eq!(tunnels.load(Ordering::SeqCst), 1, "a forward opens no new proxy connection");
    f.core.sessions.close(WINDOW, &session.id).unwrap();
    session.closed().await;

    // Saving without a password keeps the stored one.
    f.core.vault.set_host_connection(&host, proxy_input(proxy_port, None)).await.unwrap();
    let mut session = f.connect(WINDOW, &host).await;
    f.core.sessions.close(WINDOW, &session.id).unwrap();
    session.closed().await;
    assert_eq!(tunnels.load(Ordering::SeqCst), 2);

    // A wrong password: refused by the proxy, reported as such, and the secret is in no message.
    f.core.vault.set_host_connection(&host, proxy_input(proxy_port, Some("wrong-password"))).await.unwrap();
    let (tx, mut events) = mpsc::unbounded_channel();
    f.core.sessions.open_ssh(WINDOW, &host, 80, 24, Arc::new(EventSink(tx))).await.unwrap();
    let error = loop {
        match tokio::time::timeout(WAIT, events.recv()).await.unwrap().unwrap() {
            SessionEvent::Closed { error, .. } => break error.expect("an error"),
            SessionEvent::TrustPrompt { .. } => panic!("no server may be reached through a refused proxy"),
            _ => {}
        }
    };
    assert_eq!(error.code, ErrorCode::AuthFailed);
    assert_eq!(error.message, "The proxy did not accept the user name and password.");
    assert_eq!(tunnels.load(Ordering::SeqCst), 2);

    // Changing the user name drops the stored password rather than sending it to a new identity.
    let mut other_user = proxy_input(proxy_port, None);
    if let Some(p) = other_user.proxy.as_mut() {
        p.username = "someone-else".into();
    }
    f.core.vault.set_host_connection(&host, other_user).await.unwrap();
    assert!(!f.core.vault.host_connection(&host).await.unwrap().proxy.unwrap().password_stored);
}

/// HST-05 through a real connection: a host that sets no route of its own goes through its
/// group's jump host, with every hop verified and signed in to in order; once it sets its own
/// route (directly), it no longer does.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_host_goes_through_its_groups_jump_host_until_it_sets_its_own_route() {
    use tyrminal_core::contracts::{BulkHostChange, GroupDefaultsInput, GroupInput};
    let f = fixture().await;
    let _log = AUTH_LOG.lock().await;
    let user = f.lab.str("/user");
    let bastion = f.host_at(&user, "bastion", f.lab.port_of("a")).await;
    let inner = f.host_at(&user, "inner", f.lab.port_of("b")).await;
    let group = f
        .core
        .vault
        .save_group(GroupInput {
            id: None,
            name: "Internal".into(),
            parent_id: None,
            username: None,
            port: None,
            key_id: None,
        })
        .await
        .unwrap();
    f.core
        .vault
        .bulk_update_hosts(
            std::slice::from_ref(&inner),
            BulkHostChange::MoveToGroup { group_id: Some(group.id.clone()) },
        )
        .await
        .unwrap();
    f.core
        .vault
        .set_group_defaults(
            &group.id,
            GroupDefaultsInput { jump_host_id: Some(bastion.clone()), proxy: None, os: None },
        )
        .await
        .unwrap();

    let (session, mut events) = open_until_prompt(&f, &inner).await;
    let SessionEvent::TrustPrompt { prompt_id, port, hop, .. } = next_decision(&mut events).await else {
        panic!("expected the bastion's trust prompt")
    };
    assert_eq!(port, f.lab.port_of("a"), "the inherited jump host is contacted first");
    assert_eq!(hop.map(|h| (h.index, h.total, h.label)), Some((1, 2, "bastion".to_owned())));
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Once).unwrap();
    let SessionEvent::TrustPrompt { prompt_id, port, .. } = next_decision(&mut events).await else {
        panic!("expected the inner host's trust prompt")
    };
    assert_eq!(port, f.lab.port_of("b"));
    f.core.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Once).unwrap();
    assert_eq!(next_decision(&mut events).await, SessionEvent::State { state: SessionState::Connected, hop: None });
    f.core.sessions.close(WINDOW, &session).unwrap();

    // Its own route ("directly") replaces the group's: the first prompt is the inner server's.
    let direct = tyrminal_core::contracts::HostConnectionInput {
        jump_host_id: None,
        proxy: None,
        inherit: false,
        key_exchange: Default::default(),
        no_port_suggestions: false,
    };
    f.core.vault.set_host_connection(&inner, direct).await.unwrap();
    let (session, mut events) = open_until_prompt(&f, &inner).await;
    let SessionEvent::TrustPrompt { port, hop, .. } = next_decision(&mut events).await else {
        panic!("expected the inner host's trust prompt")
    };
    assert_eq!((port, hop), (f.lab.port_of("b"), None));
    f.core.sessions.close(WINDOW, &session).unwrap();
}

// ---------- session recording over SSH (LOG-01) ----------

/// Output of a recording so far, as text.
async fn recorded_text(f: &Fixture, log_id: &str) -> String {
    use base64::Engine;
    let playback = f.core.sessions.open_session_log(log_id).await.unwrap();
    playback
        .frames
        .iter()
        .filter_map(|frame| match frame {
            tyrminal_core::contracts::PlaybackFrame::Output { data, .. } => Some(
                String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()).into_owned(),
            ),
            tyrminal_core::contracts::PlaybackFrame::Resize { .. } => None,
        })
        .collect()
}

async fn recorded_until(f: &Fixture, log_id: &str, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let text = recorded_text(f, log_id).await;
        if text.contains(needle) {
            return text;
        }
        assert!(tokio::time::Instant::now() < deadline, "{needle:?} not recorded; got {text:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn an_ssh_session_is_recorded_under_its_host_without_the_answer_to_a_hidden_prompt() {
    let f = fixture().await;
    let settings = tyrminal_core::contracts::RecordingSettings { enabled: true, keep_per_host: 5, max_log_mib: 64 };
    f.core.sessions.set_recording_settings(settings).await.unwrap();
    let host = f.host_at(&f.lab.str("/user"), "recorded lab host", f.lab.port()).await;
    let mut session = f.connect(WINDOW, &host).await;
    let logs = f.core.sessions.list_session_logs().await.unwrap();
    assert_eq!(logs.len(), 1);
    let log = &logs[0];
    assert_eq!((log.title.as_str(), log.host_id.as_deref()), ("recorded lab host", Some(host.as_str())));
    assert_eq!(log.kind, tyrminal_core::contracts::SessionLogKind::Ssh);
    assert_eq!(log.state, tyrminal_core::contracts::SessionLogState::Recording);

    let write = |text: &str| f.core.sessions.write(WINDOW, &session.id, text.as_bytes().to_vec());
    write("stty -echo; printf '%s%s: ' Pass word; read answer; stty echo; echo; echo remote-done-$((8*8))\r")
        .await
        .unwrap();
    recorded_until(&f, &log.id, "Password: ").await;
    write("lab-hidden-answer-canary\r").await.unwrap();
    let text = recorded_until(&f, &log.id, "remote-done-64").await;
    assert!(!text.contains("lab-hidden-answer-canary"), "typed input must never be recorded: {text:?}");

    f.core.sessions.close(WINDOW, &session.id).unwrap();
    assert_eq!(session.closed().await, None);
    let done = f.core.sessions.list_session_logs().await.unwrap().remove(0);
    assert_eq!(done.state, tyrminal_core::contracts::SessionLogState::Complete);
    assert!(!recorded_text(&f, &done.id).await.contains("lab-hidden-answer-canary"));
}

// ---------- key exchange per host (SEC-08, SEC-10) ----------

fn key_exchange(mode: tyrminal_core::contracts::KeyExchangeMode) -> tyrminal_core::contracts::HostConnectionInput {
    tyrminal_core::contracts::HostConnectionInput {
        jump_host_id: None,
        proxy: None,
        key_exchange: mode,
        inherit: false,
        no_port_suggestions: false,
    }
}

/// Opens a session and returns every event up to the shell or the close.
async fn events_until_settled(f: &Fixture, host_id: &str) -> Vec<SessionEvent> {
    let (tx, mut events) = mpsc::unbounded_channel();
    let opened = f.core.sessions.open_ssh(WINDOW, host_id, 80, 24, Arc::new(EventSink(tx))).await.unwrap();
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout(WAIT, events.recv()).await.expect("settles in time").unwrap();
        if let SessionEvent::TrustPrompt { prompt_id, .. } = &event {
            f.core.sessions.answer_trust(WINDOW, &opened.session_id, prompt_id, TrustDecision::Once).unwrap();
        }
        let done =
            matches!(event, SessionEvent::State { state: SessionState::Connected, .. } | SessionEvent::Closed { .. });
        seen.push(event);
        if done {
            if matches!(seen.last(), Some(SessionEvent::State { .. })) {
                f.core.sessions.close(WINDOW, &opened.session_id).unwrap();
            }
            return seen;
        }
    }
}

fn negotiated_kex(events: &[SessionEvent]) -> Option<String> {
    events.iter().find_map(|e| match e {
        SessionEvent::Negotiated { kex, .. } => Some(kex.clone()),
        _ => None,
    })
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_host_can_turn_post_quantum_off_for_compatibility_or_require_it() {
    use tyrminal_core::contracts::KeyExchangeMode;
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    assert_eq!(f.core.vault.host_connection(&host).await.unwrap().key_exchange, KeyExchangeMode::PreferPostQuantum);
    let offers_post_quantum = {
        let version = f.lab.str("/serverVersion");
        let digits: Vec<u32> = version
            .split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .take(2)
            .map(|p| p.parse().unwrap())
            .collect();
        (digits[0], digits[1]) >= (9, 9)
    };

    // Default: post-quantum where offered, a classical exchange otherwise.
    let preferred = negotiated_kex(&events_until_settled(&f, &host).await).expect("negotiated");
    assert_eq!(preferred, if offers_post_quantum { tyrminal_ssh::POST_QUANTUM_KEX } else { "curve25519-sha256" });

    // Compatibility: never post-quantum.
    f.core.vault.set_host_connection(&host, key_exchange(KeyExchangeMode::Classic)).await.unwrap();
    assert_eq!(negotiated_kex(&events_until_settled(&f, &host).await).as_deref(), Some("curve25519-sha256"));

    // Required: a server without it is refused during key exchange, before trust or sign-in.
    f.core.vault.set_host_connection(&host, key_exchange(KeyExchangeMode::RequirePostQuantum)).await.unwrap();
    let events = events_until_settled(&f, &host).await;
    if offers_post_quantum {
        assert_eq!(negotiated_kex(&events).as_deref(), Some(tyrminal_ssh::POST_QUANTUM_KEX));
    } else {
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::TrustPrompt { .. } | SessionEvent::AuthPrompt { .. }))
        );
        let Some(SessionEvent::Closed { error: Some(error), .. }) = events.last() else {
            panic!("expected a failed session, got {events:?}")
        };
        assert_eq!(error.code, ErrorCode::ProtocolError);
        assert!(error.message.contains("post-quantum"), "{}", error.message);
        // Key exchange failed, so the host key was never checked and no credential could be
        // sent; kex_lab proves the same against the server's log, with no other client running.
    }

    // The setting is saved with the host and survives a lock.
    f.core.vault.lock().await;
    f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(f.core.vault.host_connection(&host).await.unwrap().key_exchange, KeyExchangeMode::RequirePostQuantum);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn forwards_move_with_their_session_to_another_window() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let echo = echo_server().await;
    let rule = f.rule(&host, TunnelKind::Local, echo).await;
    let session = f.connect(WINDOW, &host).await;
    let run = f.core.sessions.start_tunnel(WINDOW, &session.id, &rule).await.unwrap();

    let token = f.core.sessions.offer_handoff(WINDOW, &session.id, OTHER_WINDOW).unwrap();
    let (tx, _events) = mpsc::unbounded_channel();
    f.core.sessions.accept_handoff(OTHER_WINDOW, &token, Arc::new(EventSink(tx))).unwrap();

    // The new window lists and controls the forward; the old one no longer can.
    assert!(f.active(WINDOW).is_empty());
    assert_eq!(f.active(OTHER_WINDOW).iter().map(|t| t.run_id.clone()).collect::<Vec<_>>(), vec![run.run_id.clone()]);
    assert_eq!(f.core.sessions.stop_tunnel(WINDOW, &run.run_id).await.unwrap_err().code, ErrorCode::AccessDenied);

    // Closing the old window leaves the forward running.
    f.core.sessions.stop_tunnels_for_owner(WINDOW);
    assert!(echoes(loopback(run.bound_port), b"after the move").await);

    f.core.sessions.stop_tunnel(OTHER_WINDOW, &run.run_id).await.unwrap();
    assert!(!echoes(loopback(run.bound_port), b"stopped").await);
}

/// Passes output on with acknowledgements, like the renderer, so a busy session keeps flowing.
struct AckingSink {
    core: Core,
    session: std::sync::Mutex<Option<String>>,
    events: mpsc::UnboundedSender<SessionEvent>,
}

impl SessionSink for AckingSink {
    fn output(&self, data: Vec<u8>) -> bool {
        let session = self.session.lock().unwrap().clone();
        if let Some(session) = session {
            let core = self.core.clone();
            let n = data.len() as u32;
            tokio::spawn(async move { core.sessions.ack(WINDOW, &session, n).await });
        }
        true
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.events.send(event).is_ok()
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn an_ssh_recording_gets_nothing_more_once_the_session_closes_or_the_vault_locks() {
    for lock in [false, true] {
        let f = fixture().await;
        let settings = tyrminal_core::contracts::RecordingSettings { enabled: true, keep_per_host: 5, max_log_mib: 64 };
        f.core.sessions.set_recording_settings(settings).await.unwrap();
        let host = f.host(&f.lab.str("/user")).await;
        let (tx, mut events) = mpsc::unbounded_channel();
        let sink = Arc::new(AckingSink { core: f.core.clone(), session: std::sync::Mutex::new(None), events: tx });
        let opened = f.core.sessions.open_ssh(WINDOW, &host, 80, 24, sink.clone()).await.unwrap();
        *sink.session.lock().unwrap() = Some(opened.session_id.clone());
        loop {
            match tokio::time::timeout(WAIT, events.recv()).await.expect("connects").unwrap() {
                SessionEvent::TrustPrompt { prompt_id, .. } => {
                    f.core.sessions.answer_trust(WINDOW, &opened.session_id, &prompt_id, TrustDecision::Once).unwrap();
                }
                SessionEvent::State { state: SessionState::Connected, .. } => break,
                SessionEvent::Closed { error, .. } => panic!("closed: {error:?}"),
                _ => {}
            }
        }
        let log = f.core.sessions.list_session_logs().await.unwrap().remove(0);
        let line = "n=0; while :; do n=$((n+1)); echo tick-$n; sleep 0.02; done\r";
        f.core.sessions.write(WINDOW, &opened.session_id, line.as_bytes().to_vec()).await.unwrap();
        recorded_until(&f, &log.id, "tick-20").await;

        if lock {
            f.core.vault.lock().await;
        } else {
            f.core.sessions.close(WINDOW, &opened.session_id).unwrap();
        }
        let error = loop {
            let event = tokio::time::timeout(WAIT, events.recv()).await.expect("the session ended at once").unwrap();
            if let SessionEvent::Closed { error, .. } = event {
                break error.map(|e| e.code);
            }
        };
        assert_eq!(error, lock.then_some(ErrorCode::VaultLocked));
        let path = f._dir.path().join("logs").join(format!("{}.tyrlog", log.id));
        let state = || {
            let meta = std::fs::metadata(&path).unwrap();
            (meta.len(), meta.modified().unwrap())
        };
        let ended = state();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(state(), ended, "written after the session ended (lock: {lock})");
        if lock {
            f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
        }
        let playback = f.core.sessions.open_session_log(&log.id).await.unwrap();
        assert_eq!(playback.log.state, tyrminal_core::contracts::SessionLogState::Complete, "lock: {lock}");
        assert_eq!(state(), ended);
    }
}

// ---------- quick port forwards from detected listening ports (P-24) ----------

/// The ports suggested in `events` until `marker` has been printed (the marker comes after the
/// output under test, so everything before it has been seen).
async fn suggestions_until(f: &Fixture, session: &mut Session, marker_cmd: &str) -> Vec<u16> {
    f.core.sessions.write(WINDOW, &session.id, format!("{marker_cmd}\r").into_bytes()).await.unwrap();
    let mut ports = Vec::new();
    loop {
        // The marker is printed as a suggestion of its own, on a port nobody uses.
        let event = tokio::time::timeout(WAIT, session.events.recv()).await.expect("marker in time").unwrap();
        if let SessionEvent::PortSuggestion { port } = event {
            ports.push(port);
        }
        if ports.last() == Some(&65_001) {
            ports.pop();
            return ports;
        }
    }
}

const MARKER: &str = "echo listening on localhost:$((65000+1))";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn output_naming_another_host_or_an_invalid_port_never_yields_a_forward() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    let mut session = f.connect(WINDOW, &host).await;
    let hostile = [
        "listening on http://10.0.0.5:4100",
        "listening on http://evil.localhost:4101",
        "listening on http://localhost.evil.com:4102",
        "listening on 127.0.0.10:4103",
        "listening on localhost:0",
        "listening on localhost:65536",
        "listening on localhost:099",
    ];
    let mut cmd = String::new();
    for line in hostile {
        cmd.push_str(&format!("printf '%s\\n' '{line}'; "));
    }
    // A link's hidden target is not shown text either.
    cmd.push_str("printf '\\033]8;;http://localhost:4104\\007docs\\033]8;;\\007\\n'; ");
    cmd.push_str(MARKER);
    assert_eq!(suggestions_until(&f, &mut session, &cmd).await, Vec::<u16>::new());
    for port in [4100, 4101, 4102, 4103, 4104, 22, 0] {
        let refused = f.core.sessions.quick_forward(WINDOW, &session.id, port).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidInput, "port {port}");
    }
    assert!(f.active(WINDOW).is_empty(), "nothing was forwarded");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_suggested_port_is_forwarded_only_when_accepted_and_reaches_the_service_on_the_server() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    // The lab server's loopback is this machine's, so this listener is "on the server".
    let service = echo_server().await;
    let mut session = f.connect(WINDOW, &host).await;
    let printed = format!("printf 'Server listening on http://localhost:%s/\\n' {service}; {MARKER}");
    assert_eq!(suggestions_until(&f, &mut session, &printed).await, vec![service]);
    assert!(f.active(WINDOW).is_empty(), "a suggestion alone forwards nothing");

    // Another window cannot accept it.
    let denied = f.core.sessions.quick_forward(OTHER_WINDOW, &session.id, service).await.unwrap_err();
    assert_eq!(denied.code, ErrorCode::AccessDenied);

    let run = f.core.sessions.quick_forward(WINDOW, &session.id, service).await.unwrap();
    assert_eq!((run.bind_host.as_str(), run.dest_host.as_str(), run.dest_port), ("127.0.0.1", "127.0.0.1", service));
    // The service holds that port here, so the listener took a free one.
    assert_ne!(run.bound_port, service);
    assert!(echoes(loopback(run.bound_port), b"through the quick forward").await);
    assert_eq!(
        f.core.sessions.quick_forward_url(WINDOW, &run.run_id).unwrap(),
        format!("http://127.0.0.1:{}/", run.bound_port)
    );
    assert_eq!(f.core.sessions.quick_forward_url(OTHER_WINDOW, &run.run_id).unwrap_err().code, ErrorCode::AccessDenied);
    let again = f.core.sessions.quick_forward(WINDOW, &session.id, service).await.unwrap_err();
    assert_eq!(again.code, ErrorCode::Conflict, "one forward per port and session");

    // It ends with the session.
    f.core.sessions.close(WINDOW, &session.id).unwrap();
    assert_eq!(session.closed().await, None);
    assert!(!echoes(loopback(run.bound_port), b"after close").await);
    assert!(f.core.sessions.quick_forward_url(WINDOW, &run.run_id).is_err());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_free_port_is_reused_locally_and_the_forward_ends_when_the_vault_locks() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    // A port free on this machine: nothing listens on it, so the forward binds the same number.
    let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let mut session = f.connect(WINDOW, &host).await;
    let printed = format!("echo listening on 127.0.0.1:{free}; {MARKER}");
    assert_eq!(suggestions_until(&f, &mut session, &printed).await, vec![free]);
    let run = f.core.sessions.quick_forward(WINDOW, &session.id, free).await.unwrap();
    assert_eq!(run.bound_port, free, "same port when it is free");
    assert!(TcpStream::connect(loopback(free)).await.is_ok(), "the listener is up");

    f.core.vault.lock().await;
    assert_eq!(session.closed().await, Some(ErrorCode::VaultLocked));
    let deadline = tokio::time::Instant::now() + WAIT;
    while TcpStream::connect(loopback(free)).await.is_ok() {
        assert!(tokio::time::Instant::now() < deadline, "the listener outlived the lock");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn suggestions_can_be_turned_off_for_a_host() {
    let f = fixture().await;
    let host = f.host(&f.lab.str("/user")).await;
    f.core.vault.set_port_suggestions(&host, false).await.unwrap();
    assert!(f.core.vault.host_connection(&host).await.unwrap().no_port_suggestions);
    let mut session = f.connect(WINDOW, &host).await;
    f.core
        .sessions
        .write(WINDOW, &session.id, b"echo listening on localhost:4200; echo done-$((1+1))\r".to_vec())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    while let Ok(event) = session.events.try_recv() {
        assert!(!matches!(event, SessionEvent::PortSuggestion { .. }), "{event:?}");
    }
    assert_eq!(
        f.core.sessions.quick_forward(WINDOW, &session.id, 4200).await.unwrap_err().code,
        ErrorCode::InvalidInput
    );
    f.core.vault.set_port_suggestions(&host, true).await.unwrap();
    assert!(!f.core.vault.host_connection(&host).await.unwrap().no_port_suggestions);
}

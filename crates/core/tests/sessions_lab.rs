//! End-to-end session flows through the application core against the real OpenSSH lab:
//! vault → connection plan → host trust prompt → authentication → PTY → acknowledged output.
//!
//! Run with `pnpm lab:up && cargo test -p tyrminal-core --test sessions_lab -- --ignored`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tyrminal_core::contracts::{
    AuthPromptKind, ErrorCode, HostAuthInput, HostInput, KeyImportInput, SessionEvent, SessionState, TrustDecision,
    VaultState,
};
use tyrminal_core::{Core, SessionSink};

const PASSPHRASE: &str = "correct horse battery staple";
const WINDOW: &str = "main";
const WAIT: Duration = Duration::from_secs(20);

// ---------- lab ----------

struct Lab(Value);

impl Lab {
    fn load() -> Self {
        let path = std::env::var_os("TYRMINAL_LAB")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/ssh-lab/.run/lab.json"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("SSH lab is not running ({}). Run `pnpm lab:up` first.", path.display()));
        Self(serde_json::from_str(&text).unwrap())
    }
    fn str(&self, pointer: &str) -> String {
        self.0.pointer(pointer).and_then(Value::as_str).unwrap_or_else(|| panic!("lab.json: {pointer}")).to_owned()
    }
    fn port(&self, server: &str) -> u16 {
        self.0.pointer(&format!("/servers/{server}/port")).and_then(Value::as_u64).unwrap() as u16
    }
    fn addr(&self, server: &str) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.port(server)))
    }
    fn key_text(&self, name: &str) -> String {
        std::fs::read_to_string(self.str(&format!("/keys/{name}"))).unwrap()
    }
    fn auth_log_lines(&self, server: &str) -> usize {
        let container = self.str(&format!("/servers/{server}/container"));
        let out = Command::new("docker").args(["logs", &container]).output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        text.lines()
            .filter(|l| ["Accepted ", "Failed ", "Postponed ", "userauth"].iter().any(|n| l.contains(n)))
            .count()
    }
}

static SERVER_B: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One stable local endpoint whose backend can be switched (to present a different host key).
struct Forwarder {
    port: u16,
    target: Arc<Mutex<SocketAddr>>,
}

impl Forwarder {
    async fn start(target: SocketAddr) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = Arc::new(Mutex::new(target));
        let shared = Arc::clone(&target);
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let backend = *shared.lock().unwrap();
                tokio::spawn(async move {
                    if let Ok(mut outbound) = TcpStream::connect(backend).await {
                        let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
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

// ---------- a renderer stand-in ----------

enum Message {
    Output(Vec<u8>),
    Event(SessionEvent),
}

struct ChannelSink(mpsc::UnboundedSender<Message>);

impl SessionSink for ChannelSink {
    fn output(&self, data: Vec<u8>) -> bool {
        self.0.send(Message::Output(data)).is_ok()
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.0.send(Message::Event(event)).is_ok()
    }
}

/// Plays the renderer: receives events and output, answers prompts, acknowledges bytes.
struct Client {
    core: Core,
    session: String,
    inbox: mpsc::UnboundedReceiver<Message>,
    text: String,
    received: usize,
    auto_ack: bool,
}

impl Client {
    async fn open_ssh(core: &Core, host_id: &str) -> Self {
        let (tx, inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_ssh(WINDOW, host_id, 100, 30, Arc::new(ChannelSink(tx))).await.expect("open");
        Self { core: core.clone(), session: opened.session_id, inbox, text: String::new(), received: 0, auto_ack: true }
    }

    async fn open_local(core: &Core) -> Self {
        let (tx, inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_local(WINDOW, 100, 30, Arc::new(ChannelSink(tx))).await.expect("open local");
        Self { core: core.clone(), session: opened.session_id, inbox, text: String::new(), received: 0, auto_ack: true }
    }

    /// Next event, accumulating (and acknowledging) any output that arrives before it.
    async fn event(&mut self) -> SessionEvent {
        loop {
            match tokio::time::timeout(WAIT, self.inbox.recv()).await.expect("timed out waiting for an event") {
                Some(Message::Event(event)) => return event,
                Some(Message::Output(bytes)) => self.absorb(bytes).await,
                None => panic!("session channel closed"),
            }
        }
    }

    async fn absorb(&mut self, bytes: Vec<u8>) {
        self.received += bytes.len();
        self.text.push_str(&String::from_utf8_lossy(&bytes));
        if self.auto_ack {
            let _ = self.core.sessions.ack(WINDOW, &self.session, bytes.len() as u32).await;
        }
    }

    /// Skips state events until one that is not a plain state change.
    async fn until_not_state(&mut self) -> (Vec<SessionState>, SessionEvent) {
        let mut states = Vec::new();
        loop {
            match self.event().await {
                SessionEvent::State { state } if state != SessionState::Connected => states.push(state),
                other => {
                    if let SessionEvent::State { state } = &other {
                        states.push(*state);
                    }
                    return (states, other);
                }
            }
        }
    }

    async fn until_connected(&mut self) -> Vec<SessionState> {
        let (states, last) = self.until_not_state().await;
        assert_eq!(last, SessionEvent::State { state: SessionState::Connected }, "states so far: {states:?}");
        states
    }

    async fn until_closed(&mut self) -> (Option<ErrorCode>, Option<u32>) {
        loop {
            if let SessionEvent::Closed { error, exit_status } = self.event().await {
                return (error.map(|e| e.code), exit_status);
            }
        }
    }

    async fn output_until(&mut self, needle: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !self.text.contains(needle) {
            match tokio::time::timeout_at(deadline, self.inbox.recv()).await {
                Ok(Some(Message::Output(bytes))) => self.absorb(bytes).await,
                Ok(Some(Message::Event(event))) => panic!("unexpected event while waiting for {needle:?}: {event:?}"),
                Ok(None) => panic!("closed while waiting for {needle:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; got {:?}", self.text),
            }
        }
    }

    async fn send(&self, text: &str) {
        self.core.sessions.write(WINDOW, &self.session, text.as_bytes().to_vec()).await.expect("write");
    }

    fn trust(&self, prompt_id: &str, decision: TrustDecision) {
        self.core.sessions.answer_trust(WINDOW, &self.session, prompt_id, decision).expect("answer trust");
    }

    fn answer(&self, prompt_id: &str, secret: Option<&str>) {
        self.core.sessions.answer_auth(WINDOW, &self.session, prompt_id, secret.map(Into::into)).expect("answer auth");
    }
}

fn trust_prompt_id(event: &SessionEvent) -> String {
    match event {
        SessionEvent::TrustPrompt { prompt_id, .. } => prompt_id.clone(),
        other => panic!("expected a trust prompt, got {other:?}"),
    }
}

fn auth_prompt(event: &SessionEvent) -> (String, AuthPromptKind, u32) {
    match event {
        SessionEvent::AuthPrompt { prompt_id, kind, attempt, .. } => (prompt_id.clone(), *kind, *attempt),
        other => panic!("expected an auth prompt, got {other:?}"),
    }
}

// ---------- fixtures ----------

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

impl Fixture {
    async fn host(&self, label: &str, port: u16, username: &str, auth: HostAuthInput) -> String {
        let input = HostInput {
            id: None,
            label: label.into(),
            address: "127.0.0.1".into(),
            port,
            username: username.into(),
            auth,
        };
        self.core.vault.save_host(input).await.unwrap().id
    }

    async fn import(&self, name: &str, passphrase: Option<&str>, remember: bool) -> String {
        let input = KeyImportInput {
            label: format!("lab {name}"),
            private_key: self.lab.key_text(name),
            passphrase: passphrase.map(Into::into),
            remember_passphrase: remember,
        };
        self.core.vault.import_key(input).await.unwrap().id
    }

    async fn key_host(&self, server: &str) -> String {
        let key_id = self.import("ed25519", None, false).await;
        self.host("lab", self.lab.port(server), &self.lab.str("/user"), HostAuthInput::Key { key_id }).await
    }
}

// ---------- flows ----------

/// The Phase 03 gate: first use asks for trust, "always" remembers it, a fixture command runs,
/// and the second connection is trusted without a prompt.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn first_use_trust_then_key_auth_shell_and_remembered_trust() {
    let f = fixture().await;
    let host_id = f.key_host("a").await;

    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (states, prompt) = client.until_not_state().await;
    assert_eq!(states, [SessionState::Connecting, SessionState::VerifyingHost]);
    match &prompt {
        SessionEvent::TrustPrompt { host, port, resolved_address, algorithm, fingerprint, .. } => {
            assert_eq!((host.as_str(), *port), ("127.0.0.1", f.lab.port("a")));
            assert_eq!(resolved_address.as_deref(), Some("127.0.0.1"));
            assert_eq!(algorithm, "ssh-ed25519");
            assert_eq!(*fingerprint, f.lab.str("/servers/a/hostKeyEd25519Fingerprint"));
        }
        other => panic!("expected a trust prompt, got {other:?}"),
    }
    assert!(f.core.vault.list_known_hosts().await.unwrap().is_empty(), "nothing is trusted before the decision");
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);

    let states = client.until_connected().await;
    assert_eq!(states, [SessionState::Authenticating, SessionState::OpeningChannel, SessionState::Connected]);
    client.send("echo core-$((40+2)); id -un; stty size\n").await;
    client.output_until("core-42").await;
    client.output_until("30 100").await;
    assert!(client.text.contains("tyr"));

    f.core.sessions.resize(WINDOW, &client.session, 140, 50).await.unwrap();
    client.send("stty size; echo resized-$((40+2))\n").await;
    client.output_until("resized-42").await;
    assert!(client.text.contains("50 140"), "{:?}", client.text);

    client.send("exit 3\n").await;
    assert_eq!(client.until_closed().await, (None, Some(3)));
    assert_eq!(f.core.sessions.count(), 0);

    let known = f.core.vault.list_known_hosts().await.unwrap();
    assert_eq!(known.len(), 1);
    assert_eq!((known[0].host.as_str(), known[0].port), ("127.0.0.1", f.lab.port("a")));
    assert_eq!(known[0].fingerprint, f.lab.str("/servers/a/hostKeyEd25519Fingerprint"));

    // Second connection: trusted, so no prompt appears between verifying and authenticating.
    let mut again = Client::open_ssh(&f.core, &host_id).await;
    let states = again.until_connected().await;
    assert_eq!(
        states,
        [
            SessionState::Connecting,
            SessionState::VerifyingHost,
            SessionState::Authenticating,
            SessionState::OpeningChannel,
            SessionState::Connected
        ]
    );
    f.core.sessions.close(WINDOW, &again.session).unwrap();
    assert_eq!(again.until_closed().await, (None, None));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn trust_once_connects_without_storing_and_cancel_ends_the_session() {
    let f = fixture().await;
    let host_id = f.key_host("a").await;

    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    // A wrong prompt id answers nothing and the real prompt stays pending.
    let stale = f.core.sessions.answer_trust(
        WINDOW,
        &client.session,
        "00000000000000000000000000000000",
        TrustDecision::Always,
    );
    assert_eq!(stale.unwrap_err().code, ErrorCode::NotFound);
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Once);
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;
    assert!(f.core.vault.list_known_hosts().await.unwrap().is_empty(), "trust once must not be stored");

    // Still unknown next time; cancelling ends it cleanly.
    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Cancel);
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::Cancelled));
    assert!(f.core.vault.list_known_hosts().await.unwrap().is_empty());
    assert_eq!(f.core.sessions.count(), 0);
}

/// INV-02/INV-03 through the whole application: a changed key at a trusted endpoint is blocked,
/// the user is told both fingerprints, nothing reaches the impostor's auth layer, trust is not
/// replaced, and only the explicit remove-with-reason step leads back to a first-use prompt.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn changed_host_key_is_blocked_and_trust_is_replaced_only_explicitly() {
    let f = fixture().await;
    let _exclusive = SERVER_B.lock().await;
    let forwarder = Forwarder::start(f.lab.addr("a")).await;
    // A stored password makes the stakes concrete: it must never be sent to the impostor.
    let host_id = f
        .host(
            "pinned",
            forwarder.port,
            &f.lab.str("/user"),
            HostAuthInput::StoredPassword { password: Some(f.lab.str("/password")) },
        )
        .await;

    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    forwarder.retarget(f.lab.addr("b"));
    let auth_lines_before = f.lab.auth_log_lines("b");
    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, event) = client.until_not_state().await;
    match &event {
        SessionEvent::HostKeyChanged { presented_fingerprint, trusted_fingerprints, port, .. } => {
            assert_eq!(*port, forwarder.port);
            assert_eq!(*presented_fingerprint, f.lab.str("/servers/b/hostKeyEd25519Fingerprint"));
            assert_eq!(*trusted_fingerprints, [f.lab.str("/servers/a/hostKeyEd25519Fingerprint")]);
        }
        other => panic!("expected HostKeyChanged, got {other:?}"),
    }
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::HostKeyChanged));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.lab.auth_log_lines("b"), auth_lines_before, "the stored password reached the impostor");

    let known = f.core.vault.list_known_hosts().await.unwrap();
    assert_eq!(known.len(), 1, "trust was neither replaced nor extended");
    assert_eq!(known[0].fingerprint, f.lab.str("/servers/a/hostKeyEd25519Fingerprint"));

    // Replacing trust needs a reason...
    assert_eq!(f.core.vault.remove_known_host(&known[0].id, " ").await.unwrap_err().code, ErrorCode::InvalidInput);
    f.core.vault.remove_known_host(&known[0].id, "server was rebuilt on 2026-10-12").await.unwrap();
    // ...and then it is a first-use decision again, showing the new key.
    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    match &prompt {
        SessionEvent::TrustPrompt { fingerprint, .. } => {
            assert_eq!(*fingerprint, f.lab.str("/servers/b/hostKeyEd25519Fingerprint"))
        }
        other => panic!("expected a new trust prompt, got {other:?}"),
    }
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Cancel);
    client.until_closed().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn password_prompts_retry_then_succeed_and_give_up_after_the_limit() {
    let f = fixture().await;
    let host_id = f.host("ask", f.lab.port("a"), &f.lab.str("/user"), HostAuthInput::AskPassword).await;

    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    let (_, first) = client.until_not_state().await;
    let (prompt_id, kind, attempt) = auth_prompt(&first);
    assert_eq!((kind, attempt), (AuthPromptKind::Password, 1));
    client.answer(&prompt_id, Some("definitely wrong"));
    let (_, second) = client.until_not_state().await;
    let (prompt_id, _, attempt) = auth_prompt(&second);
    assert_eq!(attempt, 2);
    // Oversized or empty answers are rejected locally and the prompt stays open.
    let too_long = "x".repeat(1025);
    for bad in ["", too_long.as_str()] {
        let result = f.core.sessions.answer_auth(WINDOW, &client.session, &prompt_id, Some(bad.into()));
        assert_eq!(result.unwrap_err().code, ErrorCode::InvalidInput);
    }
    client.answer(&prompt_id, Some(&f.lab.str("/password")));
    client.until_connected().await;
    client.send("echo pw-$((40+2))\n").await;
    client.output_until("pw-42").await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // Three wrong answers: the session fails with AUTH_FAILED and does not prompt a fourth time.
    let mut client = Client::open_ssh(&f.core, &host_id).await;
    for expected_attempt in 1..=3 {
        let (_, prompt) = client.until_not_state().await;
        let (prompt_id, _, attempt) = auth_prompt(&prompt);
        assert_eq!(attempt, expected_attempt);
        client.answer(&prompt_id, Some("still wrong"));
    }
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::AuthFailed));

    // Dismissing the prompt cancels.
    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    client.answer(&auth_prompt(&prompt).0, None);
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::Cancelled));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn stored_password_and_encrypted_key_flows() {
    let f = fixture().await;
    let user = f.lab.str("/user");
    let port = f.lab.port("a");
    let passphrase = f.lab.str("/keys/ed25519EncryptedPassphrase");

    // Stored password: no prompt at all.
    let host =
        f.host("stored", port, &user, HostAuthInput::StoredPassword { password: Some(f.lab.str("/password")) }).await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // A stored password the server no longer accepts falls back to asking.
    let stale =
        f.host("stale", port, &user, HostAuthInput::StoredPassword { password: Some("old password".into()) }).await;
    let mut client = Client::open_ssh(&f.core, &stale).await;
    let (_, prompt) = client.until_not_state().await;
    assert_eq!(auth_prompt(&prompt).1, AuthPromptKind::Password);
    client.answer(&auth_prompt(&prompt).0, Some(&f.lab.str("/password")));
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // Encrypted key, passphrase remembered in the vault: no prompt.
    let remembered = f.import("ed25519Encrypted", Some(&passphrase), true).await;
    let summary = f.core.vault.list_keys().await.unwrap().into_iter().find(|k| k.id == remembered).unwrap();
    assert!(summary.passphrase_protected && summary.passphrase_stored);
    let host = f.host("enc remembered", port, &user, HostAuthInput::Key { key_id: remembered.clone() }).await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // Same key without the stored passphrase: the session asks for it, and retries a wrong one.
    f.core.vault.delete_host(&host).await.unwrap();
    f.core.vault.delete_key(&remembered).await.unwrap();
    let not_remembered = f.import("ed25519Encrypted", Some(&passphrase), false).await;
    let host = f.host("enc ask", port, &user, HostAuthInput::Key { key_id: not_remembered }).await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    let (prompt_id, kind, _) = auth_prompt(&prompt);
    assert_eq!(kind, AuthPromptKind::KeyPassphrase);
    client.answer(&prompt_id, Some("not the passphrase"));
    let (_, prompt) = client.until_not_state().await;
    let (prompt_id, kind, attempt) = auth_prompt(&prompt);
    assert_eq!((kind, attempt), (AuthPromptKind::KeyPassphrase, 2));
    client.answer(&prompt_id, Some(&passphrase));
    client.until_connected().await;
    client.send("echo enc-$((40+2))\n").await;
    client.output_until("enc-42").await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // A key the server does not accept fails cleanly.
    let stranger = f.import("unauthorized", None, false).await;
    let host = f.host("stranger", port, &user, HostAuthInput::Key { key_id: stranger }).await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::AuthFailed));
}

/// INV-07: locking ends sessions, kills pending prompts and makes old handles useless, including
/// after the vault is unlocked again.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn locking_the_vault_closes_sessions_and_invalidates_handles() {
    let f = fixture().await;
    let host_id = f.key_host("a").await;
    let ask_host = f.host("ask", f.lab.port("a"), &f.lab.str("/user"), HostAuthInput::AskPassword).await;

    let mut connected = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = connected.until_not_state().await;
    connected.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    connected.until_connected().await;
    let mut local = Client::open_local(&f.core).await;
    local.until_connected().await;
    // A third session parked at a password prompt.
    let mut prompting = Client::open_ssh(&f.core, &ask_host).await;
    let (_, prompt) = prompting.until_not_state().await;
    let pending_prompt = auth_prompt(&prompt).0;
    assert_eq!(f.core.sessions.count(), 3);

    f.core.vault.lock().await;
    assert_eq!(f.core.vault.status().await.unwrap().state, VaultState::Locked);
    for client in [&mut connected, &mut local, &mut prompting] {
        assert_eq!(client.until_closed().await.0, Some(ErrorCode::VaultLocked));
    }
    assert_eq!(f.core.sessions.count(), 0);

    // Every handle from before the lock is dead, even once the vault is unlocked again.
    f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let s = &f.core.sessions;
    assert_eq!(
        s.write(WINDOW, &connected.session, b"echo nope\n".to_vec()).await.unwrap_err().code,
        ErrorCode::AccessDenied
    );
    assert_eq!(s.resize(WINDOW, &connected.session, 80, 24).await.unwrap_err().code, ErrorCode::AccessDenied);
    assert_eq!(s.close(WINDOW, &local.session).unwrap_err().code, ErrorCode::AccessDenied);
    let late_answer = s.answer_auth(WINDOW, &prompting.session, &pending_prompt, Some(f.lab.str("/password")));
    assert_eq!(late_answer.unwrap_err().code, ErrorCode::AccessDenied);

    // Opening while locked is refused; there is no way to start secret-backed work.
    f.core.vault.lock().await;
    let (tx, _rx) = mpsc::unbounded_channel();
    let refused = f.core.sessions.open_ssh(WINDOW, &host_id, 80, 24, Arc::new(ChannelSink(tx.clone()))).await;
    assert_eq!(refused.unwrap_err().code, ErrorCode::VaultLocked);
    let refused = f.core.sessions.open_local(WINDOW, 80, 24, Arc::new(ChannelSink(tx))).await;
    assert_eq!(refused.unwrap_err().code, ErrorCode::VaultLocked);
}

/// INV-06: a session id is not a capability. Another window cannot read, write, resize, answer
/// prompts for or close a session it does not own, and probing cannot tell ids apart.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn another_window_cannot_use_or_probe_a_session() {
    let f = fixture().await;
    let ask_host = f.host("ask", f.lab.port("a"), &f.lab.str("/user"), HostAuthInput::AskPassword).await;
    let mut client = Client::open_ssh(&f.core, &ask_host).await;
    let (_, prompt) = client.until_not_state().await;
    let trust_id = trust_prompt_id(&prompt);

    let s = &f.core.sessions;
    let other = "detached-1";
    let hijack = s.answer_trust(other, &client.session, &trust_id, TrustDecision::Always);
    assert_eq!(hijack.unwrap_err().code, ErrorCode::AccessDenied);
    assert!(f.core.vault.list_known_hosts().await.unwrap().is_empty(), "a foreign window must not grant trust");

    client.trust(&trust_id, TrustDecision::Once);
    let (_, prompt) = client.until_not_state().await;
    let auth_id = auth_prompt(&prompt).0;
    let hijack = s.answer_auth(other, &client.session, &auth_id, Some("attacker-chosen".into()));
    assert_eq!(hijack.unwrap_err().code, ErrorCode::AccessDenied);
    client.answer(&auth_id, Some(&f.lab.str("/password")));
    client.until_connected().await;

    let wrong_owner = s.write(other, &client.session, b"echo hijacked\n".to_vec()).await.unwrap_err();
    let no_such_session = s.write(other, "ffffffffffffffffffffffffffffffff", b"x".to_vec()).await.unwrap_err();
    assert_eq!(wrong_owner, no_such_session, "responses must not reveal which ids exist");
    assert_eq!(wrong_owner.code, ErrorCode::AccessDenied);
    assert_eq!(s.resize(other, &client.session, 80, 24).await.unwrap_err().code, ErrorCode::AccessDenied);
    assert_eq!(s.ack(other, &client.session, 1).await.unwrap_err().code, ErrorCode::AccessDenied);
    assert_eq!(s.close(other, &client.session).unwrap_err().code, ErrorCode::AccessDenied);

    // The owner is unaffected, and closing the other window's sessions does not touch this one.
    s.close_all_for_owner(other);
    client.send("echo mine-$((40+2))\n").await;
    client.output_until("mine-42").await;
    assert!(!client.text.contains("hijacked"));
    s.close_all_for_owner(WINDOW);
    assert_eq!(client.until_closed().await, (None, None));

    // Bounds are enforced before anything is queued.
    let mut client = Client::open_local(&f.core).await;
    client.until_connected().await;
    assert_eq!(
        s.write(WINDOW, &client.session, vec![b'a'; 64 * 1024 + 1]).await.unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 1001)] {
        assert_eq!(s.resize(WINDOW, &client.session, cols, rows).await.unwrap_err().code, ErrorCode::InvalidInput);
    }
}

/// INV-12: without acknowledgements the core stops forwarding at the queued-output ceiling
/// instead of buffering a flood; acknowledging resumes it, and nothing is lost or reordered.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn unacknowledged_output_is_capped_then_resumes_without_loss() {
    const CEILING: usize = 1024 * 1024;
    const BATCH: usize = 64 * 1024;
    const LAST: u64 = 1_500_000; // ~10.9 MiB

    let f = fixture().await;
    let host_id = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host_id).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    client.send("stty -echo -onlcr; clear\n").await;
    client.send("echo start-$((40+2))\n").await;
    client.output_until("start-42").await;

    // Stop acknowledging and start the flood.
    client.auto_ack = false;
    let baseline = client.received;
    client.text.clear();
    client.send(&format!("seq 1 {LAST}; echo flood-$((40+2))\n")).await;

    // Collect until nothing arrives for a full second: the core has stopped at its ceiling.
    let mut unacked = 0usize;
    let mut raw = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(1), client.inbox.recv()).await {
            Ok(Some(Message::Output(bytes))) => {
                unacked += bytes.len();
                raw.extend_from_slice(&bytes);
            }
            Ok(Some(Message::Event(event))) => panic!("unexpected event {event:?}"),
            Ok(None) => panic!("closed"),
            Err(_) => break,
        }
    }
    assert!(unacked >= CEILING, "forwarded only {unacked} bytes before stalling");
    assert!(unacked < CEILING + 2 * BATCH, "forwarded {unacked} bytes with no acknowledgement (ceiling {CEILING})");
    assert!(!String::from_utf8_lossy(&raw).contains("flood-42"), "the flood must not have completed");

    // Acknowledge as a renderer would and drain the rest.
    f.core.sessions.ack(WINDOW, &client.session, unacked as u32).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    // The shell prints its prompt after the marker, so look for the marker near the end.
    let finished = |raw: &[u8]| raw[raw.len().saturating_sub(256)..].windows(9).any(|w| w == b"flood-42\n");
    while !finished(&raw) {
        match tokio::time::timeout_at(deadline, client.inbox.recv()).await.expect("flood did not finish") {
            Some(Message::Output(bytes)) => {
                f.core.sessions.ack(WINDOW, &client.session, bytes.len() as u32).await.unwrap();
                raw.extend_from_slice(&bytes);
            }
            Some(Message::Event(event)) => panic!("unexpected event {event:?}"),
            None => panic!("closed"),
        }
    }
    let text = String::from_utf8(raw).expect("ascii");
    let mut expected = 1u64;
    for line in text.lines() {
        if line == "flood-42" {
            break;
        }
        assert_eq!(line.parse::<u64>().ok(), Some(expected), "output lost or reordered near line {expected}");
        expected += 1;
    }
    assert_eq!(expected, LAST + 1);
    let _ = baseline;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn local_terminal_runs_the_users_shell_and_closes_on_request() {
    let f = fixture().await;
    let mut client = Client::open_local(&f.core).await;
    client.until_connected().await;
    client.send("echo local-$((40+2))\n").await;
    client.output_until("local-42").await;
    f.core.sessions.resize(WINDOW, &client.session, 132, 43).await.unwrap();
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    assert_eq!(client.until_closed().await, (None, None));
    assert_eq!(f.core.sessions.count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn unreachable_and_denied_destinations_report_specific_errors() {
    let f = fixture().await;
    let user = f.lab.str("/user");
    let closed_port = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let host = f.host("refused", closed_port, &user, HostAuthInput::AskPassword).await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::Unreachable));

    let host = f
        .host(
            "no session",
            f.lab.port("a"),
            &f.lab.str("/noSessionUser"),
            HostAuthInput::StoredPassword { password: Some(f.lab.str("/password")) },
        )
        .await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Once);
    let (code, _) = client.until_closed().await;
    assert!(matches!(code, Some(ErrorCode::ChannelDenied | ErrorCode::Disconnected)), "{code:?}");

    assert_eq!(
        f.core
            .sessions
            .open_ssh(
                WINDOW,
                "00000000000000000000000000000000",
                80,
                24,
                Arc::new(ChannelSink(mpsc::unbounded_channel().0))
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(f.core.sessions.count(), 0);
}

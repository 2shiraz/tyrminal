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
    AuthPromptKind, ConflictChoice, ErrorCode, HostAuthInput, HostInput, HostProtocol, KeyImportInput, SessionEvent,
    SessionState, TransferEvent, TrustDecision, VaultState,
};
use tyrminal_core::{Core, SessionSink, TransferSink};

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
    /// The sshd log: a file in the container-free lab, `docker logs` in the container lab.
    fn server_log(&self, server: &str) -> String {
        if let Some(file) = self.0.pointer(&format!("/servers/{server}/logFile")).and_then(Value::as_str) {
            return std::fs::read_to_string(file).expect("lab sshd log");
        }
        let container = self.str(&format!("/servers/{server}/container"));
        let out = Command::new("docker").args(["logs", &container]).output().expect("docker logs");
        format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
    }

    fn auth_log_lines(&self, server: &str) -> usize {
        let text = self.server_log(server);
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
    /// The last `Negotiated` event, which arrives just before `Connected`.
    negotiated: Option<SessionEvent>,
    /// The window this stand-in plays.
    window: &'static str,
}

impl Client {
    async fn open_ssh(core: &Core, host_id: &str) -> Self {
        let (tx, inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_ssh(WINDOW, host_id, 100, 30, Arc::new(ChannelSink(tx))).await.expect("open");
        Self {
            core: core.clone(),
            session: opened.session_id,
            inbox,
            text: String::new(),
            received: 0,
            auto_ack: true,
            negotiated: None,
            window: WINDOW,
        }
    }

    async fn open_local(core: &Core) -> Self {
        let (tx, inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_local(WINDOW, 100, 30, Arc::new(ChannelSink(tx))).await.expect("open local");
        Self {
            core: core.clone(),
            session: opened.session_id,
            inbox,
            text: String::new(),
            received: 0,
            auto_ack: true,
            negotiated: None,
            window: WINDOW,
        }
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
        // Answer cursor-position queries as a terminal would: Windows ConPTY sends one when a
        // console starts and waits for the reply before the shell produces output. (In the
        // app, xterm.js answers it.) Counted over everything received, so a query split across
        // two chunks is still answered.
        let before = self.text.matches("\x1b[6n").count();
        self.text.push_str(&String::from_utf8_lossy(&bytes));
        let queries = self.text.matches("\x1b[6n").count() - before;
        for _ in 0..queries {
            let _ = self.core.sessions.write(self.window, &self.session, b"\x1b[1;1R".to_vec()).await;
        }
        if self.auto_ack {
            let _ = self.core.sessions.ack(self.window, &self.session, bytes.len() as u32).await;
        }
    }

    /// Skips state events until one that is not a plain state change.
    async fn until_not_state(&mut self) -> (Vec<SessionState>, SessionEvent) {
        let mut states = Vec::new();
        loop {
            match self.event().await {
                SessionEvent::State { state } if state != SessionState::Connected => states.push(state),
                event @ SessionEvent::Negotiated { .. } => self.negotiated = Some(event),
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
        // Matched without escape sequences: line editors such as PowerShell's colour each token.
        while !strip_escapes(&self.text).contains(needle) {
            match tokio::time::timeout_at(deadline, self.inbox.recv()).await {
                Ok(Some(Message::Output(bytes))) => self.absorb(bytes).await,
                Ok(Some(Message::Event(event))) => panic!("unexpected event while waiting for {needle:?}: {event:?}"),
                Ok(None) => panic!("closed while waiting for {needle:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; got {:?}", self.text),
            }
        }
    }

    /// Types `text`; a newline is the Enter key, which a terminal sends as CR (PowerShell under
    /// ConPTY submits only on CR; Unix terminal drivers turn CR into NL).
    async fn send(&self, text: &str) {
        let keys = text.replace('\n', "\r");
        self.core.sessions.write(self.window, &self.session, keys.into_bytes()).await.expect("write");
    }

    fn trust(&self, prompt_id: &str, decision: TrustDecision) {
        self.core.sessions.answer_trust(self.window, &self.session, prompt_id, decision).expect("answer trust");
    }

    fn answer(&self, prompt_id: &str, secret: Option<&str>) {
        self.core
            .sessions
            .answer_auth(self.window, &self.session, prompt_id, secret.map(Into::into))
            .expect("answer auth");
    }
}

/// (major, minor) from "OpenSSH_9.6p1 Ubuntu-3", "OpenSSH 10.0p1 (Alpine …)" or "OpenSSH_for_Windows_9.5p1".
fn openssh_version(text: &str) -> (u32, u32) {
    let start = text.find(|c: char| c.is_ascii_digit()).unwrap_or_else(|| panic!("no version in {text:?}"));
    let mut parts = text[start..].split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty());
    let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (major, minor)
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

/// Removes terminal escape sequences (CSI, OSC and two-byte ESC sequences) from `text`.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte in @..~.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
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
            port: Some(port),
            username: username.into(),
            auth,
            group_id: None,
            tags: Vec::new(),
            protocol: HostProtocol::Ssh,
            terminal: Default::default(),
            forward_agent: false,
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
    // The negotiated algorithms are reported, and each one is from this client's own offer.
    match client.negotiated.as_ref().expect("negotiated algorithms are reported") {
        SessionEvent::Negotiated { kex, host_key, cipher, mac, strict_kex } => {
            let offer = tyrminal_ssh::negotiation_summary();
            for value in [kex, host_key, cipher] {
                assert!(offer.contains(value.as_str()), "{value} is not in the offer:\n{offer}");
            }
            assert!(mac.is_empty() || offer.contains(mac.as_str()), "{mac}");
            assert_eq!(host_key, "ssh-ed25519");
            // Strict key exchange (the Terrapin countermeasure) exists from OpenSSH 9.6.
            let version = f.lab.str("/serverVersion");
            let (major, minor) = openssh_version(&version);
            if (major, minor) >= (9, 6) {
                assert!(*strict_kex, "{version} negotiates strict key exchange");
            }
        }
        other => panic!("{other:?}"),
    }
    client.send("echo core-$((40+2)); id -un; stty size\n").await;
    client.output_until("core-42").await;
    client.output_until("30 100").await;
    assert!(client.text.contains(&f.lab.str("/user")));

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
    client
        .send(&format!("awk 'BEGIN {{ for (i = 1; i <= {LAST}; i++) printf \"%d\\n\", i }}'; echo flood-$((40+2))\n"))
        .await;

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

/// SNP-07 / TRM-14: a snippet is sent only to a session the calling window owns, its text comes
/// from the vault at the session's generation, Run executes it and Paste only inserts it, and
/// after a lock nothing is sent.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn snippets_reach_only_owned_sessions_and_stop_at_lock() {
    use tyrminal_core::contracts::{SnippetInput, SnippetSendMode};
    let f = fixture().await;
    let s = &f.core.sessions;
    let snippet = f
        .core
        .vault
        .save_snippet(SnippetInput {
            id: None,
            name: "fixture".into(),
            folder: "lab".into(),
            text: "echo snip-$((40+2))\necho line-$((7*6))".into(),
        })
        .await
        .unwrap();

    let mut client = Client::open_local(&f.core).await;
    client.until_connected().await;

    // Another window cannot send it, and cannot tell a real session from a guessed one.
    let foreign = s.send_snippet("detached-1", &client.session, &snippet.id, SnippetSendMode::Run, false).await;
    let guessed = s.send_snippet("detached-1", &"f".repeat(32), &snippet.id, SnippetSendMode::Run, false).await;
    assert_eq!(foreign.unwrap_err(), guessed.unwrap_err());
    // A missing snippet on an owned session is reported as such.
    let missing = s.send_snippet(WINDOW, &client.session, &"0".repeat(32), SnippetSendMode::Run, false).await;
    assert_eq!(missing.unwrap_err().code, ErrorCode::NotFound);

    s.send_snippet(WINDOW, &client.session, &snippet.id, SnippetSendMode::Run, false).await.unwrap();
    client.output_until("snip-42").await;
    client.output_until("line-42").await;
    assert!(!client.text.contains("hijack"));

    // Paste inserts without executing: the shell echoes the text but no result line follows.
    let paste = f
        .core
        .vault
        .save_snippet(SnippetInput {
            id: None,
            name: "p".into(),
            folder: String::new(),
            text: "echo pasted-$((1+1))".into(),
        })
        .await
        .unwrap();
    s.send_snippet(WINDOW, &client.session, &paste.id, SnippetSendMode::Paste, false).await.unwrap();
    client.output_until("echo pasted-$((1+1))").await; // on the prompt line, not run
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!client.text.contains("pasted-2"), "Paste must not execute: {:?}", client.text);
    client.send("\u{3}").await; // Ctrl+C discards the pasted line.
    // Let the shell discard the line and redraw its prompt before typing on, as a person would.
    // (Whether "^C" is echoed depends on the shell: bash 3.2 on macOS does not.)
    tokio::time::sleep(Duration::from_millis(700)).await;
    client.send("echo after-$((1+1))-paste\n").await;
    client.output_until("after-2-paste").await;
    assert!(!client.text.contains("pasted-2"), "Paste must not execute: {:?}", client.text);

    // Lock: the session ends and the snippet can no longer be sent anywhere.
    f.core.vault.lock().await;
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::VaultLocked));
    let after = s.send_snippet(WINDOW, &client.session, &snippet.id, SnippetSendMode::Run, false).await;
    assert_eq!(after.unwrap_err().code, ErrorCode::AccessDenied);
}

/// The home view's recent connections: a host is recorded when its session reaches the shell.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn connecting_records_the_host_as_recent() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    assert!(f.core.vault.recent_hosts().await.unwrap().is_empty());
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Once);
    client.until_connected().await;
    // Recorded right after Connected is reported; poll the explicit state briefly.
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let recent = f.core.vault.recent_hosts().await.unwrap();
        if let Some(first) = recent.first() {
            assert_eq!(first.id, host);
            assert!(first.last_connected_at.is_some());
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "host was not recorded as recent");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn closing_right_after_connect_leaves_the_host_editable() {
    // Closing drops the session future while the recent-connection write may be in flight; that
    // must never leave the vault's view of the host's revision behind the database.
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut trusted = false;
    for _ in 0..5 {
        let mut client = Client::open_ssh(&f.core, &host).await;
        if !trusted {
            let (_, prompt) = client.until_not_state().await;
            client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
            trusted = true;
        }
        client.until_connected().await;
        f.core.sessions.close(WINDOW, &client.session).unwrap();
        client.until_closed().await;
    }
    let deadline = tokio::time::Instant::now() + WAIT;
    while f.core.vault.recent_hosts().await.unwrap().is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "host was not recorded as recent");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    f.core.vault.delete_host(&host).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn keyboard_interactive_server_prompts_reach_the_user_and_sign_in() {
    let f = fixture().await;
    let Some(port) = f.lab.0.pointer("/servers/kbd/port").and_then(Value::as_u64) else {
        panic!("BLOCKED: this lab has no keyboard-interactive server (local mode on Linux or macOS provides one)");
    };
    let port = port as u16;
    let user = f.lab.str("/user");
    let host = f.host("kbd", port, &user, HostAuthInput::AskPassword).await;

    // The server offers only keyboard-interactive: its own question is shown, sanitized, with
    // the echo flag the server sent (PAM's password question: no echo).
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Once);
    let (_, prompt) = client.until_not_state().await;
    let SessionEvent::AuthPrompt { prompt_id, kind, message, echo, attempt, .. } = prompt else {
        panic!("expected an auth prompt, got {prompt:?}");
    };
    assert_eq!((kind, attempt, echo), (AuthPromptKind::KeyboardInteractive, 1, false));
    let message = message.expect("the server's question is shown");
    assert!(message.to_lowercase().contains("password"), "{message}");
    assert!(!message.chars().any(|c| c.is_control() && c != '\n'), "{message:?}");

    // A wrong answer: the exchange starts again and the user is asked again, at most 3 times.
    client.answer(&prompt_id, Some("definitely wrong"));
    let (_, prompt) = client.until_not_state().await;
    let (prompt_id, kind, attempt) = auth_prompt(&prompt);
    assert_eq!((kind, attempt), (AuthPromptKind::KeyboardInteractive, 2));
    client.answer(&prompt_id, Some(&f.lab.str("/password")));
    client.until_connected().await;
    client.send("echo kbd-$((40+2))\n").await;
    client.output_until("kbd-42").await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // Dismissing the prompt cancels; nothing is retried on the user's behalf.
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Once);
    let (_, prompt) = client.until_not_state().await;
    client.answer(&auth_prompt(&prompt).0, None);
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::Cancelled));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_dropped_connection_is_reported_as_lost_and_a_normal_exit_is_not() {
    // The renderer offers automatic reconnect only for a lost connection, so the two endings
    // must stay distinguishable.
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    client.send("exit 3\n").await;
    assert_eq!(client.until_closed().await, (None, Some(3)));

    let mut client = Client::open_ssh(&f.core, &host).await;
    client.until_connected().await;
    client.send("kill -9 $PPID\n").await;
    assert_eq!(client.until_closed().await, (Some(ErrorCode::Disconnected), None));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn deploying_a_public_key_appends_one_line_and_keeps_the_others() {
    // The lab account is disposable; the lab's sshd reads authorized keys from its own file,
    // so this touches only the account's ~/.ssh.
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    // An existing entry without a final newline.
    client.send("mkdir -p ~/.ssh && printf 'ssh-rsa AAAAB3NzaUnrelated keep-me' > ~/.ssh/authorized_keys && chmod 640 ~/.ssh/authorized_keys && echo PREP-$((40+2))\n").await;
    client.output_until("PREP-42").await;

    let key = f.core.vault.generate_key("deployed").await.unwrap();
    let s = &f.core.sessions;
    let preview = s.deploy_key_preview(WINDOW, &client.session, &key.id).await.unwrap();
    assert_eq!((preview.existing_keys, preview.already_present), (1, false));
    assert_eq!(preview.line, key.public_key);

    // Another window cannot use this session's connection.
    assert_eq!(s.deploy_key("other-window", &client.session, &key.id).await.unwrap_err().code, ErrorCode::AccessDenied);

    let done = s.deploy_key(WINDOW, &client.session, &key.id).await.unwrap();
    assert_eq!((done.existing_keys, done.already_present), (2, true));
    // Idempotent: a second install changes nothing.
    let again = s.deploy_key(WINDOW, &client.session, &key.id).await.unwrap();
    assert_eq!((again.existing_keys, again.already_present), (2, true));

    client.send("echo FILE-BEGIN; cat ~/.ssh/authorized_keys; echo FILE-END; ls -l ~/.ssh/authorized_keys; echo LS1-$((40+2))\n").await;
    client.output_until("LS1-42").await;
    let expected = format!("keep-me\r\n{}\r\nFILE-END", key.public_key);
    assert!(client.text.contains(&expected), "{:?}", client.text);
    // The mode was set explicitly above (the account's umask differs between runners).
    assert!(client.text.contains("-rw-r-----"), "an existing file keeps its permissions: {:?}", client.text);

    // No file at all: deploying creates it owner-only.
    // A default ACL on the folder (as on some hosts) must not make the new file group-writable.
    client
        .send("rm -f ~/.ssh/authorized_keys; { command -v setfacl >/dev/null && setfacl -d -m g::rwx,o::rx ~/.ssh; true; } && echo GONE-$((40+2))\n")
        .await;
    client.output_until("GONE-42").await;
    s.deploy_key(WINDOW, &client.session, &key.id).await.unwrap();
    client.text.clear();
    client.send("ls -l ~/.ssh/authorized_keys; echo LS-$((40+2))\n").await;
    client.output_until("LS-42").await;
    assert!(client.text.contains("-rw-------"), "a new file is owner-only: {:?}", client.text);
    client.send("{ command -v setfacl >/dev/null && setfacl -k ~/.ssh; true; }\n").await;
    client.send("rm -f ~/.ssh/authorized_keys\n").await;

    // A local terminal has no SSH connection to install over.
    let local = Client::open_local(&f.core).await;
    assert_eq!(s.deploy_key(WINDOW, &local.session, &key.id).await.unwrap_err().code, ErrorCode::InvalidInput);
}

// ---------- files (SFTP) ----------

struct TransferInbox(mpsc::UnboundedSender<TransferEvent>);

impl TransferSink for TransferInbox {
    fn event(&self, event: TransferEvent) -> bool {
        self.0.send(event).is_ok()
    }
}

fn transfer_sink() -> (Arc<dyn TransferSink>, mpsc::UnboundedReceiver<TransferEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(TransferInbox(tx)), rx)
}

/// The final event of a transfer (progress events skipped).
async fn transfer_end(rx: &mut mpsc::UnboundedReceiver<TransferEvent>) -> TransferEvent {
    loop {
        match tokio::time::timeout(Duration::from_secs(120), rx.recv()).await.expect("transfer timed out") {
            Some(TransferEvent::Progress { .. }) => {}
            Some(other) => return other,
            None => panic!("transfer channel closed"),
        }
    }
}

/// The final event of a one-file transfer of `bytes` bytes.
fn done(bytes: u64) -> TransferEvent {
    TransferEvent::Done { bytes, files: 1, skipped: 0 }
}

/// Deterministic, incompressible-looking test data.
fn pattern(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn sftp_browse_change_and_transfer_files_byte_for_byte() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let s = &f.core.sessions;
    let id = &client.session;

    // The login folder, absolute, without . and ..
    let home = s.list_files(WINDOW, id, None).await.unwrap();
    assert!(home.path.starts_with('/'), "{}", home.path);
    assert!(home.entries.iter().all(|e| e.name != "." && e.name != ".."));
    // Another window cannot browse this session.
    assert_eq!(s.list_files("other-window", id, None).await.unwrap_err().code, ErrorCode::AccessDenied);

    let folder_name = format!("tyr-files-{}", std::process::id());
    let _ = s.remove_file(WINDOW, id, &home.path, &folder_name).await;
    s.make_dir(WINDOW, id, &home.path, &folder_name).await.unwrap();
    let dir = format!("{}/{folder_name}", home.path.trim_end_matches('/'));
    let listing = s.list_files(WINDOW, id, Some(&dir)).await.unwrap();
    assert!(listing.entries.is_empty());
    assert_eq!(listing.parent.as_deref(), Some(home.path.as_str()));
    // Names are single components: no traversal out of the folder.
    for bad in ["../escape", "a/b", "..", ""] {
        assert_eq!(s.make_dir(WINDOW, id, &dir, bad).await.unwrap_err().code, ErrorCode::InvalidInput, "{bad:?}");
    }
    assert_eq!(s.list_files(WINDOW, id, Some("relative/path")).await.unwrap_err().code, ErrorCode::InvalidInput);

    // Upload: a multi-chunk file and a file with a strange (but legal) name.
    let local = TempDir::new().unwrap();
    let big = pattern(9 * 1024 * 1024 + 123, 7);
    std::fs::write(local.path().join("big.bin"), &big).unwrap();
    let strange = "we ird;$(touch pwned) ü.txt";
    std::fs::write(local.path().join(strange), b"strange\n").unwrap();
    for name in ["big.bin", strange] {
        let (sink, mut rx) = transfer_sink();
        let started =
            s.upload(WINDOW, id, local.path().join(name), &dir, name, ConflictChoice::Ask, sink).await.unwrap();
        assert_eq!(started.name, name);
        let end = transfer_end(&mut rx).await;
        let expected = std::fs::metadata(local.path().join(name)).unwrap().len();
        assert_eq!(end, done(expected), "{name}");
    }
    let listing = s.list_files(WINDOW, id, Some(&dir)).await.unwrap();
    let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["big.bin", strange], "no temporary files are left behind");
    assert_eq!(listing.entries[0].size, Some(big.len() as u64));
    // The name was never handed to a shell.
    assert!(!s.list_files(WINDOW, id, Some(&home.path)).await.unwrap().entries.iter().any(|e| e.name == "pwned"));

    // Same name again: a conflict unless replacing was chosen.
    let (sink, _rx) = transfer_sink();
    let conflict = s
        .upload(WINDOW, id, local.path().join("big.bin"), &dir, "big.bin", ConflictChoice::Ask, sink)
        .await
        .unwrap_err();
    assert_eq!(conflict.code, ErrorCode::Conflict);
    std::fs::write(local.path().join("big.bin"), pattern(1000, 9)).unwrap();
    let (sink, mut rx) = transfer_sink();
    s.upload(WINDOW, id, local.path().join("big.bin"), &dir, "big.bin", ConflictChoice::Replace, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, done(1000));
    std::fs::write(local.path().join("big.bin"), &big).unwrap();
    let (sink, mut rx) = transfer_sink();
    s.upload(WINDOW, id, local.path().join("big.bin"), &dir, "big.bin", ConflictChoice::Replace, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, done(big.len() as u64));

    // Download into another folder: byte for byte.
    let down = TempDir::new().unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, id, &dir, "big.bin", down.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, done(big.len() as u64));
    assert!(std::fs::read(down.path().join("big.bin")).unwrap() == big, "downloaded bytes differ");
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, id, &dir, strange, down.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, done(8));
    assert_eq!(std::fs::read(down.path().join(strange)).unwrap(), b"strange\n");
    // An existing local file is a conflict; replacing it is explicit.
    std::fs::write(down.path().join("big.bin"), b"local edit").unwrap();
    let (sink, _rx) = transfer_sink();
    let err = s
        .download(WINDOW, id, &dir, "big.bin", down.path().to_path_buf(), ConflictChoice::Ask, sink)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(std::fs::read(down.path().join("big.bin")).unwrap(), b"local edit");
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, id, &dir, "big.bin", down.path().to_path_buf(), ConflictChoice::Replace, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, done(big.len() as u64));
    assert!(std::fs::read(down.path().join("big.bin")).unwrap() == big);
    let leftovers: Vec<_> = std::fs::read_dir(down.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers.len(), 2, "no temporary files: {leftovers:?}");

    // A remote name that is legal on the server but unusable locally is refused, not altered.
    s.make_dir(WINDOW, id, &dir, "back\\slash").await.unwrap();
    let (sink, _rx) = transfer_sink();
    let err = s.download(WINDOW, id, &dir, "back\\slash", down.path().to_path_buf(), ConflictChoice::Ask, sink).await;
    assert_eq!(err.unwrap_err().code, ErrorCode::InvalidInput);
    s.remove_file(WINDOW, id, &dir, "back\\slash").await.unwrap();

    // Cancel: nothing remains under the final name, and no temporary file either.
    let huge = pattern(96 * 1024 * 1024, 3);
    std::fs::write(local.path().join("huge.bin"), &huge).unwrap();
    let (sink, mut rx) = transfer_sink();
    let started =
        s.upload(WINDOW, id, local.path().join("huge.bin"), &dir, "huge.bin", ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(s.cancel_transfer("other-window", &started.transfer_id).unwrap_err().code, ErrorCode::AccessDenied);
    s.cancel_transfer(WINDOW, &started.transfer_id).unwrap();
    assert_eq!(transfer_end(&mut rx).await, TransferEvent::Cancelled);
    let names: Vec<_> =
        s.list_files(WINDOW, id, Some(&dir)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["big.bin", strange]);

    // Rename (never over an existing name), permissions, removal.
    let err = s.rename_file(WINDOW, id, &dir, strange, "big.bin").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    s.rename_file(WINDOW, id, &dir, strange, "plain.txt").await.unwrap();
    s.set_file_mode(WINDOW, id, &dir, "plain.txt", 0o640).await.unwrap();
    let plain = s.list_files(WINDOW, id, Some(&dir)).await.unwrap();
    let plain = plain.entries.iter().find(|e| e.name == "plain.txt").unwrap();
    assert_eq!(plain.permissions, Some(0o640));
    assert_eq!(
        s.set_file_mode(WINDOW, id, &dir, "plain.txt", 0o10000).await.unwrap_err().code,
        ErrorCode::InvalidInput
    );

    // Permission denied is reported as such.
    s.make_dir(WINDOW, id, &dir, "locked").await.unwrap();
    s.set_file_mode(WINDOW, id, &dir, "locked", 0o500).await.unwrap();
    let err = s.make_dir(WINDOW, id, &format!("{dir}/locked"), "inner").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AccessDenied);
    s.remove_file(WINDOW, id, &dir, "locked").await.unwrap();

    // A folder that is not empty is not removed.
    assert_eq!(s.remove_file(WINDOW, id, &home.path, &folder_name).await.unwrap_err().code, ErrorCode::IoError);
    for name in ["big.bin", "plain.txt"] {
        s.remove_file(WINDOW, id, &dir, name).await.unwrap();
    }
    s.remove_file(WINDOW, id, &home.path, &folder_name).await.unwrap();

    // A local terminal has no SFTP.
    let local_session = Client::open_local(&f.core).await;
    let err = s.list_files(WINDOW, &local_session.session, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn sftp_folders_copy_whole_trees_skip_links_and_never_leave_partial_folders() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let s = &f.core.sessions;
    let id = &client.session.clone();
    let home = s.list_files(WINDOW, id, None).await.unwrap().path;
    let base_name = format!("tyr-folders-{}", std::process::id());
    let base = format!("{}/{base_name}", home.trim_end_matches('/'));
    client.send(&format!("rm -rf {base}; mkdir -p {base} && echo MK-$((40+2))\n")).await;
    client.output_until("MK-42").await;

    // A local tree: nested folders, an empty folder, several files and a link (never followed).
    let local = TempDir::new().unwrap();
    let src = local.path().join("project");
    std::fs::create_dir_all(src.join("src/deep/er")).unwrap();
    std::fs::create_dir_all(src.join("empty")).unwrap();
    let big = pattern(3 * 1024 * 1024 + 7, 11);
    std::fs::write(src.join("src/deep/er/data.bin"), &big).unwrap();
    std::fs::write(src.join("README"), b"readme\n").unwrap();
    std::fs::write(src.join("src/main.rs"), b"fn main() {}\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/passwd", src.join("src/link")).unwrap();
    let expected_bytes = big.len() as u64 + 7 + 13;

    let (sink, mut rx) = transfer_sink();
    let started = s.upload(WINDOW, id, src.clone(), &base, "project", ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(started.total, Some(expected_bytes));
    let skipped = u32::from(cfg!(unix));
    assert_eq!(transfer_end(&mut rx).await, TransferEvent::Done { bytes: expected_bytes, files: 3, skipped });
    let top: Vec<_> =
        s.list_files(WINDOW, id, Some(&base)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    assert_eq!(top, ["project"], "no temporary folder is left behind");
    let inner = s.list_files(WINDOW, id, Some(&format!("{base}/project/src"))).await.unwrap();
    let names: Vec<_> = inner.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["deep", "main.rs"], "the link was not copied");
    assert!(s.list_files(WINDOW, id, Some(&format!("{base}/project/empty"))).await.unwrap().entries.is_empty());

    // The same folder again: never merged into the existing one.
    let (sink, _rx) = transfer_sink();
    let err = s.upload(WINDOW, id, src.clone(), &base, "project", ConflictChoice::Replace, sink).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);

    // Download the tree back: byte for byte, same shape.
    let down = TempDir::new().unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, id, &base, "project", down.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, TransferEvent::Done { bytes: expected_bytes, files: 3, skipped: 0 });
    let back = down.path().join("project");
    assert!(std::fs::read(back.join("src/deep/er/data.bin")).unwrap() == big);
    assert_eq!(std::fs::read(back.join("README")).unwrap(), b"readme\n");
    assert!(back.join("empty").is_dir());
    let leftovers: Vec<_> = std::fs::read_dir(down.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers, [std::ffi::OsString::from("project")]);
    // An existing local folder is a conflict too.
    let (sink, _rx) = transfer_sink();
    let err = s
        .download(WINDOW, id, &base, "project", down.path().to_path_buf(), ConflictChoice::Replace, sink)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);

    // A name inside the tree that cannot exist locally stops the download before anything is written.
    client.send(&format!("mkdir -p '{base}/odd' && touch '{base}/odd/back\\slash' && echo ODD-$((40+2))\n")).await;
    client.output_until("ODD-42").await;
    let (sink, _rx) = transfer_sink();
    let err =
        s.download(WINDOW, id, &base, "odd", down.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(!down.path().join("odd").exists());

    // Cancelling a large folder upload removes everything it created on the server.
    let heavy = local.path().join("heavy");
    std::fs::create_dir_all(heavy.join("a")).unwrap();
    for i in 0..4 {
        std::fs::write(heavy.join(format!("a/part{i}.bin")), pattern(32 * 1024 * 1024, i)).unwrap();
    }
    let (sink, mut rx) = transfer_sink();
    let started = s.upload(WINDOW, id, heavy, &base, "heavy", ConflictChoice::Ask, sink).await.unwrap();
    s.cancel_transfer(WINDOW, &started.transfer_id).unwrap();
    assert_eq!(transfer_end(&mut rx).await, TransferEvent::Cancelled);
    let mut top: Vec<_> =
        s.list_files(WINDOW, id, Some(&base)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    top.sort();
    assert_eq!(top, ["odd", "project"], "nothing of the cancelled folder remains");

    client.send(&format!("rm -rf {base} && echo RM-$((40+2))\n")).await;
    client.output_until("RM-42").await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_link_lost_mid_transfer_fails_promptly_and_leaves_no_partial_file() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let id = client.session.clone();
    let s = &f.core.sessions;
    let home = s.list_files(WINDOW, &id, None).await.unwrap().path;
    let name = format!("tyr-lost-{}.bin", std::process::id());
    client.send(&format!("head -c 268435456 /dev/zero > ~/{name} && echo BIG-$((40+2))\n")).await;
    client.output_until("BIG-42").await;

    let down = TempDir::new().unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, &id, &home, &name, down.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    // Wait until bytes are flowing, then kill this connection's server process.
    match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.unwrap() {
        Some(TransferEvent::Progress { .. }) => {}
        other => panic!("transfer ended before the link was cut: {other:?}"),
    }
    client.send("kill -9 $PPID\n").await;
    let started = std::time::Instant::now();
    let end = transfer_end(&mut rx).await;
    let TransferEvent::Failed { error } = end else { panic!("expected a failure, got {end:?}") };
    assert!(matches!(error.code, ErrorCode::Disconnected | ErrorCode::Timeout), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(40), "the failure was reported promptly");
    let leftovers: Vec<_> = std::fs::read_dir(down.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert!(leftovers.is_empty(), "no partial or temporary file is left: {leftovers:?}");
    assert_eq!(client.until_closed().await.0, Some(ErrorCode::Disconnected));

    // Clean up through a new session.
    let mut again = Client::open_ssh(&f.core, &host).await;
    again.until_connected().await;
    again.send(&format!("rm -f ~/{name}; echo RM-$((40+2))\n")).await;
    again.output_until("RM-42").await;
}

/// Peak resident memory of this process, in KiB (Linux only).
fn peak_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn sha256_file(path: &std::path::Path) -> Vec<u8> {
    use sha2::Digest;
    use std::io::Read;
    let mut file = std::fs::File::open(path).unwrap();
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hasher.finalize().to_vec()
}

/// The Phase 06 gate: a 2 GiB file survives a round trip byte for byte with bounded memory.
/// Opt-in (it moves 4 GiB): `TYRMINAL_BIG_TRANSFER=1`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn two_gib_round_trip_is_byte_for_byte_with_bounded_memory() {
    // Never a silent pass: the runner reports this test BLOCKED unless it is opted in.
    assert!(std::env::var_os("TYRMINAL_BIG_TRANSFER").is_some(), "set TYRMINAL_BIG_TRANSFER=1 (moves 2 GiB each way)");
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let id = client.session.clone();
    let s = &f.core.sessions;
    let home = s.list_files(WINDOW, &id, None).await.unwrap().path;
    let dir_name = format!("tyr-big-{}", std::process::id());
    s.make_dir(WINDOW, &id, &home, &dir_name).await.unwrap();
    let dir = format!("{}/{dir_name}", home.trim_end_matches('/'));

    // 2 GiB of pseudo-random data, written in 1 MiB blocks.
    let local = TempDir::new().unwrap();
    let source = local.path().join("big.bin");
    {
        use std::io::Write;
        let mut file = std::io::BufWriter::new(std::fs::File::create(&source).unwrap());
        for i in 0..2048u64 {
            file.write_all(&pattern(1 << 20, i + 1)).unwrap();
        }
        file.flush().unwrap();
    }
    let size = 2u64 << 30;
    let before = peak_rss_kib();

    let (sink, mut rx) = transfer_sink();
    s.upload(WINDOW, &id, source.clone(), &dir, "big.bin", ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(wait_long(&mut rx).await, done(size));
    let back = TempDir::new().unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, &id, &dir, "big.bin", back.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(wait_long(&mut rx).await, done(size));
    assert_eq!(sha256_file(&source), sha256_file(&back.path().join("big.bin")), "round trip changed bytes");

    // Bounded memory: the transfers themselves add far less than the file size.
    if let (Some(before), Some(after)) = (before, peak_rss_kib()) {
        let grown_mib = after.saturating_sub(before) / 1024;
        eprintln!("peak RSS grew by {grown_mib} MiB over 4 GiB transferred");
        assert!(grown_mib < 256, "peak memory grew by {grown_mib} MiB");
    }
    s.remove_file(WINDOW, &id, &dir, "big.bin").await.unwrap();
    s.remove_file(WINDOW, &id, &home, &dir_name).await.unwrap();
}

/// Like `transfer_end`, for transfers that take minutes.
async fn wait_long(rx: &mut mpsc::UnboundedReceiver<TransferEvent>) -> TransferEvent {
    loop {
        match tokio::time::timeout(Duration::from_secs(900), rx.recv()).await.expect("transfer timed out") {
            Some(TransferEvent::Progress { .. }) => {}
            Some(other) => return other,
            None => panic!("transfer channel closed"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn editing_a_remote_file_saves_explicitly_and_refuses_to_overwrite_server_changes() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let id = client.session.clone();
    let s = &f.core.sessions;
    let home = s.list_files(WINDOW, &id, None).await.unwrap().path;
    let name = format!("tyr-edit-{}.conf", std::process::id());
    client.send(&format!("printf 'port=1\\n' > ~/{name} && chmod 640 ~/{name} && echo MK-$((40+2))\n")).await;
    client.output_until("MK-42").await;
    let root = TempDir::new().unwrap();

    let (local, opened) = s.edit_open(WINDOW, &id, &home, &name, root.path()).await.unwrap();
    assert!(!opened.changed);
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "port=1\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(local.parent().unwrap()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "the edit folder is owner-only");
    }
    // Another window cannot see or save this edit.
    assert_eq!(s.edit_status("other-window", &opened.edit_id).await.unwrap_err().code, ErrorCode::AccessDenied);

    // A local change is detected, never uploaded by itself, and saved on request.
    std::fs::write(&local, "port=2\n").unwrap();
    assert!(s.edit_status(WINDOW, &opened.edit_id).await.unwrap().changed);
    client.text.clear();
    client.send(&format!("cat ~/{name}; echo C1-$((40+2))\n")).await;
    client.output_until("C1-42").await;
    assert!(client.text.contains("port=1"), "nothing was uploaded before saving");
    let saved = s.edit_save(WINDOW, &opened.edit_id, false).await.unwrap();
    assert!(!saved.changed);
    assert!(!s.edit_status(WINDOW, &opened.edit_id).await.unwrap().changed);
    client.text.clear();
    client.send(&format!("cat ~/{name}; ls -l ~/{name}; echo C2-$((40+2))\n")).await;
    client.output_until("C2-42").await;
    assert!(client.text.contains("port=2"), "{:?}", client.text);
    assert!(client.text.contains("-rw-r-----"), "the remote file keeps its permissions: {:?}", client.text);

    // Someone changes the file on the server: saving is refused unless overwriting is chosen.
    client.send(&format!("printf 'port=9\\nextra\\n' > ~/{name} && echo C3-$((40+2))\n")).await;
    client.output_until("C3-42").await;
    std::fs::write(&local, "port=3\n").unwrap();
    assert_eq!(s.edit_save(WINDOW, &opened.edit_id, false).await.unwrap_err().code, ErrorCode::Conflict);
    client.text.clear();
    client.send(&format!("cat ~/{name}; echo C4-$((40+2))\n")).await;
    client.output_until("C4-42").await;
    assert!(client.text.contains("extra"), "the server's change was kept");
    s.edit_save(WINDOW, &opened.edit_id, true).await.unwrap();
    client.text.clear();
    client.send(&format!("cat ~/{name}; echo C5-$((40+2))\n")).await;
    client.output_until("C5-42").await;
    assert!(client.text.contains("port=3") && !client.text.contains("extra"), "{:?}", client.text);

    // A same-size change that keeps the modification time is caught by content alone.
    client
        .send(&format!(
            "cp -p ~/{name} ~/{name}.ref && printf 'port=8\\n' > ~/{name} && touch -r ~/{name}.ref ~/{name} && rm ~/{name}.ref && echo C6-$((40+2))\n"
        ))
        .await;
    client.output_until("C6-42").await;
    std::fs::write(&local, "port=7\n").unwrap();
    assert_eq!(s.edit_save(WINDOW, &opened.edit_id, false).await.unwrap_err().code, ErrorCode::Conflict);

    // Closing removes the local copy.
    s.edit_close(WINDOW, &opened.edit_id).await.unwrap();
    assert!(!local.exists() && !local.parent().unwrap().exists());
    assert_eq!(s.edit_status(WINDOW, &opened.edit_id).await.unwrap_err().code, ErrorCode::AccessDenied);

    // Ending the session removes copies still open.
    let (local, _) = s.edit_open(WINDOW, &id, &home, &name, root.path()).await.unwrap();
    assert!(local.exists());
    client.send(&format!("rm -f ~/{name}; exit\n")).await;
    client.until_closed().await;
    assert!(!local.parent().unwrap().exists(), "the session's edit copies are gone");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn keep_both_uses_the_next_free_name_and_never_touches_the_existing_file() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let id = client.session.clone();
    let s = &f.core.sessions;
    let home = s.list_files(WINDOW, &id, None).await.unwrap().path;
    let dir_name = format!("tyr-keep-{}", std::process::id());
    s.make_dir(WINDOW, &id, &home, &dir_name).await.unwrap();
    let dir = format!("{}/{dir_name}", home.trim_end_matches('/'));
    let local = TempDir::new().unwrap();
    std::fs::write(local.path().join("notes.txt"), b"first\n").unwrap();
    let (sink, mut rx) = transfer_sink();
    s.upload(WINDOW, &id, local.path().join("notes.txt"), &dir, "notes.txt", ConflictChoice::Ask, sink).await.unwrap();
    transfer_end(&mut rx).await;

    std::fs::write(local.path().join("notes.txt"), b"second\n").unwrap();
    for expected in ["notes (1).txt", "notes (2).txt"] {
        let (sink, mut rx) = transfer_sink();
        let started = s
            .upload(WINDOW, &id, local.path().join("notes.txt"), &dir, "notes.txt", ConflictChoice::KeepBoth, sink)
            .await
            .unwrap();
        assert_eq!(started.name, expected);
        assert_eq!(transfer_end(&mut rx).await, done(7));
    }
    let names: Vec<_> =
        s.list_files(WINDOW, &id, Some(&dir)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["notes (1).txt", "notes (2).txt", "notes.txt"]);

    // Downloading next to an existing local file keeps both as well.
    let down = TempDir::new().unwrap();
    std::fs::write(down.path().join("notes.txt"), b"local\n").unwrap();
    let (sink, mut rx) = transfer_sink();
    let started = s
        .download(WINDOW, &id, &dir, "notes.txt", down.path().to_path_buf(), ConflictChoice::KeepBoth, sink)
        .await
        .unwrap();
    assert_eq!(started.name, "notes (1).txt");
    assert_eq!(transfer_end(&mut rx).await, done(6));
    assert_eq!(std::fs::read(down.path().join("notes.txt")).unwrap(), b"local\n");
    assert_eq!(std::fs::read(down.path().join("notes (1).txt")).unwrap(), b"first\n");

    for name in ["notes.txt", "notes (1).txt", "notes (2).txt"] {
        s.remove_file(WINDOW, &id, &dir, name).await.unwrap();
    }
    s.remove_file(WINDOW, &id, &home, &dir_name).await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_local_terminal_runs_the_chosen_installed_shell_and_ignores_anything_else() {
    let f = fixture().await;
    let shells = tyrminal_core::available_shells();
    let Some(sh) = shells.iter().find(|p| p.file_name().is_some_and(|n| n == "sh")) else {
        panic!("BLOCKED: no `sh` in /etc/shells on this machine: {shells:?}");
    };
    let (tx, inbox) = mpsc::unbounded_channel();
    let opened = f
        .core
        .sessions
        .open_local_with(WINDOW, 100, 30, Some(sh.to_string_lossy().into_owned()), Arc::new(ChannelSink(tx)))
        .await
        .unwrap();
    let mut client = Client {
        core: f.core.clone(),
        session: opened.session_id,
        inbox,
        text: String::new(),
        received: 0,
        auto_ack: true,
        negotiated: None,
        window: WINDOW,
    };
    client.until_connected().await;
    client.send("echo \"SHELL-[$0]\"\n").await;
    client.output_until("SHELL-[").await;
    client.output_until("sh]").await;

    // A path that is not an installed shell is never executed; the login shell runs instead.
    let fake = f._dir.path().join("not-a-shell");
    std::fs::write(&fake, "#!/bin/sh\necho PWNED\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (tx, inbox) = mpsc::unbounded_channel();
    let opened = f
        .core
        .sessions
        .open_local_with(WINDOW, 100, 30, Some(fake.to_string_lossy().into_owned()), Arc::new(ChannelSink(tx)))
        .await
        .unwrap();
    let mut client = Client {
        core: f.core.clone(),
        session: opened.session_id,
        inbox,
        text: String::new(),
        received: 0,
        auto_ack: true,
        negotiated: None,
        window: WINDOW,
    };
    client.until_connected().await;
    client.send("echo LOGIN-$((40+2))\n").await;
    client.output_until("LOGIN-42").await;
    assert!(!client.text.contains("PWNED"));
}

/// Connects to a lab server with an already imported key, accepting its host key once.
async fn connected(f: &Fixture, server: &str, key_id: &str) -> Client {
    let host = f
        .host(
            &format!("lab {server}"),
            f.lab.port(server),
            &f.lab.str("/user"),
            HostAuthInput::Key { key_id: key_id.into() },
        )
        .await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    client
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn copying_between_two_servers_streams_files_and_folders_without_partial_results() {
    let _b = SERVER_B.lock().await;
    let f = fixture().await;
    let key_id = f.import("ed25519", None, false).await;
    let mut a = connected(&f, "a", &key_id).await;
    let b = connected(&f, "b", &key_id).await;
    let s = &f.core.sessions;
    let a_home = s.list_files(WINDOW, &a.session, None).await.unwrap().path;
    let b_home = s.list_files(WINDOW, &b.session, None).await.unwrap().path;
    let tag = std::process::id();
    let (src_dir_name, dst_dir_name) = (format!("tyr-copy-src-{tag}"), format!("tyr-copy-dst-{tag}"));
    s.make_dir(WINDOW, &a.session, &a_home, &src_dir_name).await.unwrap();
    s.make_dir(WINDOW, &b.session, &b_home, &dst_dir_name).await.unwrap();
    let src = format!("{}/{src_dir_name}", a_home.trim_end_matches('/'));
    let dst = format!("{}/{dst_dir_name}", b_home.trim_end_matches('/'));

    // Put a file and a small tree on server A.
    let local = TempDir::new().unwrap();
    let data = pattern(5 * 1024 * 1024 + 3, 21);
    std::fs::write(local.path().join("data.bin"), &data).unwrap();
    std::fs::create_dir_all(local.path().join("tree/inner")).unwrap();
    std::fs::write(local.path().join("tree/inner/x.txt"), b"x\n").unwrap();
    for name in ["data.bin", "tree"] {
        let (sink, mut rx) = transfer_sink();
        s.upload(WINDOW, &a.session, local.path().join(name), &src, name, ConflictChoice::Ask, sink).await.unwrap();
        assert!(matches!(transfer_end(&mut rx).await, TransferEvent::Done { .. }));
    }

    // A link inside the tree on server A (never followed or copied).
    a.send(&format!("ln -s /etc/hostname {src}/tree/link && echo LN-$((40+2))\n")).await;
    a.output_until("LN-42").await;

    // Another window cannot use either session.
    let (sink, _rx) = transfer_sink();
    let denied =
        s.copy_between("other-window", &a.session, &src, "data.bin", &b.session, &dst, ConflictChoice::Ask, sink);
    assert_eq!(denied.await.unwrap_err().code, ErrorCode::AccessDenied);

    // A file, byte for byte (read back through B into a local folder).
    let (sink, mut rx) = transfer_sink();
    let started = s
        .copy_between(WINDOW, &a.session, &src, "data.bin", &b.session, &dst, ConflictChoice::Ask, sink)
        .await
        .unwrap();
    assert_eq!(started.direction, tyrminal_core::contracts::TransferDirection::Copy);
    assert_eq!(transfer_end(&mut rx).await, done(data.len() as u64));
    let back = TempDir::new().unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, &b.session, &dst, "data.bin", back.path().to_path_buf(), ConflictChoice::Ask, sink)
        .await
        .unwrap();
    transfer_end(&mut rx).await;
    assert!(std::fs::read(back.path().join("data.bin")).unwrap() == data);

    // The same name again: conflict, then keep both.
    let (sink, _rx) = transfer_sink();
    let again = s.copy_between(WINDOW, &a.session, &src, "data.bin", &b.session, &dst, ConflictChoice::Ask, sink).await;
    assert_eq!(again.unwrap_err().code, ErrorCode::Conflict);
    let (sink, mut rx) = transfer_sink();
    let both = s
        .copy_between(WINDOW, &a.session, &src, "data.bin", &b.session, &dst, ConflictChoice::KeepBoth, sink)
        .await
        .unwrap();
    assert_eq!(both.name, "data (1).bin");
    transfer_end(&mut rx).await;

    // A folder: the tree arrives, the link is skipped and counted.
    let (sink, mut rx) = transfer_sink();
    s.copy_between(WINDOW, &a.session, &src, "tree", &b.session, &dst, ConflictChoice::Ask, sink).await.unwrap();
    assert_eq!(transfer_end(&mut rx).await, TransferEvent::Done { bytes: 2, files: 1, skipped: 1 });
    let inner = s.list_files(WINDOW, &b.session, Some(&format!("{dst}/tree/inner"))).await.unwrap();
    assert_eq!(inner.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["x.txt"]);
    let mut names: Vec<_> =
        s.list_files(WINDOW, &b.session, Some(&dst)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    names.sort();
    assert_eq!(names, ["data (1).bin", "data.bin", "tree"], "no temporary names are left");

    // Cancelled: nothing appears on B.
    let big = pattern(64 * 1024 * 1024, 5);
    std::fs::write(local.path().join("big.bin"), &big).unwrap();
    let (sink, mut rx) = transfer_sink();
    s.upload(WINDOW, &a.session, local.path().join("big.bin"), &src, "big.bin", ConflictChoice::Ask, sink)
        .await
        .unwrap();
    transfer_end(&mut rx).await;
    let (sink, mut rx) = transfer_sink();
    let started =
        s.copy_between(WINDOW, &a.session, &src, "big.bin", &b.session, &dst, ConflictChoice::Ask, sink).await.unwrap();
    s.cancel_transfer(WINDOW, &started.transfer_id).unwrap();
    assert_eq!(transfer_end(&mut rx).await, TransferEvent::Cancelled);
    let mut after: Vec<_> =
        s.list_files(WINDOW, &b.session, Some(&dst)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    after.sort();
    assert_eq!(after, names);

    // Clean up both servers.
    for (session, dir, base, name) in
        [(&a.session, &src, &a_home, &src_dir_name), (&b.session, &dst, &b_home, &dst_dir_name)]
    {
        let entries = s.list_files(WINDOW, session, Some(dir)).await.unwrap().entries;
        for e in entries {
            if e.kind == tyrminal_core::contracts::RemoteEntryKind::Dir {
                let _ = s.remove_file(WINDOW, session, &format!("{dir}/{}/inner", e.name), "x.txt").await;
                let _ = s.remove_file(WINDOW, session, &format!("{dir}/{}", e.name), "inner").await;
                let _ = s.remove_file(WINDOW, session, &format!("{dir}/{}", e.name), "link").await;
            }
            let _ = s.remove_file(WINDOW, session, dir, &e.name).await;
        }
        s.remove_file(WINDOW, session, base, name).await.unwrap();
    }
}

/// A stand-in for another window that has just accepted a session.
fn attached(f: &Fixture, window: &'static str, session: String, inbox: mpsc::UnboundedReceiver<Message>) -> Client {
    Client {
        core: f.core.clone(),
        session,
        inbox,
        text: String::new(),
        received: 0,
        auto_ack: true,
        negotiated: None,
        window,
    }
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_session_moves_to_another_window_and_only_that_window_can_use_it() {
    const NEW: &str = "detached-1";
    const THIRD: &str = "detached-2";
    let f = fixture().await;
    let s = &f.core.sessions;
    let mut old = Client::open_local(&f.core).await;
    old.until_connected().await;
    old.send("echo BEFORE-$((1+1))\n").await;
    old.output_until("BEFORE-2").await;
    let id = old.session.clone();

    // Only the owner may offer, only to another window, one offer at a time.
    assert!(s.offer_handoff(THIRD, &id, NEW).is_err());
    assert!(s.offer_handoff(WINDOW, &id, WINDOW).is_err());
    let token = s.offer_handoff(WINDOW, &id, NEW).unwrap();
    assert!(s.offer_handoff(WINDOW, &id, THIRD).is_err());

    // Until it is accepted the owner keeps the session; its output is held for the new window.
    old.send("echo HELD-$((2+2))\n").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // A third window cannot take it (and does not use up the token).
    let (tx3, _inbox3) = mpsc::unbounded_channel();
    assert_eq!(s.accept_handoff(THIRD, &token, Arc::new(ChannelSink(tx3))).unwrap_err().code, ErrorCode::AccessDenied);

    let (tx, inbox) = mpsc::unbounded_channel();
    assert_eq!(s.accept_handoff(NEW, &token, Arc::new(ChannelSink(tx))).unwrap(), id);
    let mut new = attached(&f, NEW, id.clone(), inbox);
    new.output_until("HELD-4").await;
    // Nothing produced after the offer reached the old window.
    while let Ok(message) = old.inbox.try_recv() {
        if let Message::Output(bytes) = message {
            assert!(!String::from_utf8_lossy(&bytes).contains("HELD"), "held output leaked to the old window");
        }
    }

    // The token is single-use.
    let (tx, _inbox) = mpsc::unbounded_channel();
    assert!(s.accept_handoff(NEW, &token, Arc::new(ChannelSink(tx))).is_err());

    // The old window is denied everything from now on.
    let denied =
        |r: Result<(), tyrminal_core::contracts::IpcError>| assert_eq!(r.unwrap_err().code, ErrorCode::AccessDenied);
    denied(s.write(WINDOW, &id, b"echo NO\r".to_vec()).await);
    denied(s.resize(WINDOW, &id, 80, 24).await);
    denied(s.ack(WINDOW, &id, 1).await);
    denied(s.close(WINDOW, &id));
    assert!(s.offer_handoff(WINDOW, &id, THIRD).is_err());

    // The new window uses it, and closing the old window ends nothing it no longer owns.
    new.send("echo AFTER-$((3+3))\n").await;
    new.output_until("AFTER-6").await;
    s.close_all_for_owner(WINDOW);
    new.send("echo STILL-$((4+4))\n").await;
    new.output_until("STILL-8").await;

    // An offer that is not accepted in time lapses: the token is refused and what was held
    // goes to the owner after all.
    let late = s.offer_handoff_within(NEW, &id, THIRD, Duration::from_millis(300)).unwrap();
    new.send("echo LAPSED-$((5+5))\n").await;
    new.output_until("LAPSED-10").await;
    let (tx, _inbox) = mpsc::unbounded_channel();
    assert!(s.accept_handoff(THIRD, &late, Arc::new(ChannelSink(tx))).is_err());

    // An offer whose target window closes lapses at once.
    let _gone = s.offer_handoff(NEW, &id, THIRD).unwrap();
    new.send("echo CLOSED-$((6+6))\n").await;
    s.close_all_for_owner(THIRD);
    new.output_until("CLOSED-12").await;

    // Closing the window that now owns it ends the session.
    s.close_all_for_owner(NEW);
    new.until_closed().await;
    assert_eq!(s.count(), 0);
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_dropped_file_streams_in_order_and_only_a_complete_upload_appears() {
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let id = client.session.clone();
    let s = &f.core.sessions;
    let home = s.list_files(WINDOW, &id, None).await.unwrap().path;
    let dir_name = format!("tyr-drop-{}", std::process::id());
    s.make_dir(WINDOW, &id, &home, &dir_name).await.unwrap();
    let dir = format!("{}/{dir_name}", home.trim_end_matches('/'));
    let names = || async {
        s.list_files(WINDOW, &id, Some(&dir)).await.unwrap().entries.into_iter().map(|e| e.name).collect::<Vec<_>>()
    };

    // A 5 MiB file in pieces arrives byte for byte under its own name.
    let data = pattern(5 * 1024 * 1024 + 123, 7);
    let up = s.upload_begin(WINDOW, &id, &dir, "drop.bin", data.len() as u64, ConflictChoice::Ask).await.unwrap();
    assert_eq!(up.name, "drop.bin");
    let mut offset = 0u64;
    for piece in data.chunks(1024 * 1024) {
        s.upload_chunk(WINDOW, &up.upload_id, offset, piece).await.unwrap();
        offset += piece.len() as u64;
        assert!(!names().await.contains(&"drop.bin".to_owned()), "visible before it was complete");
    }
    // Another window cannot finish (or write to) someone else's upload.
    assert_eq!(s.upload_finish("other", &up.upload_id).await.unwrap_err().code, ErrorCode::AccessDenied);
    assert_eq!(s.upload_finish(WINDOW, &up.upload_id).await.unwrap(), "drop.bin");
    let back = TempDir::new().unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, &id, &dir, "drop.bin", back.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    transfer_end(&mut rx).await;
    assert_eq!(std::fs::read(back.path().join("drop.bin")).unwrap(), data);

    // An existing name is refused unless the user chose Replace or Keep both.
    assert_eq!(
        s.upload_begin(WINDOW, &id, &dir, "drop.bin", 3, ConflictChoice::Ask).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    let kept = s.upload_begin(WINDOW, &id, &dir, "drop.bin", 3, ConflictChoice::KeepBoth).await.unwrap();
    assert_eq!(kept.name, "drop (1).bin");
    s.upload_chunk(WINDOW, &kept.upload_id, 0, b"abc").await.unwrap();
    s.upload_finish(WINDOW, &kept.upload_id).await.unwrap();

    // Out of order, too long, too short or abandoned: stopped, and nothing is left behind.
    let gap = s.upload_begin(WINDOW, &id, &dir, "gap.txt", 6, ConflictChoice::Ask).await.unwrap();
    s.upload_chunk(WINDOW, &gap.upload_id, 0, b"abc").await.unwrap();
    assert!(s.upload_chunk(WINDOW, &gap.upload_id, 4, b"ef").await.is_err());
    assert!(s.upload_chunk(WINDOW, &gap.upload_id, 3, b"def").await.is_err(), "a stopped upload stays stopped");
    let long = s.upload_begin(WINDOW, &id, &dir, "long.txt", 2, ConflictChoice::Ask).await.unwrap();
    assert!(s.upload_chunk(WINDOW, &long.upload_id, 0, b"abc").await.is_err());
    let short = s.upload_begin(WINDOW, &id, &dir, "short.txt", 10, ConflictChoice::Ask).await.unwrap();
    s.upload_chunk(WINDOW, &short.upload_id, 0, b"abc").await.unwrap();
    assert!(s.upload_finish(WINDOW, &short.upload_id).await.is_err());
    let left = s.upload_begin(WINDOW, &id, &dir, "left.txt", 10, ConflictChoice::Ask).await.unwrap();
    s.upload_chunk(WINDOW, &left.upload_id, 0, b"abc").await.unwrap();
    s.upload_abort(WINDOW, &left.upload_id).await;
    // A window that closes takes its unfinished uploads with it.
    let orphan = s.upload_begin(WINDOW, &id, &dir, "orphan.txt", 10, ConflictChoice::Ask).await.unwrap();
    s.upload_chunk(WINDOW, &orphan.upload_id, 0, b"abc").await.unwrap();
    s.close_all_for_owner(WINDOW);
    client.until_closed().await;

    // Check what is left over a fresh session.
    let mut client = Client::open_ssh(&f.core, &host).await;
    client.until_connected().await;
    let id = client.session.clone();
    let left: Vec<_> =
        s.list_files(WINDOW, &id, Some(&dir)).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    assert_eq!(left, ["drop (1).bin", "drop.bin"], "only complete uploads remain");
    for name in ["drop (1).bin", "drop.bin"] {
        s.remove_file(WINDOW, &id, &dir, name).await.unwrap();
    }
    s.remove_file(WINDOW, &id, &home, &dir_name).await.unwrap();
}

/// Opt-in: `TYRMINAL_SMALL_FS` names an empty folder on a filesystem of at most 4 MiB (CI mounts
/// a tmpfs on Linux and a disk image on macOS).
#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn full_disk_download_fails_cleanly_and_leaves_nothing_behind() {
    // Never a silent pass: the runner reports this test BLOCKED unless it is opted in.
    let small = std::path::PathBuf::from(
        std::env::var_os("TYRMINAL_SMALL_FS").expect("set TYRMINAL_SMALL_FS to a folder on a tiny filesystem"),
    );
    let f = fixture().await;
    let host = f.key_host("a").await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let id = client.session.clone();
    let s = &f.core.sessions;
    let home = s.list_files(WINDOW, &id, None).await.unwrap().path;
    let local = TempDir::new().unwrap();
    let name = format!("tyr-full-{}.bin", std::process::id());
    std::fs::write(local.path().join(&name), pattern(8 * 1024 * 1024, 3)).unwrap();
    let (sink, mut rx) = transfer_sink();
    s.upload(WINDOW, &id, local.path().join(&name), &home, &name, ConflictChoice::Ask, sink).await.unwrap();
    transfer_end(&mut rx).await;

    // Something already there must survive the failure untouched.
    let target = TempDir::new_in(&small).unwrap();
    std::fs::write(target.path().join("keep.txt"), b"keep\n").unwrap();
    let (sink, mut rx) = transfer_sink();
    s.download(WINDOW, &id, &home, &name, target.path().to_path_buf(), ConflictChoice::Ask, sink).await.unwrap();
    match transfer_end(&mut rx).await {
        TransferEvent::Failed { error } => assert_eq!(error.code, ErrorCode::StorageFull, "{error:?}"),
        other => panic!("a download larger than the disk must fail, got {other:?}"),
    }
    let mut left: Vec<_> = std::fs::read_dir(target.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    left.sort();
    assert_eq!(left, ["keep.txt"], "no partial or temporary file is left");
    assert_eq!(std::fs::read(target.path().join("keep.txt")).unwrap(), b"keep\n");
    s.remove_file(WINDOW, &id, &home, &name).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn the_connection_log_shows_each_step_and_never_a_secret() {
    let f = fixture().await;
    let password = f.lab.str("/password");
    let host = f
        .host(
            "diag",
            f.lab.port("a"),
            &f.lab.str("/user"),
            HostAuthInput::StoredPassword { password: Some(password.clone()) },
        )
        .await;
    let mut client = Client::open_ssh(&f.core, &host).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    let lines = f.core.sessions.diagnostics(WINDOW, &client.session).unwrap();
    let text = lines.join("\n");
    for step in [
        "connecting to 127.0.0.1:",
        "directly",
        "key exchange ",
        "host key SHA256:",
        "signing in as ",
        "the stored password",
        "signed in",
        "shell opened (xterm-256color, 100x30)",
    ] {
        assert!(text.contains(step), "missing {step:?} in:\n{text}");
    }
    assert!(!text.contains(&password), "the password must never be logged");
    // Only the window that owns the session can read its log.
    assert_eq!(f.core.sessions.diagnostics("other", &client.session).unwrap_err().code, ErrorCode::AccessDenied);
    // A failed sign-in says why, still without the secret.
    let wrong = f
        .host(
            "diag-wrong",
            f.lab.port("a"),
            &f.lab.str("/user"),
            HostAuthInput::StoredPassword { password: Some("not-the-password-9".into()) },
        )
        .await;
    let mut client = Client::open_ssh(&f.core, &wrong).await;
    // A refused stored password falls back to asking; the user cancels.
    let (_, prompt) = client.until_not_state().await;
    let (prompt_id, _, _) = auth_prompt(&prompt);
    client.answer(&prompt_id, None);
    let (error, _) = client.until_closed().await;
    assert!(error.is_some());
    let text = f.core.sessions.diagnostics(WINDOW, &client.session).unwrap().join("\n");
    assert!(text.contains("refused the stored password"), "{text}");
    assert!(text.contains("sign-in failed: "), "{text}");
    assert!(text.contains("ended: "), "{text}");
    assert!(!text.contains("not-the-password-9"));
    assert!(f.core.sessions.diagnostics("other", &client.session).is_err());
}

/// Reads output until `needle`, collecting (not failing on) events such as notices.
async fn output_with_events(client: &mut Client, needle: &str) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !strip_escapes(&client.text).contains(needle) {
        match tokio::time::timeout_at(deadline, client.inbox.recv()).await {
            Ok(Some(Message::Output(bytes))) => client.absorb(bytes).await,
            Ok(Some(Message::Event(event))) => events.push(event),
            Ok(None) => panic!("closed while waiting for {needle:?}"),
            Err(_) => panic!("timed out waiting for {needle:?}; got {:?}", client.text),
        }
    }
    events
}

#[tokio::test]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn agent_forwarding_is_off_by_default_and_offers_only_the_host_key_when_on() {
    // The hop signs in to server B, whose authentication log another test asserts on.
    let _b = SERVER_B.lock().await;
    let f = fixture().await;
    let key_id = f.import("ed25519", None, false).await;
    let user = f.lab.str("/user");
    let save = |label: &str, forward_agent: bool| HostInput {
        id: None,
        label: label.into(),
        address: "127.0.0.1".into(),
        port: Some(f.lab.port("a")),
        username: user.clone(),
        auth: HostAuthInput::Key { key_id: key_id.clone() },
        group_id: None,
        tags: Vec::new(),
        protocol: HostProtocol::Ssh,
        terminal: Default::default(),
        forward_agent,
    };
    let hop = format!(
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p {} {user}@127.0.0.1 echo HOP-$((40+2))",
        f.lab.port("b")
    );

    // Off (the default): the server gets no agent at all.
    let off = f.core.vault.save_host(save("no agent", false)).await.unwrap().id;
    let mut client = Client::open_ssh(&f.core, &off).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    client.send("ssh-add -l; echo AGENT-EXIT-$?\n").await;
    client.output_until("AGENT-EXIT-2").await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // On: exactly the host's key is listed, the server can use it to reach another server, and
    // each use is reported.
    let on = f.core.vault.save_host(save("with agent", true)).await.unwrap();
    assert!(on.forward_agent);
    let mut client = Client::open_ssh(&f.core, &on.id).await;
    client.until_connected().await;
    client.send("ssh-add -l; echo LISTED-$((1+1))\n").await;
    client.output_until("LISTED-2").await;
    assert!(client.text.contains("tyrminal forwarded key"), "{}", client.text);
    assert_eq!(client.text.matches("SHA256:").count(), 1, "only one key is offered: {}", client.text);
    client.send(&format!("{hop}\n")).await;
    let events = output_with_events(&mut client, "HOP-42").await;
    assert!(
        events.iter().any(|e| matches!(e, SessionEvent::Banner { text } if text.contains("forwarded key"))),
        "the use is reported: {events:?}"
    );
    // The server cannot change what the agent holds.
    client.send("ssh-add -D; echo REMOVE-EXIT-$?\n").await;
    output_with_events(&mut client, "REMOVE-EXIT-1").await;
    let log = f.core.sessions.diagnostics(WINDOW, &client.session).unwrap().join("\n");
    assert!(log.contains("agent forwarding is on") && log.contains("used your forwarded key"), "{log}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the SSH lab (pnpm lab:up)"]
async fn a_host_created_from_a_trusted_record_connects_without_a_new_trust_prompt() {
    let f = fixture().await;
    let key_id = f.import("ed25519", None, false).await;
    let user = f.lab.str("/user");
    let first = f.host("first", f.lab.port("a"), &user, HostAuthInput::Key { key_id: key_id.clone() }).await;
    let mut client = Client::open_ssh(&f.core, &first).await;
    let (_, prompt) = client.until_not_state().await;
    client.trust(&trust_prompt_id(&prompt), TrustDecision::Always);
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;

    // What Known hosts → Create host does: a new host for the trusted record's address and port.
    let known = f.core.vault.list_known_hosts().await.unwrap();
    let record = known.iter().find(|k| k.port == f.lab.port("a")).expect("trusted record");
    let created = f.host("from known host", record.port, &user, HostAuthInput::Key { key_id }).await;
    assert_eq!(f.core.vault.list_known_hosts().await.unwrap().len(), known.len(), "creating a host adds no trust");
    let mut client = Client::open_ssh(&f.core, &created).await;
    client.until_connected().await;
    f.core.sessions.close(WINDOW, &client.session).unwrap();
    client.until_closed().await;
}

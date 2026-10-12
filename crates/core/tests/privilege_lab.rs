//! Privilege-prompt assistance against the real OpenSSH lab (KEY-18): an identity's password is
//! typed into a real shell only on an explicit request, without Enter, and never because the
//! server printed something that looks like a prompt.
//!
//! Run with `pnpm lab:up && cargo test -p tyrminal-core --test privilege_lab -- --ignored`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tyrminal_core::contracts::{
    ErrorCode, HostAuthInput, HostInput, IdentityInput, SecretChange, SessionEvent, SessionState, SettingsTarget,
    TrustDecision,
};
use tyrminal_core::{Core, SessionSink};

const PASSPHRASE: &str = "correct horse battery staple";
const WINDOW: &str = "main";
const WAIT: Duration = Duration::from_secs(20);

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
        u16::try_from(self.0.pointer(&format!("/servers/{server}/port")).and_then(Value::as_u64).unwrap()).unwrap()
    }
}

enum Message {
    Output(Vec<u8>),
    Event(SessionEvent),
}

struct Sink(mpsc::UnboundedSender<Message>);

impl SessionSink for Sink {
    fn output(&self, data: Vec<u8>) -> bool {
        self.0.send(Message::Output(data)).is_ok()
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.0.send(Message::Event(event)).is_ok()
    }
}

/// Plays the renderer for one session: collects output, acknowledges it, answers trust.
struct Client {
    core: Core,
    session: String,
    inbox: mpsc::UnboundedReceiver<Message>,
    text: String,
}

impl Client {
    async fn open(core: &Core, host_id: &str) -> Self {
        let (tx, inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_ssh(WINDOW, host_id, 100, 30, Arc::new(Sink(tx))).await.expect("open");
        Self { core: core.clone(), session: opened.session_id, inbox, text: String::new() }
    }

    async fn absorb(&mut self, bytes: Vec<u8>) {
        self.text.push_str(&String::from_utf8_lossy(&bytes));
        let _ = self.core.sessions.ack(WINDOW, &self.session, bytes.len() as u32).await;
    }

    /// Trusts the host key once and waits for the shell. Any authentication prompt fails the
    /// test: the identity must have supplied the credential.
    async fn connect(&mut self) {
        loop {
            match tokio::time::timeout(WAIT, self.inbox.recv()).await.expect("timed out connecting").expect("closed") {
                Message::Output(bytes) => self.absorb(bytes).await,
                Message::Event(SessionEvent::TrustPrompt { prompt_id, .. }) => {
                    self.core.sessions.answer_trust(WINDOW, &self.session, &prompt_id, TrustDecision::Once).unwrap();
                }
                Message::Event(SessionEvent::State { state: SessionState::Connected, hop: None }) => return,
                Message::Event(event @ (SessionEvent::AuthPrompt { .. } | SessionEvent::Closed { .. })) => {
                    panic!("the identity did not sign in: {event:?}")
                }
                Message::Event(_) => {}
            }
        }
    }

    async fn output_until(&mut self, needle: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !self.text.contains(needle) {
            match tokio::time::timeout_at(deadline, self.inbox.recv()).await {
                Ok(Some(Message::Output(bytes))) => self.absorb(bytes).await,
                Ok(Some(Message::Event(_))) => {}
                Ok(None) => panic!("closed while waiting for {needle:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; got {:?}", self.text),
            }
        }
    }

    async fn send(&self, text: &str) {
        self.core.sessions.write(WINDOW, &self.session, text.replace('\n', "\r").into_bytes()).await.expect("write");
    }
}

async fn unlocked(dir: &TempDir) -> Core {
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    core
}

fn short_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn identity(label: &str, username: &str, password: &str) -> IdentityInput {
    IdentityInput {
        id: None,
        label: label.into(),
        username: username.into(),
        password: SecretChange::Set { value: password.into() },
        key_id: None,
    }
}

#[tokio::test]
#[ignore = "needs the SSH lab (pnpm lab:up)"]
async fn an_identity_password_reaches_a_real_prompt_only_when_asked() {
    let lab = Lab::load();
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let password = lab.str("/password");
    let user = lab.str("/user");
    let ops = v.save_identity(identity("lab user", &user, &password)).await.unwrap();
    let other = v.save_identity(identity("other", "other", "other-synthetic")).await.unwrap();
    // The identity is assigned to the host (as from its menu) and signs it in with its password.
    let h = v
        .save_host(HostInput {
            id: None,
            label: "lab a".into(),
            address: "127.0.0.1".into(),
            port: Some(lab.port("a")),
            username: user.clone(),
            auth: HostAuthInput::Inherit,
            group_id: None,
            tags: Vec::new(),
            protocol: tyrminal_core::contracts::HostProtocol::Ssh,
            terminal: Default::default(),
            forward_agent: false,
            production: false,
        })
        .await
        .unwrap();
    v.set_identity(SettingsTarget::Host { host_id: h.id.clone() }, Some(ops.id.clone())).await.unwrap();
    let mut c = Client::open(&core, &h.id).await;
    c.connect().await;

    let shown = core.sessions.session_identity(WINDOW, &c.session).await.unwrap().unwrap();
    assert_eq!(
        (shown.identity_id.as_str(), shown.label.as_str(), shown.has_password),
        (ops.id.as_str(), "lab user", true)
    );

    // A server-printed "sudo prompt" gets nothing on its own: after two seconds the terminal
    // input holds no bytes. (POSIX sh: the lab's login shell may be dash. The markers are split
    // in the command so its echo never matches. Some terminals, such as WSL's, block a read with
    // MIN 0 TIME 0, so a watchdog ends the read after two seconds; it then counts what it got.)
    c.send(concat!(
        "printf '[sudo] password for %s: ' \"$(id -un)\"; sleep 2; ",
        "stty -echo -icanon min 0 time 0; ",
        "n=$( (dd bs=256 count=1 </dev/tty 2>/dev/null & d=$!; (sleep 2; kill $d) >/dev/null 2>&1 & wait $d) | wc -c); stty sane; ",
        "echo \"SPO\"\"OF:$((n))\"\n"
    ))
    .await;
    c.output_until("SPOOF:0").await;
    // Control: the same check does count bytes that arrive while the fake prompt is shown.
    c.send(concat!(
        "printf 'again: '; sleep 2; ",
        "stty -echo -icanon min 0 time 0; ",
        "n=$( (dd bs=256 count=1 </dev/tty 2>/dev/null & d=$!; (sleep 2; kill $d) >/dev/null 2>&1 & wait $d) | wc -c); stty sane; ",
        "echo \"CONT\"\"ROL:$((n))\"\n"
    ))
    .await;
    c.output_until("again: ").await;
    c.send("xyz").await;
    c.output_until("CONTROL:3").await;

    // Another identity than the host's is refused, and so is another window.
    let wrong = core.sessions.insert_identity_password(WINDOW, &c.session, &other.id).await.unwrap_err();
    assert_eq!(wrong.code, ErrorCode::Conflict);
    let foreign = core.sessions.insert_identity_password("other-window", &c.session, &ops.id).await.unwrap_err();
    assert_eq!(foreign.code, ErrorCode::AccessDenied);

    // A real no-echo prompt (like sudo's): the explicit insert types the password, without
    // Enter; the user's Enter submits it. The shell prints only a hash of what it read.
    c.send(concat!(
        "stty -echo; read typed; stty echo; ",
        "printf 'G%sT:%s\\n' O \"$(printf '%s' \"$typed\" | sha256sum | cut -c1-16)\"\n"
    ))
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    core.sessions.insert_identity_password(WINDOW, &c.session, &ops.id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!c.text.contains("GOT:"), "nothing is submitted until the user presses Enter");
    c.send("\n").await;
    c.output_until(&format!("GOT:{}", short_hash(&password))).await;
    assert!(!c.text.contains(&password), "the password was typed into a no-echo prompt and never shown");

    core.sessions.close(WINDOW, &c.session).unwrap();
}

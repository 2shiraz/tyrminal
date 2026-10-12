//! P-33 with a real container engine: shells in a running container on the lab host, and that
//! nothing they started keeps running once the shell's tab closes, its SSH session closes or the
//! vault locks.
//!
//! Needs the SSH lab and Docker or Podman usable by the lab user, with the `alpine:3.22` image
//! present (the lab images provide neither). `pnpm test:integration` runs it only when
//! `TYRMINAL_LAB_CONTAINERS=1` says so, and otherwise reports it BLOCKED:
//!
//!   pnpm lab:up && TYRMINAL_LAB_CONTAINERS=1 cargo test -p tyrminal-core --test containers_lab -- --ignored

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tyrminal_core::contracts::{
    ContainerEngine, ErrorCode, HostAuthInput, HostInput, HostProtocol, KeyImportInput, SessionEvent, SessionState,
    SnippetInput, TrustDecision,
};
use tyrminal_core::{Core, SessionSink};

const PASSPHRASE: &str = "correct horse battery staple";
const WINDOW: &str = "main";
const WAIT: Duration = Duration::from_secs(30);

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

/// Everything a session sends: terminal output and events.
struct Captured {
    output: mpsc::UnboundedSender<Vec<u8>>,
    events: mpsc::UnboundedSender<SessionEvent>,
}

impl SessionSink for Captured {
    fn output(&self, data: Vec<u8>) -> bool {
        self.output.send(data).is_ok()
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.events.send(event).is_ok()
    }
}

struct Fixture {
    core: Core,
    host_id: String,
    _dir: TempDir,
}

async fn fixture() -> Fixture {
    let lab = Lab::load();
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let key = core
        .vault
        .import_key(KeyImportInput {
            label: "lab".into(),
            private_key: std::fs::read_to_string(lab.str("/keys/ed25519")).unwrap(),
            passphrase: None,
            remember_passphrase: false,
        })
        .await
        .unwrap();
    let host = core
        .vault
        .save_host(HostInput {
            id: None,
            label: "lab a".into(),
            address: "127.0.0.1".into(),
            port: Some(lab.port("a")),
            username: lab.str("/user"),
            auth: HostAuthInput::Key { key_id: key.id },
            group_id: None,
            tags: Vec::new(),
            protocol: HostProtocol::Ssh,
            terminal: Default::default(),
            forward_agent: false,
            production: false,
        })
        .await
        .unwrap();
    Fixture { core, host_id: host.id, _dir: dir }
}

/// An SSH session to the lab, connected (its host key trusted once).
async fn connected(core: &Core, host_id: &str) -> String {
    let (output, mut drained) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move { while drained.recv().await.is_some() {} });
    let (events, mut inbox) = mpsc::unbounded_channel();
    let opened = core.sessions.open_ssh(WINDOW, host_id, 80, 24, Arc::new(Captured { output, events })).await.unwrap();
    let session = opened.session_id.clone();
    let inner = core.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut ready = Some(ready_tx);
        while let Some(event) = inbox.recv().await {
            match event {
                SessionEvent::TrustPrompt { prompt_id, .. } => {
                    inner.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Once).unwrap();
                }
                SessionEvent::State { state: SessionState::Connected, .. } => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(());
                    }
                }
                _ => {}
            }
        }
    });
    tokio::time::timeout(WAIT, ready_rx).await.expect("connect timed out").unwrap();
    opened.session_id
}

/// Runs `text` on an exec channel of `session` (as a saved snippet) and returns its output.
async fn run(core: &Core, session: &str, text: &str) -> String {
    let snippet = core
        .vault
        .save_snippet(SnippetInput { id: None, name: "lab".into(), folder: String::new(), text: text.into() })
        .await
        .unwrap();
    let out = core.sessions.exec_snippet(WINDOW, session, &snippet.id, "lab-run").await.unwrap();
    core.vault.delete_snippet(&snippet.id).await.unwrap();
    assert_eq!(out.exit_status, Some(0), "{text}: {}", out.stderr);
    out.stdout
}

/// A container shell's session, with its output and events.
struct Shell {
    id: String,
    output: mpsc::UnboundedReceiver<Vec<u8>>,
    events: mpsc::UnboundedReceiver<SessionEvent>,
    seen: String,
}

impl Shell {
    async fn open(core: &Core, session: &str, engine: ContainerEngine, container: &str) -> Self {
        let (output, output_rx) = mpsc::unbounded_channel();
        let (events, events_rx) = mpsc::unbounded_channel();
        let opened = core
            .sessions
            .open_container_shell(WINDOW, session, engine, container, 100, 30, Arc::new(Captured { output, events }))
            .await
            .unwrap();
        let mut shell = Self { id: opened.session_id, output: output_rx, events: events_rx, seen: String::new() };
        loop {
            match tokio::time::timeout(WAIT, shell.events.recv()).await.expect("timed out").expect("events ended") {
                SessionEvent::State { state: SessionState::Connected, .. } => break,
                SessionEvent::Closed { error, exit_status } => panic!("shell ended: {error:?} {exit_status:?}"),
                _ => {}
            }
        }
        shell
    }

    async fn until_output(&mut self, needle: &str) {
        let wait = async {
            while !self.seen.contains(needle) {
                let chunk = self.output.recv().await.expect("output ended");
                self.seen.push_str(&String::from_utf8_lossy(&chunk));
            }
        };
        tokio::time::timeout(WAIT, wait).await.unwrap_or_else(|_| panic!("no {needle:?} in {:?}", self.seen));
    }

    async fn until_closed(&mut self) -> Option<ErrorCode> {
        loop {
            let event = tokio::time::timeout(WAIT, self.events.recv()).await.expect("timed out").expect("events ended");
            if let SessionEvent::Closed { error, .. } = event {
                return error.map(|e| e.code);
            }
        }
    }
}

/// The command lines of the processes in `container`, read through a fresh session.
async fn processes(core: &Core, host_id: &str, program: &str, container: &str) -> String {
    let session = connected(core, host_id).await;
    let out = run(core, &session, &format!("{program} exec {container} ps -o args")).await;
    core.sessions.close(WINDOW, &session).unwrap();
    out
}

/// Waits until nothing a shell started is left in the container (the engine may take a moment).
async fn until_gone(core: &Core, host_id: &str, program: &str, container: &str, marker: &str) {
    let mut seen = String::new();
    for _ in 0..40 {
        seen = processes(core, host_id, program, container).await;
        if !seen.contains(marker) && !seen.contains("if command -v bash") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("still running in the container after the shell ended:\n{seen}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab and a container engine for the lab user (TYRMINAL_LAB_CONTAINERS=1)"]
async fn a_container_shell_works_and_nothing_it_started_outlives_its_tab_its_session_or_the_lock() {
    let f = fixture().await;
    let (core, host_id) = (&f.core, f.host_id.as_str());
    let session = connected(core, host_id).await;

    // A disposable container of our own, started through the lab session like a user would.
    let found = core.sessions.list_containers(WINDOW, &session).await.unwrap();
    let engine = found.engine.expect("TYRMINAL_LAB_CONTAINERS=1, but neither Docker nor Podman was found");
    assert_eq!(found.problem, None, "the lab user cannot use the engine");
    let program = match engine {
        ContainerEngine::Docker => "docker",
        ContainerEngine::Podman => "podman",
    };
    let name = format!("tyr-p33-{}", std::process::id());
    let started = run(core, &session, &format!("{program} run -d --rm --name {name} alpine:3.22 sleep 600")).await;
    let container = started.trim().to_owned();
    assert!(tyrminal_core::containers::valid_id(&container), "{container:?}");

    let list = core.sessions.list_containers(WINDOW, &session).await.unwrap();
    let ours = list.containers.iter().find(|c| c.id == container).expect("the new container is listed");
    assert_eq!((ours.name.as_str(), ours.image.as_str()), (name.as_str(), "alpine:3.22"));
    assert!(ours.status.starts_with("Up"), "{ours:?}");

    // A shell in it: commands run inside the container (Alpine has no Bash, so sh).
    let mut shell = Shell::open(core, &session, engine, &container).await;
    core.sessions
        .write(WINDOW, &shell.id, b"echo in-$((6*7)) alpine-$(cat /etc/alpine-release)\r".to_vec())
        .await
        .unwrap();
    shell.until_output("in-42 alpine-3.22").await;
    // Closing the shell's own tab: it ends, the SSH session stays, and nothing is left running.
    core.sessions.write(WINDOW, &shell.id, b"sleep 4201\r".to_vec()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(processes(core, host_id, program, &container).await.contains("sleep 4201"), "the shell's command runs");
    core.sessions.close(WINDOW, &shell.id).unwrap();
    assert_eq!(shell.until_closed().await, None);
    until_gone(core, host_id, program, &container, "sleep 4201").await;
    assert!(core.sessions.list_containers(WINDOW, &session).await.is_ok(), "the SSH session is still open");

    // Closing the SSH session ends its container shells at once.
    let mut shell = Shell::open(core, &session, engine, &container).await;
    core.sessions.write(WINDOW, &shell.id, b"sleep 4202\r".to_vec()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = std::time::Instant::now();
    core.sessions.close(WINDOW, &session).unwrap();
    assert_eq!(shell.until_closed().await, Some(ErrorCode::Disconnected));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    until_gone(core, host_id, program, &container, "sleep 4202").await;

    // Locking the vault ends them too.
    let session = connected(core, host_id).await;
    let mut shell = Shell::open(core, &session, engine, &container).await;
    core.sessions.write(WINDOW, &shell.id, b"sleep 4203\r".to_vec()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    core.vault.lock().await;
    assert_eq!(shell.until_closed().await, Some(ErrorCode::VaultLocked));
    assert_eq!(core.sessions.count(), 0);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    until_gone(core, host_id, program, &container, "sleep 4203").await;

    let session = connected(core, host_id).await;
    run(core, &session, &format!("{program} rm -f {container}")).await;
    core.sessions.close(WINDOW, &session).unwrap();
}

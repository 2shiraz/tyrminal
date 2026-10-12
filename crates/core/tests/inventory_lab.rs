//! Agent D's flows that need the real OpenSSH lab: known-host conversion (hosts created from
//! records the user trusted on a real connection).
//!
//! Run with `pnpm lab:up && cargo test -p tyrminal-core --test inventory_lab -- --ignored`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tyrminal_core::contracts::{
    ErrorCode, HostAuthInput, HostInput, KeyImportInput, SessionEvent, SessionState, SnippetInput, TrustDecision,
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

struct Events(mpsc::UnboundedSender<SessionEvent>);

impl SessionSink for Events {
    fn output(&self, _data: Vec<u8>) -> bool {
        true
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.0.send(event).is_ok()
    }
}

async fn next_prompt(inbox: &mut mpsc::UnboundedReceiver<SessionEvent>) -> SessionEvent {
    loop {
        let event = tokio::time::timeout(WAIT, inbox.recv()).await.expect("timed out").expect("closed");
        if matches!(
            event,
            SessionEvent::TrustPrompt { .. } | SessionEvent::AuthPrompt { .. } | SessionEvent::Closed { .. }
        ) {
            return event;
        }
    }
}

async fn unlocked(dir: &TempDir) -> Core {
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    core
}

fn host(label: &str, port: u16) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: "127.0.0.1".into(),
        port: Some(port),
        username: "nobody-here".into(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
    }
}

/// Connects to `host_id`, trusts the presented key permanently, then stops at the password prompt.
async fn trust_always(core: &Core, host_id: &str) {
    let (tx, mut inbox) = mpsc::unbounded_channel();
    let opened = core.sessions.open_ssh(WINDOW, host_id, 80, 24, Arc::new(Events(tx))).await.unwrap();
    let SessionEvent::TrustPrompt { prompt_id, .. } = next_prompt(&mut inbox).await else {
        panic!("expected a trust prompt")
    };
    core.sessions.answer_trust(WINDOW, &opened.session_id, &prompt_id, TrustDecision::Always).unwrap();
    assert!(matches!(next_prompt(&mut inbox).await, SessionEvent::AuthPrompt { .. }));
    core.sessions.close(WINDOW, &opened.session_id).unwrap();
}

#[tokio::test]
#[ignore = "needs the SSH lab (pnpm lab:up)"]
async fn known_hosts_trusted_on_real_connections_become_hosts_after_a_preview() {
    let lab = Lab::load();
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let (port_a, port_b) = (lab.port("a"), lab.port("b"));

    let a = v.save_host(host("lab a", port_a)).await.unwrap();
    let b = v.save_host(host("lab b", port_b)).await.unwrap();
    // Trust once does not create a record, so it is never offered.
    let once = v.save_host(host("lab kbd", lab.port("kbd"))).await.unwrap();
    trust_always(&core, &a.id).await;
    trust_always(&core, &b.id).await;
    {
        let (tx, mut inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_ssh(WINDOW, &once.id, 80, 24, Arc::new(Events(tx))).await.unwrap();
        let SessionEvent::TrustPrompt { prompt_id, .. } = next_prompt(&mut inbox).await else { panic!() };
        core.sessions.answer_trust(WINDOW, &opened.session_id, &prompt_id, TrustDecision::Once).unwrap();
        let _ = next_prompt(&mut inbox).await;
        core.sessions.close(WINDOW, &opened.session_id).unwrap();
    }
    assert_eq!(v.list_known_hosts().await.unwrap().len(), 2);

    // Both trusted records still have their host: nothing to offer.
    assert!(v.known_host_import_preview().await.unwrap().hosts.is_empty());

    // Without its host, server b's record is offered, with the trusted fingerprint shown.
    v.delete_host(&b.id).await.unwrap();
    let preview = v.known_host_import_preview().await.unwrap();
    assert_eq!(preview.hosts.len(), 1, "{preview:?}");
    let offered = &preview.hosts[0];
    assert_eq!((offered.address.as_str(), offered.port), ("127.0.0.1", port_b));
    assert_eq!(offered.label, format!("127.0.0.1:{port_b}"));
    let fingerprint = lab.str("/servers/b/hostKeyEd25519Fingerprint");
    assert!(offered.notes.iter().any(|n| n.contains(&fingerprint)), "{:?}", offered.notes);
    // Previewing wrote nothing.
    assert_eq!(v.list_hosts().await.unwrap().len(), 2);

    assert_eq!(v.import_hosts(preview.hosts, None).await.unwrap(), 1);
    let created = v.list_hosts().await.unwrap().into_iter().find(|h| h.port == port_b).expect("created");
    assert_eq!(created.address, "127.0.0.1");
    assert_eq!(created.username, "", "imported hosts ask for the user name to be set");
    let created = v
        .save_host(HostInput { id: Some(created.id.clone()), label: created.label.clone(), ..host("", port_b) })
        .await
        .unwrap();

    // The new host connects without a trust prompt: its key is already trusted.
    let (tx, mut inbox) = mpsc::unbounded_channel();
    let opened = core.sessions.open_ssh(WINDOW, &created.id, 80, 24, Arc::new(Events(tx))).await.unwrap();
    assert!(matches!(next_prompt(&mut inbox).await, SessionEvent::AuthPrompt { .. }), "no trust prompt expected");
    core.sessions.close(WINDOW, &opened.session_id).unwrap();
    assert!(v.known_host_import_preview().await.unwrap().hosts.is_empty());
}

/// (major, minor) from "OpenSSH_9.6p1 Ubuntu-3", "OpenSSH 10.0p1 (Alpine …)" or "OpenSSH_for_Windows_9.5p1".
fn openssh_version(text: &str) -> (u32, u32) {
    let start = text.find(|c: char| c.is_ascii_digit()).unwrap_or_else(|| panic!("no version in {text:?}"));
    let mut parts = text[start..].split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty());
    (parts.next().and_then(|p| p.parse().ok()).unwrap_or(0), parts.next().and_then(|p| p.parse().ok()).unwrap_or(0))
}

/// SEC-08: the hybrid post-quantum key exchange is used whenever the server implements it
/// (OpenSSH 9.9 and later), and otherwise the strongest classical exchange, never a weak one.
#[tokio::test]
#[ignore = "needs the SSH lab (pnpm lab:up)"]
async fn hybrid_post_quantum_key_exchange_is_negotiated_when_the_server_supports_it() {
    let lab = Lab::load();
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
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
            username: lab.str("/user"),
            auth: HostAuthInput::Key { key_id: key.id },
            ..host("lab a", lab.port("a"))
        })
        .await
        .unwrap();
    let (tx, mut inbox) = mpsc::unbounded_channel();
    let opened = core.sessions.open_ssh(WINDOW, &host.id, 80, 24, Arc::new(Events(tx))).await.unwrap();
    let mut negotiated = None;
    loop {
        match tokio::time::timeout(WAIT, inbox.recv()).await.expect("timed out").expect("closed") {
            SessionEvent::TrustPrompt { prompt_id, .. } => {
                core.sessions.answer_trust(WINDOW, &opened.session_id, &prompt_id, TrustDecision::Once).unwrap();
            }
            event @ SessionEvent::Negotiated { .. } => negotiated = Some(event),
            SessionEvent::State { state: SessionState::Connected } => break,
            SessionEvent::Closed { error, .. } => panic!("closed: {error:?}"),
            _ => {}
        }
    }
    core.sessions.close(WINDOW, &opened.session_id).unwrap();
    let Some(SessionEvent::Negotiated { kex, .. }) = negotiated else { panic!("no negotiated algorithms") };
    let version = lab.str("/serverVersion");
    if openssh_version(&version) >= (9, 9) {
        assert_eq!(kex, "mlkem768x25519-sha256", "{version} implements the hybrid exchange");
    } else {
        // The server predates ML-KEM: the client's preference falls to Curve25519, never further.
        assert_eq!(kex, "curve25519-sha256", "{version}");
    }
    let offer = tyrminal_ssh::negotiation_summary();
    assert!(offer.lines().next().unwrap().starts_with("kex=mlkem768x25519-sha256,"), "{offer}");
}

/// Opens a key-authenticated session to lab server `server` and waits until it is connected.
async fn connected_session(core: &Core, lab: &Lab, server: &str, key_id: &str) -> String {
    let host = core
        .vault
        .save_host(HostInput {
            username: lab.str("/user"),
            auth: HostAuthInput::Key { key_id: key_id.into() },
            ..host(&format!("lab {server}"), lab.port(server))
        })
        .await
        .unwrap();
    let (tx, mut inbox) = mpsc::unbounded_channel();
    let opened = core.sessions.open_ssh(WINDOW, &host.id, 80, 24, Arc::new(Events(tx))).await.unwrap();
    let session = opened.session_id.clone();
    let inner = core.clone();
    // Keep draining events in the background so the session never stalls.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut ready = Some(ready_tx);
        while let Some(event) = inbox.recv().await {
            match event {
                SessionEvent::TrustPrompt { prompt_id, .. } => {
                    inner.sessions.answer_trust(WINDOW, &session, &prompt_id, TrustDecision::Once).unwrap();
                }
                SessionEvent::State { state: SessionState::Connected } => {
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

/// SNP-05/07: one snippet on two real sessions reports each host's own outcome; a failure on one
/// does not hide the other's success. Runs belong to their window, can be cancelled, and never get
/// a terminal, so a password prompt fails instead of being answered.
#[tokio::test]
#[ignore = "needs the SSH lab (pnpm lab:up)"]
async fn snippets_run_on_several_sessions_with_per_host_results_and_cancellation() {
    let lab = Lab::load();
    let dir = TempDir::new().unwrap();
    let core = unlocked(&dir).await;
    let v = &core.vault;
    let key = v
        .import_key(KeyImportInput {
            label: "lab".into(),
            private_key: std::fs::read_to_string(lab.str("/keys/ed25519")).unwrap(),
            passphrase: None,
            remember_passphrase: false,
        })
        .await
        .unwrap();
    let a = connected_session(&core, &lab, "a", &key.id).await;
    let b = connected_session(&core, &lab, "b", &key.id).await;
    let snippet =
        |name: &str, text: &str| SnippetInput { id: None, name: name.into(), folder: String::new(), text: text.into() };

    // Succeeds on a, fails on b (a marker file decides), with stdout and stderr kept apart.
    let marker = format!("/tmp/tyrminal-snp-{}-{}", std::process::id(), key.id);
    let check = v
        .save_snippet(snippet(
            "check",
            &format!("echo out-$((40+2))\necho err >&2\nif [ -e {marker} ]; then exit 3; fi"),
        ))
        .await
        .unwrap();
    let ok = core.sessions.exec_snippet(WINDOW, &a, &check.id, "run-a").await.unwrap();
    assert_eq!((ok.exit_status, ok.stdout.as_str(), ok.stderr.as_str()), (Some(0), "out-42\n", "err\n"));
    // The marker lives on the lab machine (in WSL on Windows), so it is made there, over SSH.
    let touch = v.save_snippet(snippet("touch", &format!("touch {marker}"))).await.unwrap();
    let remove = v.save_snippet(snippet("remove", &format!("rm -f {marker}"))).await.unwrap();
    assert_eq!(core.sessions.exec_snippet(WINDOW, &b, &touch.id, "run-touch").await.unwrap().exit_status, Some(0));
    let failed = core.sessions.exec_snippet(WINDOW, &b, &check.id, "run-b").await.unwrap();
    assert_eq!(core.sessions.exec_snippet(WINDOW, &b, &remove.id, "run-rm").await.unwrap().exit_status, Some(0));
    assert_eq!(failed.exit_status, Some(3));
    assert_eq!(failed.stdout, "out-42\n");

    // Another window can neither run on these sessions nor cancel their runs.
    assert_eq!(
        core.sessions.exec_snippet("other", &a, &check.id, "run-x").await.unwrap_err().code,
        ErrorCode::AccessDenied
    );

    // A long run is cancelled promptly; the session stays usable.
    let slow = v.save_snippet(snippet("slow", "sleep 30; echo late")).await.unwrap();
    let runner = core.clone();
    let session = a.clone();
    let slow_id = slow.id.clone();
    let handle =
        tokio::spawn(async move { runner.sessions.exec_snippet(WINDOW, &session, &slow_id, "run-slow").await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    core.sessions.cancel_snippet_run("other", "run-slow");
    assert!(!handle.is_finished(), "another window cannot cancel");
    let started = std::time::Instant::now();
    core.sessions.cancel_snippet_run(WINDOW, "run-slow");
    let cancelled = tokio::time::timeout(Duration::from_secs(5), handle).await.expect("cancel is prompt").unwrap();
    assert_eq!(cancelled.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(core.sessions.exec_snippet(WINDOW, &a, &check.id, "run-again").await.unwrap().exit_status, Some(0));

    // No PTY: a command that wants a terminal for a password cannot prompt, so it fails.
    let tty = v.save_snippet(snippet("tty", "tty; test -t 0")).await.unwrap();
    let no_tty = core.sessions.exec_snippet(WINDOW, &a, &tty.id, "run-tty").await.unwrap();
    assert_ne!(no_tty.exit_status, Some(0));

    // Output beyond 64 KiB per stream is cut and flagged; control characters never reach the UI.
    let loud = v
        .save_snippet(snippet("loud", "printf '\\033[31mred\\n'; head -c 200000 /dev/zero | tr '\\0' x"))
        .await
        .unwrap();
    let cut = core.sessions.exec_snippet(WINDOW, &a, &loud.id, "run-loud").await.unwrap();
    assert!(cut.truncated);
    assert!(cut.stdout.starts_with("[31mred\n"), "{:?}", &cut.stdout[..20]);
    assert!(cut.stdout.len() <= 64 * 1024);

    // After a lock nothing runs.
    v.lock().await;
    assert!(core.sessions.exec_snippet(WINDOW, &a, &check.id, "run-locked").await.is_err());
}

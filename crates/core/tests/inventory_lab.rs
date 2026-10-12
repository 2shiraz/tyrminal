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
use tyrminal_core::contracts::{HostAuthInput, HostInput, SessionEvent, TrustDecision};
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

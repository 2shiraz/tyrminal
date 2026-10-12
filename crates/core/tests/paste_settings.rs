//! Per-host paste checks (P-25) against a real vault: a host keeps every check unless the user
//! lowers them for that host, the choice survives a fresh open, and editing the host's other
//! settings does not quietly change it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tempfile::TempDir;
use tyrminal_core::Core;
use tyrminal_core::contracts::{HostAuthInput, HostInput, HostProtocol, HostTerminal, TerminalEncoding};

const PASSPHRASE: &str = "correct horse battery staple";

fn host(label: &str, terminal: HostTerminal) -> HostInput {
    HostInput {
        id: None,
        label: label.into(),
        address: format!("{label}.example"),
        port: None,
        username: "deploy".into(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
        protocol: HostProtocol::Ssh,
        terminal,
        forward_agent: false,
        production: false,
    }
}

#[tokio::test]
async fn paste_checks_are_on_by_default_and_lowered_only_for_the_host_that_asks() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("vault.db");
    let core = Core::open(&path).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let strict = core.vault.save_host(host("prod", HostTerminal::default())).await.unwrap();
    assert!(!strict.terminal.paste_skip_multiline && !strict.terminal.paste_skip_trailing_newline);
    let lowered =
        HostTerminal { paste_skip_multiline: true, paste_skip_trailing_newline: true, ..HostTerminal::default() };
    let lab = core.vault.save_host(host("lab", lowered)).await.unwrap();
    assert_eq!(lab.terminal, lowered);

    // Editing another setting keeps what the user chose.
    let edited = HostInput {
        id: Some(lab.id.clone()),
        terminal: HostTerminal { encoding: TerminalEncoding::Koi8R, ..lowered },
        ..host("lab", lowered)
    };
    core.vault.save_host(edited).await.unwrap();

    core.vault.lock().await;
    drop(core);
    let core = Core::open(&path).unwrap();
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let hosts = core.vault.list_hosts().await.unwrap();
    let find = |id: &str| hosts.iter().find(|h| h.id == id).unwrap().terminal;
    assert_eq!(find(&strict.id), HostTerminal::default(), "a host nobody changed keeps every check");
    let lab = find(&lab.id);
    assert!(lab.paste_skip_multiline && lab.paste_skip_trailing_newline);
    assert_eq!(lab.encoding, TerminalEncoding::Koi8R);
}

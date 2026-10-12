//! Command history against real vault files and a real local shell session (AUT-01): opt-in,
//! scoped to the session's window and host, encrypted at rest, kept across a lock, and cleared
//! or deleted only on request.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use tokio::sync::mpsc;
use tyrminal_core::contracts::{ErrorCode, HistorySettings, SessionEvent, SessionState};
use tyrminal_core::{Core, SessionSink};

const PASSPHRASE: &str = "correct horse battery staple";
const WINDOW: &str = "main";

struct Sink(mpsc::UnboundedSender<SessionEvent>);
impl SessionSink for Sink {
    fn output(&self, _data: Vec<u8>) -> bool {
        true
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.0.send(event).is_ok()
    }
}

async fn local_session(core: &Core) -> String {
    let (tx, mut events) = mpsc::unbounded_channel();
    let id = core
        .sessions
        .open_local_with(WINDOW, 80, 24, Some("/bin/sh".into()), Arc::new(Sink(tx)))
        .await
        .unwrap()
        .session_id;
    let wait = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(event) = events.recv().await {
            if event == (SessionEvent::State { state: SessionState::Connected, hop: None }) {
                return;
            }
        }
    });
    wait.await.expect("the local shell started");
    id
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

fn all_bytes(dir: &Path) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(all_bytes(&path));
        } else {
            out.extend(std::fs::read(&path).unwrap());
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn history_is_opt_in_scoped_to_the_session_encrypted_and_cleared_on_request() {
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create(PASSPHRASE.into()).await.unwrap();
    let id = local_session(&core).await;
    let sessions = &core.sessions;

    // Off by default: nothing is kept or suggested.
    assert!(!core.vault.history_settings().await.unwrap().enabled);
    sessions.history_add(WINDOW, &id, "git status").await.unwrap();
    core.vault.set_history_settings(HistorySettings { enabled: true }).await.unwrap();
    assert!(sessions.history_suggest(WINDOW, &id, "git").await.unwrap().is_empty());
    assert!(core.vault.list_history().await.unwrap().is_empty());

    for line in ["git status", "git log --oneline", " export TOKEN=canary-91c2", "tail -f /var/log/syslog"] {
        sessions.history_add(WINDOW, &id, line).await.unwrap();
    }
    assert_eq!(sessions.history_suggest(WINDOW, &id, "git").await.unwrap(), ["git log --oneline", "git status"]);
    assert_eq!(
        sessions.history_suggest(WINDOW, &id, "LOG").await.unwrap(),
        ["tail -f /var/log/syslog", "git log --oneline"]
    );
    let listed = core.vault.list_history().await.unwrap();
    assert_eq!(listed.len(), 3, "a line starting with a space is not kept: {listed:?}");
    assert!(listed.iter().all(|e| e.host_id.is_none() && e.host_label.is_none()));

    // Another window can neither add to nor read this session's history.
    assert_eq!(sessions.history_suggest("other", &id, "git").await.unwrap_err().code, ErrorCode::AccessDenied);
    assert_eq!(sessions.history_add("other", &id, "rm -rf ~").await.unwrap_err().code, ErrorCode::AccessDenied);
    assert!(!core.vault.list_history().await.unwrap().iter().any(|e| e.command.contains("rm -rf")));

    // Encrypted at rest.
    let disk = all_bytes(dir.path());
    for needle in ["git log --oneline", "syslog", "canary-91c2"] {
        assert!(!contains(&disk, needle), "{needle:?} is on disk in plaintext");
    }

    // Kept across a lock; the old session is gone, a new one sees the same local history.
    core.vault.lock().await;
    assert_eq!(core.vault.list_history().await.unwrap_err().code, ErrorCode::VaultLocked);
    core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    assert_eq!(sessions.history_suggest(WINDOW, &id, "git").await.unwrap_err().code, ErrorCode::AccessDenied);
    let id = local_session(&core).await;
    assert_eq!(core.sessions.history_suggest(WINDOW, &id, "git l").await.unwrap(), ["git log --oneline"]);

    // Off: no suggestions and nothing added, but nothing deleted either.
    core.vault.set_history_settings(HistorySettings { enabled: false }).await.unwrap();
    assert!(core.sessions.history_suggest(WINDOW, &id, "git").await.unwrap().is_empty());
    core.sessions.history_add(WINDOW, &id, "whoami").await.unwrap();
    assert_eq!(core.vault.list_history().await.unwrap().len(), 3);

    // Delete one, then clear the rest.
    core.vault.delete_history(None, "git status").await.unwrap();
    assert_eq!(core.vault.delete_history(None, "git status").await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(core.vault.delete_history(Some("not-an-id"), "x").await.unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(core.vault.list_history().await.unwrap().len(), 2);
    assert_eq!(core.vault.clear_history().await.unwrap(), 2);
    assert!(core.vault.list_history().await.unwrap().is_empty());
    let _ = core.sessions.close(WINDOW, &id);
}

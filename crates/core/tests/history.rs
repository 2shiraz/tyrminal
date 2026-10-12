//! Session recordings through the application core, with real local terminals (Unix shells).
//!
//! Recording is opt-in, holds output only (never typed input), survives a lock, keeps the newest
//! recordings per host plus bookmarks, and reports cut, damaged or missing files honestly.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tyrminal_core::contracts::{
    ErrorCode, PlaybackFrame, RecordingSettings, SessionEvent, SessionLogKind, SessionLogPlayback, SessionLogState,
    SessionState,
};
use tyrminal_core::{Core, SessionSink};

const PASSPHRASE: &str = "correct horse battery staple";
const WINDOW: &str = "main";
const WAIT: Duration = Duration::from_secs(20);

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

/// A local terminal driven like the renderer would.
struct Terminal {
    core: Core,
    session: String,
    inbox: mpsc::UnboundedReceiver<Message>,
    text: String,
}

impl Terminal {
    async fn open(core: &Core) -> Self {
        let (tx, inbox) = mpsc::unbounded_channel();
        let opened = core.sessions.open_local(WINDOW, 100, 30, Arc::new(ChannelSink(tx))).await.unwrap();
        let mut terminal = Self { core: core.clone(), session: opened.session_id, inbox, text: String::new() };
        loop {
            if let SessionEvent::State { state: SessionState::Connected } = terminal.event().await {
                break;
            }
        }
        // A prompt-independent marker that the shell reads input.
        terminal.run("echo ready-$((40+2))").await;
        terminal.output_until("ready-42").await;
        terminal
    }

    async fn event(&mut self) -> SessionEvent {
        loop {
            match tokio::time::timeout(WAIT, self.inbox.recv()).await.expect("timed out waiting for an event") {
                Some(Message::Event(event)) => return event,
                Some(Message::Output(bytes)) => self.absorb(&bytes).await,
                None => panic!("session channel closed"),
            }
        }
    }

    async fn absorb(&mut self, bytes: &[u8]) {
        self.text.push_str(&String::from_utf8_lossy(bytes));
        let _ = self.core.sessions.ack(WINDOW, &self.session, bytes.len() as u32).await;
    }

    async fn output_until(&mut self, needle: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !self.text.contains(needle) {
            match tokio::time::timeout_at(deadline, self.inbox.recv()).await {
                Ok(Some(Message::Output(bytes))) => self.absorb(&bytes).await,
                Ok(Some(Message::Event(_))) => {}
                Ok(None) => panic!("closed while waiting for {needle:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; got {:?}", self.text),
            }
        }
    }

    async fn type_text(&self, text: &str) {
        self.core.sessions.write(WINDOW, &self.session, text.as_bytes().to_vec()).await.unwrap();
    }

    async fn run(&self, line: &str) {
        self.type_text(&format!("{line}\r")).await;
    }

    async fn close(mut self) {
        self.core.sessions.close(WINDOW, &self.session).unwrap();
        loop {
            if let SessionEvent::Closed { .. } = self.event().await {
                return;
            }
        }
    }

    async fn until_closed(&mut self) -> Option<ErrorCode> {
        loop {
            if let SessionEvent::Closed { error, .. } = self.event().await {
                return error.map(|e| e.code);
            }
        }
    }
}

struct Fixture {
    dir: TempDir,
    core: Core,
}

impl Fixture {
    async fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let core = Core::open(&dir.path().join("vault.db")).unwrap();
        core.vault.create(PASSPHRASE.into()).await.unwrap();
        Self { dir, core }
    }

    async fn record(&self, keep_per_host: u32, max_log_mib: u32) {
        let settings = RecordingSettings { enabled: true, keep_per_host, max_log_mib };
        assert_eq!(self.core.sessions.set_recording_settings(settings).await.unwrap(), settings);
    }

    fn logs_dir(&self) -> PathBuf {
        self.dir.path().join("logs")
    }

    fn log_file(&self, id: &str) -> PathBuf {
        self.logs_dir().join(format!("{id}.tyrlog"))
    }

    async fn only_log(&self) -> tyrminal_core::contracts::SessionLogSummary {
        let logs = self.core.sessions.list_session_logs().await.unwrap();
        assert_eq!(logs.len(), 1, "{logs:?}");
        logs.into_iter().next().unwrap()
    }
}

/// Everything a playback shows, as text.
fn played_text(playback: &SessionLogPlayback) -> String {
    let engine = base64::engine::general_purpose::STANDARD;
    playback
        .frames
        .iter()
        .filter_map(|f| match f {
            PlaybackFrame::Output { data, .. } => {
                Some(String::from_utf8_lossy(&engine.decode(data).unwrap()).into_owned())
            }
            PlaybackFrame::Resize { .. } => None,
        })
        .collect()
}

/// Every file under `dir`, recursively, as bytes.
fn all_bytes_under(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(all_bytes_under(&path));
        } else {
            out.push((path.clone(), std::fs::read(&path).unwrap()));
        }
    }
    out
}

#[tokio::test]
async fn nothing_is_recorded_until_recording_is_turned_on() {
    let f = Fixture::new().await;
    assert_eq!(f.core.sessions.recording_settings().await.unwrap(), RecordingSettings::default());
    assert!(!RecordingSettings::default().enabled);
    let terminal = Terminal::open(&f.core).await;
    terminal.close().await;
    assert!(f.core.sessions.list_session_logs().await.unwrap().is_empty());
    assert!(!f.logs_dir().exists(), "no recording file without recording turned on");
}

#[tokio::test]
async fn a_recording_holds_what_was_printed_and_never_a_hidden_answer() {
    let f = Fixture::new().await;
    f.record(5, 64).await;
    let mut terminal = Terminal::open(&f.core).await;
    // A prompt that does not echo, as `sudo` or `passwd` would show. The prompt text is built at
    // run time so that waiting for it cannot match the echoed command line.
    terminal.run("stty -echo; printf '%s%s: ' Sec ret; read answer; stty echo; echo; echo done-$((2+3))").await;
    terminal.output_until("Secret: ").await;
    terminal.type_text("hunter2-typed-canary\r").await;
    terminal.output_until("done-5").await;
    terminal.resize_to(120, 40).await;
    terminal.run("echo printed-$((6*7))-canary").await;
    terminal.output_until("printed-42-canary").await;
    assert!(!terminal.text.contains("hunter2-typed-canary"), "the shell did not echo the answer");
    terminal.close().await;

    let log = f.only_log().await;
    assert_eq!(log.kind, SessionLogKind::Local);
    assert_eq!(log.title, "Local terminal");
    assert_eq!(log.state, SessionLogState::Complete);
    assert!(log.ended_at.unwrap() >= log.started_at);
    let playback = f.core.sessions.open_session_log(&log.id).await.unwrap();
    let text = played_text(&playback);
    assert!(text.contains("Secret: ") && text.contains("done-5") && text.contains("printed-42-canary"), "{text:?}");
    assert!(!text.contains("hunter2-typed-canary"), "typed input must never be recorded");
    assert_eq!((playback.cols, playback.rows), (100, 30));
    assert!(playback.frames.iter().any(|f| matches!(f, PlaybackFrame::Resize { cols: 120, rows: 40, .. })));
    assert!(!playback.truncated);

    // Nothing readable on disk: not the output, not the title, not the typed answer.
    for (path, bytes) in all_bytes_under(f.dir.path()) {
        let raw = String::from_utf8_lossy(&bytes);
        for canary in ["printed-42-canary", "hunter2-typed-canary", "Local terminal"] {
            assert!(!raw.contains(canary), "{canary} in plaintext in {}", path.display());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(f.logs_dir()).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(f.log_file(&log.id)).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

impl Terminal {
    async fn resize_to(&self, cols: u16, rows: u16) {
        self.core.sessions.resize(WINDOW, &self.session, cols, rows).await.unwrap();
    }
}

#[tokio::test]
async fn turning_recording_off_stops_it_and_keeps_every_recording_until_deleted() {
    let f = Fixture::new().await;
    f.record(5, 64).await;
    let mut terminal = Terminal::open(&f.core).await;
    let running = f.only_log().await;
    assert_eq!(running.state, SessionLogState::Recording);
    assert_eq!(f.core.sessions.delete_session_log(&running.id).await.unwrap_err().code, ErrorCode::InvalidInput);

    f.core
        .sessions
        .set_recording_settings(RecordingSettings { enabled: false, ..RecordingSettings::default() })
        .await
        .unwrap();
    // The session goes on; only the recording stopped.
    terminal.run("echo after-off-$((1+1))").await;
    terminal.output_until("after-off-2").await;
    let stopped = f.only_log().await;
    assert_eq!(stopped.state, SessionLogState::Complete);
    let text = played_text(&f.core.sessions.open_session_log(&stopped.id).await.unwrap());
    assert!(text.contains("ready-42") && !text.contains("after-off-2"), "{text:?}");
    terminal.close().await;
    assert_eq!(f.core.sessions.list_session_logs().await.unwrap().len(), 1, "turning off deletes nothing");

    // Deleting is its own action, and removes the file too.
    assert_eq!(f.core.sessions.delete_all_session_logs().await.unwrap(), 1);
    assert!(f.core.sessions.list_session_logs().await.unwrap().is_empty());
    assert!(!f.log_file(&stopped.id).exists());
    assert_eq!(f.core.sessions.session_log_storage().await.unwrap().count, 0);
}

#[tokio::test]
async fn only_the_newest_recordings_per_host_are_kept_and_bookmarks_survive() {
    let f = Fixture::new().await;
    f.record(2, 64).await;
    let first = {
        let terminal = Terminal::open(&f.core).await;
        terminal.close().await;
        f.only_log().await
    };
    let marked =
        f.core.sessions.bookmark_session_log(&first.id, true, "  deploy went wrong here  ".into()).await.unwrap();
    assert!(marked.bookmarked);
    assert_eq!(marked.comment, "deploy went wrong here");
    let mut seen = vec![first.id.clone()];
    for _ in 0..3 {
        Terminal::open(&f.core).await.close().await;
        let logs = f.core.sessions.list_session_logs().await.unwrap();
        for log in logs {
            if !seen.contains(&log.id) {
                seen.push(log.id);
            }
        }
    }
    let logs = f.core.sessions.list_session_logs().await.unwrap();
    // The bookmarked one plus the two newest unbookmarked ones, newest first.
    assert_eq!(logs.len(), 3, "{logs:?}");
    assert!(logs.windows(2).all(|w| w[0].started_at >= w[1].started_at));
    assert!(logs.iter().any(|l| l.id == first.id && l.bookmarked));
    assert_eq!(logs.iter().filter(|l| !l.bookmarked).count(), 2);
    let deleted: Vec<_> = seen.iter().filter(|id| !logs.iter().any(|l| &&l.id == id)).collect();
    assert_eq!(deleted.len(), 1);
    assert!(!f.log_file(deleted[0]).exists(), "a rotated-out recording's file is deleted");

    let long = "x".repeat(2001);
    assert_eq!(
        f.core.sessions.bookmark_session_log(&first.id, true, long).await.unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        f.core
            .sessions
            .set_recording_settings(RecordingSettings { enabled: true, keep_per_host: 0, max_log_mib: 64 })
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[tokio::test]
async fn a_lock_ends_the_recording_and_it_reads_back_after_unlocking() {
    let f = Fixture::new().await;
    f.record(5, 64).await;
    let mut terminal = Terminal::open(&f.core).await;
    terminal.run("echo before-lock-$((3+4))").await;
    terminal.output_until("before-lock-7").await;
    f.core.vault.lock().await;
    assert_eq!(terminal.until_closed().await, Some(ErrorCode::VaultLocked));
    assert_eq!(f.core.sessions.list_session_logs().await.unwrap_err().code, ErrorCode::VaultLocked);

    f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
    let log = f.only_log().await;
    let playback = f.core.sessions.open_session_log(&log.id).await.unwrap();
    assert!(played_text(&playback).contains("before-lock-7"));
    assert_eq!(playback.log.state, SessionLogState::Complete);
    assert_eq!(f.only_log().await.state, SessionLogState::Complete, "opening it completed its record");
}

#[tokio::test]
async fn cut_damaged_or_missing_recordings_are_reported_and_show_only_what_verified() {
    let f = Fixture::new().await;
    f.record(10, 64).await;
    let mut terminal = Terminal::open(&f.core).await;
    for i in 0..3 {
        terminal.run(&format!("echo part-{i}-$((10+{i}))")).await;
        terminal.output_until(&format!("part-{i}-1{i}")).await;
        // Let the recorder write a chunk between parts.
        tokio::time::sleep(Duration::from_millis(2300)).await;
    }
    terminal.close().await;
    let log = f.only_log().await;
    let path = f.log_file(&log.id);
    let original = std::fs::read(&path).unwrap();

    // Cut before the final chunk: what was written before shows, marked incomplete.
    std::fs::write(&path, &original[..original.len() - 100]).unwrap();
    let cut = f.core.sessions.open_session_log(&log.id).await.unwrap();
    assert_eq!(cut.log.state, SessionLogState::Incomplete);
    assert!(played_text(&cut).contains("ready-42"));

    // A changed byte near the end: an authenticated prefix only, marked damaged.
    let mut altered = original.clone();
    let at = altered.len() - 40;
    altered[at] ^= 0x20;
    std::fs::write(&path, &altered).unwrap();
    let damaged = f.core.sessions.open_session_log(&log.id).await.unwrap();
    assert_eq!(damaged.log.state, SessionLogState::Damaged);
    assert!(played_text(&damaged).contains("ready-42"));

    // Garbage, then no file at all.
    std::fs::write(&path, b"garbage").unwrap();
    assert_eq!(f.core.sessions.open_session_log(&log.id).await.unwrap_err().code, ErrorCode::NotFound);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(f.only_log().await.state, SessionLogState::Unreadable);
    assert_eq!(f.core.sessions.open_session_log(&log.id).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_recording_stops_at_its_size_limit_and_the_session_goes_on() {
    let f = Fixture::new().await;
    f.record(5, 1).await;
    let mut terminal = Terminal::open(&f.core).await;
    // About 2 MiB of output.
    terminal.run("i=0; while [ $i -lt 20000 ]; do echo 0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789; i=$((i+1)); done; echo big-done-$((5*5))").await;
    terminal.output_until("big-done-25").await;
    terminal.close().await;
    let log = f.only_log().await;
    assert_eq!(log.state, SessionLogState::SizeLimit);
    assert!(log.size_bytes <= 1024 * 1024, "{}", log.size_bytes);
    assert!(std::fs::metadata(f.log_file(&log.id)).unwrap().len() <= 1024 * 1024);
    let playback = f.core.sessions.open_session_log(&log.id).await.unwrap();
    assert_eq!(playback.log.state, SessionLogState::SizeLimit);
    assert!(!played_text(&playback).contains("big-done-25"));
}

#[tokio::test]
async fn a_recording_continues_when_its_session_moves_to_another_window() {
    const SECOND: &str = "second";
    let f = Fixture::new().await;
    f.record(5, 64).await;
    let terminal = Terminal::open(&f.core).await;
    let session = terminal.session.clone();
    let token = f.core.sessions.offer_handoff(WINDOW, &session, SECOND).unwrap();
    let (tx, mut inbox) = mpsc::unbounded_channel();
    f.core.sessions.accept_handoff(SECOND, &token, Arc::new(ChannelSink(tx))).unwrap();

    f.core.sessions.write(SECOND, &session, b"echo moved-$((6*7))\r".to_vec()).await.unwrap();
    let mut seen = String::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !seen.contains("moved-42") {
        match tokio::time::timeout_at(deadline, inbox.recv()).await {
            Ok(Some(Message::Output(bytes))) => {
                seen.push_str(&String::from_utf8_lossy(&bytes));
                let _ = f.core.sessions.ack(SECOND, &session, bytes.len() as u32).await;
            }
            Ok(Some(Message::Event(_))) => {}
            other => panic!("no output in the new window ({}): {seen:?}", other.is_ok()),
        }
    }
    f.core.sessions.close(SECOND, &session).unwrap();
    let deadline = tokio::time::Instant::now() + WAIT;
    while f.only_log().await.state == SessionLogState::Recording {
        assert!(tokio::time::Instant::now() < deadline, "the recording never completed");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let text = played_text(&f.core.sessions.open_session_log(&f.only_log().await.id).await.unwrap());
    assert!(text.contains("ready-42") && text.contains("moved-42"), "{text:?}");
    drop(terminal);
}

/// Size and modification time of a recording's file.
fn file_state(path: &Path) -> (u64, std::time::SystemTime) {
    let meta = std::fs::metadata(path).unwrap();
    (meta.len(), meta.modified().unwrap())
}

/// Starts output that never stops and returns once it is being recorded.
async fn printing_forever(f: &Fixture, terminal: &mut Terminal) -> String {
    terminal.run("n=0; while :; do n=$((n+1)); echo tick-$n; sleep 0.02; done").await;
    terminal.output_until("tick-20").await;
    let log = f.only_log().await;
    // The recording keeps up: it grows while the loop runs.
    let path = f.log_file(&log.id);
    let before = file_state(&path).0;
    let deadline = tokio::time::Instant::now() + WAIT;
    while file_state(&path).0 == before {
        assert!(tokio::time::Instant::now() < deadline, "the recording never grew");
        terminal.output_until(&format!("tick-{}", 40)).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    log.id
}

#[tokio::test]
async fn nothing_more_is_written_once_the_session_closes_or_the_vault_locks() {
    for lock in [false, true] {
        let f = Fixture::new().await;
        f.record(5, 64).await;
        let mut terminal = Terminal::open(&f.core).await;
        let id = printing_forever(&f, &mut terminal).await;
        if lock {
            f.core.vault.lock().await;
        } else {
            f.core.sessions.close(WINDOW, &terminal.session).unwrap();
        }
        // Output keeps arriving until the session ends, so this is bounded by its own deadline.
        let closed = tokio::time::timeout(WAIT, terminal.until_closed()).await.expect("the session ended at once");
        assert_eq!(closed, lock.then_some(ErrorCode::VaultLocked));
        // The session task has ended; the file is final and stays exactly as it is.
        let path = f.log_file(&id);
        let ended = file_state(&path);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(file_state(&path), ended, "written after the session ended (lock: {lock})");
        if lock {
            f.core.vault.unlock_with_passphrase(PASSPHRASE.into()).await.unwrap();
        }
        let playback = f.core.sessions.open_session_log(&id).await.unwrap();
        assert_eq!(playback.log.state, SessionLogState::Complete, "finalized with its end (lock: {lock})");
        assert!(played_text(&playback).contains("tick-20"));
        assert_eq!(file_state(&path), ended, "reading it changes nothing");
    }
}

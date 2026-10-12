//! Running a saved snippet non-interactively on hosts the user chose (SNP-05/07).
//!
//! Each run uses an exec channel on a session's already verified and authenticated connection,
//! so host trust and sign-in happened through the normal, interactive path first. There is no
//! PTY: a command that asks for a password (sudo, su) fails instead of prompting, so nothing is
//! ever typed into a prompt on the user's behalf. Output is untrusted: it is bounded, stripped of
//! control characters and returned as text. A run can be cancelled; it also ends when its session
//! closes or the vault locks (the connection goes away with the session).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::watch;
use tyrminal_contracts::{ErrorCode, IpcError, SnippetExecResult};
use tyrminal_ssh::{ShellEvent, VerifiedConnection};

use crate::error::{err, from_ssh};

/// Output kept per stream.
pub(crate) const MAX_KEPT: usize = 64 * 1024;
/// Output read in total before a run is stopped (a command that never stops talking).
const MAX_READ: usize = 64 * 1024 * 1024;
/// Longest a run may take.
const LIMIT: Duration = Duration::from_secs(30 * 60);
/// Runs at once, across all sessions.
const MAX_RUNS: usize = 64;

/// Cancellation handles of running snippet runs, by run id, with their owning window.
#[derive(Default)]
pub(crate) struct Runs {
    live: Mutex<HashMap<String, (String, watch::Sender<bool>)>>,
}

impl Runs {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, watch::Sender<bool>)>> {
        self.live.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn start(&self, owner: &str, run_id: &str) -> Result<watch::Receiver<bool>, IpcError> {
        if run_id.is_empty() || run_id.len() > 64 || !run_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(err(ErrorCode::InvalidInput, "That run is not valid."));
        }
        let mut map = self.map();
        if map.len() >= MAX_RUNS {
            return Err(err(ErrorCode::LimitExceeded, "Too many snippet runs at once."));
        }
        if map.contains_key(run_id) {
            return Err(err(ErrorCode::Conflict, "That run is already in progress."));
        }
        let (tx, rx) = watch::channel(false);
        map.insert(run_id.to_owned(), (owner.to_owned(), tx));
        Ok(rx)
    }

    pub(crate) fn finish(&self, run_id: &str) {
        self.map().remove(run_id);
    }

    /// Cancels a run the caller started; unknown runs and other windows' runs are ignored alike.
    pub(crate) fn cancel(&self, owner: &str, run_id: &str) {
        if let Some((run_owner, tx)) = self.map().get(run_id)
            && run_owner == owner
        {
            let _ = tx.send(true);
        }
    }
}

fn cancelled() -> IpcError {
    err(ErrorCode::Cancelled, "The run was cancelled.")
}

/// Untrusted output as display text: newlines and tabs kept, other control characters and bidi
/// overrides removed.
pub(crate) fn display_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| {
            let bidi = matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}');
            !bidi && (!c.is_control() || *c == '\n' || *c == '\t')
        })
        .collect()
}

fn keep(into: &mut Vec<u8>, data: &[u8], truncated: &mut bool) {
    let room = MAX_KEPT.saturating_sub(into.len());
    if data.len() > room {
        *truncated = true;
    }
    into.extend_from_slice(&data[..data.len().min(room)]);
}

/// Runs `text` with the account's login shell on an exec channel of `conn`.
pub(crate) async fn run(
    conn: &VerifiedConnection,
    text: &str,
    env: &[(String, zeroize::Zeroizing<String>)],
    mut cancel: watch::Receiver<bool>,
) -> Result<SnippetExecResult, IpcError> {
    // The host's environment variables are requested first, so the snippet can use them (SNP-14).
    let (mut reader, writer, env_rejected) = conn.open_command_with_env(text, env).await.map_err(|e| from_ssh(&e))?;
    // Nothing is sent on standard input.
    let _ = writer.eof().await;
    let mut out = SnippetExecResult {
        exit_status: None,
        exit_signal: None,
        stdout: String::new(),
        stderr: String::new(),
        truncated: false,
        env_rejected,
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut read = 0usize;
    let collect = async {
        loop {
            tokio::select! {
                event = reader.next() => match event {
                    Some(ShellEvent::Output(data)) => {
                        read += data.len();
                        keep(&mut stdout, &data, &mut out.truncated);
                    }
                    Some(ShellEvent::ExtendedOutput(data)) => {
                        read += data.len();
                        keep(&mut stderr, &data, &mut out.truncated);
                    }
                    Some(ShellEvent::ExitStatus(code)) => out.exit_status = Some(code),
                    Some(ShellEvent::ExitSignal(name)) => out.exit_signal = Some(display_text(name.as_bytes())),
                    Some(ShellEvent::Eof) => {}
                    Some(ShellEvent::ConnectionLost) => {
                        return Err(err(ErrorCode::Disconnected, "The connection was lost during the run."));
                    }
                    None => return Ok(()),
                },
                () = async { let _ = cancel.wait_for(|c| *c).await; } => {
                    let _ = writer.close().await;
                    return Err(cancelled());
                }
            }
            if read > MAX_READ {
                out.truncated = true;
                let _ = writer.close().await;
                return Err(err(
                    ErrorCode::LimitExceeded,
                    "The command produced more than 64 MiB of output and was stopped.",
                ));
            }
        }
    };
    tokio::time::timeout(LIMIT, collect)
        .await
        .map_err(|_| err(ErrorCode::Timeout, "The command was still running after 30 minutes and was stopped."))??;
    out.stdout = display_text(&stdout);
    out.stderr = display_text(&stderr);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_display_text_and_bounded() {
        assert_eq!(display_text(b"ok\r\n\x1b[31mred\x07\tdone\n"), "ok\n[31mred\tdone\n");
        assert_eq!(display_text("a\u{202e}b".as_bytes()), "ab");
        let mut kept = Vec::new();
        let mut truncated = false;
        keep(&mut kept, &vec![b'x'; MAX_KEPT - 1], &mut truncated);
        assert!(!truncated);
        keep(&mut kept, b"yz", &mut truncated);
        assert!(truncated);
        assert_eq!(kept.len(), MAX_KEPT);
    }

    #[test]
    fn runs_are_cancelled_only_by_their_owner_and_ids_are_checked() {
        let runs = Runs::default();
        let rx = runs.start("main", "run-1").unwrap();
        assert!(runs.start("main", "run-1").is_err(), "one run per id");
        assert!(runs.start("main", "../x").is_err());
        runs.cancel("other-window", "run-1");
        assert!(!*rx.borrow());
        runs.cancel("main", "run-1");
        assert!(*rx.borrow());
        runs.finish("run-1");
        assert!(runs.start("main", "run-1").is_ok());
    }
}

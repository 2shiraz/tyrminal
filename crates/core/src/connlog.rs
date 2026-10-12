//! Connection diagnostics (CON-15): what happened while a session connected, step by step, for
//! the user to read when a connection fails or behaves oddly.
//!
//! Lines hold only connection facts: addresses, hop labels, algorithm names, host-key
//! fingerprints (public), authentication method names and outcomes, and the user-facing error.
//! Never a password, passphrase, key, answer to a prompt, or anything typed or shown in the
//! terminal. Text that comes from the server is reduced to printable ASCII and bounded.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

/// Lines kept per session (the oldest are dropped).
const MAX_LINES: usize = 200;
/// Longest line kept.
const MAX_LINE: usize = 300;

pub(crate) struct ConnLog {
    started: Instant,
    lines: Mutex<VecDeque<String>>,
}

/// Printable ASCII only, bounded: server-chosen names cannot inject control sequences.
pub(crate) fn clean(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(MAX_LINE).collect()
}

impl ConnLog {
    pub(crate) fn new() -> Self {
        Self { started: Instant::now(), lines: Mutex::new(VecDeque::new()) }
    }

    pub(crate) fn note(&self, text: &str) {
        let ms = self.started.elapsed().as_millis();
        let mut lines = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        if lines.len() >= MAX_LINES {
            lines.pop_front();
        }
        lines.push_back(format!("{:>6}.{:03}s  {}", ms / 1000, ms % 1000, clean(text)));
    }

    pub(crate) fn lines(&self) -> Vec<String> {
        self.lines.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_bounded_timed_and_cleaned() {
        let log = ConnLog::new();
        log.note("server offers: publickey,\u{1b}[2Jpassword\n");
        let line = &log.lines()[0];
        assert!(line.ends_with("server offers: publickey,[2Jpassword"), "{line:?}");
        assert!(line.trim_start().starts_with("0."));
        for i in 0..(MAX_LINES + 10) {
            log.note(&format!("step {i}"));
        }
        let lines = log.lines();
        assert_eq!(lines.len(), MAX_LINES);
        assert!(lines.last().unwrap().ends_with(&format!("step {}", MAX_LINES + 9)));
        log.note(&"x".repeat(5000));
        assert!(log.lines().last().unwrap().len() < MAX_LINE + 20);
    }
}

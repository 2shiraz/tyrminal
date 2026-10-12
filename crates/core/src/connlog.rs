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

/// The connection-log line for environment requests (SNP-13): names only, never values.
pub(crate) fn environment_line(sent: &[String], rejected: &[String]) -> String {
    let accepted: Vec<&str> = sent.iter().filter(|n| !rejected.contains(n)).map(String::as_str).collect();
    let mut line = format!("environment: {} of {} set", accepted.len(), sent.len());
    if !accepted.is_empty() {
        line.push_str(&format!(" ({})", accepted.join(", ")));
    }
    if !rejected.is_empty() {
        line.push_str(&format!("; refused by the server (AcceptEnv): {}", rejected.join(", ")));
    }
    line
}

/// The connection-log line for the sign-in methods a server says may continue after a refusal.
/// The names come from the server: only method-name characters are kept, a few names at most.
pub(crate) fn remaining_methods_line(methods: &[String]) -> String {
    let names: Vec<String> = methods
        .iter()
        .map(|m| {
            m.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '@')).take(64).collect::<String>()
        })
        .filter(|m| !m.is_empty())
        .take(8)
        .collect();
    if names.is_empty() {
        "the server named no other sign-in method".to_owned()
    } else {
        format!("server still allows: {}", names.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_method_lines_keep_only_method_names() {
        let methods = ["password".to_owned(), "publickey".to_owned()];
        assert_eq!(remaining_methods_line(&methods), "server still allows: password, publickey");
        let hostile = [
            "pass\u{1b}[2Jword".to_owned(),
            "x; rm -rf /".to_owned(),
            String::new(),
            "keyboard-interactive".to_owned(),
        ];
        assert_eq!(remaining_methods_line(&hostile), "server still allows: pass2Jword, xrm-rf, keyboard-interactive");
        assert_eq!(remaining_methods_line(&[]), "the server named no other sign-in method");
        assert_eq!(remaining_methods_line(&vec!["a".to_owned(); 20]).matches(", ").count(), 7);
    }

    #[test]
    fn environment_lines_name_variables_and_refusals() {
        let sent = vec!["TYR_APP".to_owned(), "LANG".to_owned(), "SECRET_TOKEN".to_owned()];
        let line = environment_line(&sent, &["SECRET_TOKEN".to_owned()]);
        assert_eq!(line, "environment: 2 of 3 set (TYR_APP, LANG); refused by the server (AcceptEnv): SECRET_TOKEN");
        assert_eq!(environment_line(&sent[..1], &[]), "environment: 1 of 1 set (TYR_APP)");
    }

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

//! Suggestions to forward a port a program on the server says it listens on (P-24, ADR 0011).
//!
//! Session output is untrusted, so this only ever suggests: the window shows the suggestion and
//! nothing is forwarded until the user accepts it. Output chooses at most a port number. The
//! forward always goes to the server's own loopback at that port, so text naming any other host
//! is ignored; a suggestion is made only for loopback or any-address listeners (`localhost`,
//! `127.0.0.1`, `0.0.0.0`, `[::1]`, `[::]`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tyrminal_contracts::SessionEvent;

use crate::sessions::SessionSink;

/// Longest output line examined; longer lines are skipped.
const MAX_LINE: usize = 512;
/// Distinct ports suggested per session at most.
pub(crate) const MAX_PORTS_PER_SESSION: usize = 16;

/// Host spellings that mean "this server", followed by `:`.
const HOSTS: &[&str] = &["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:", "[::]:"];

/// The ports a line of terminal text says something listens on locally, in order of appearance.
/// The line has escape sequences already removed.
pub(crate) fn detect(line: &str) -> Vec<u16> {
    let mut ports = Vec::new();
    let lower = line.to_ascii_lowercase();
    for host in HOSTS {
        let mut from = 0;
        while let Some(at) = lower[from..].find(host) {
            let start = from + at;
            from = start + host.len();
            // The host must stand on its own: `evil.localhost:80`, `127.0.0.10:80` and
            // `user@localhost:22` are not it.
            let before = lower[..start].chars().next_back();
            if !before.is_none_or(|c| c.is_whitespace() || "/(\"'=<[,;".contains(c)) {
                continue;
            }
            if let Some(port) = port_at(&lower[from..]) {
                ports.push(port);
            }
        }
    }
    // A bare `port 3000` counts only on a line that says something listens.
    if lower.contains("listen") {
        let mut from = 0;
        while let Some(at) = lower[from..].find("port ") {
            let start = from + at;
            from = start + "port ".len();
            if let Some(port) = port_at(&lower[from..]) {
                ports.push(port);
            }
        }
    }
    let mut seen = HashSet::new();
    ports.retain(|p| seen.insert(*p));
    ports
}

/// A port number (1–65535, no leading zero) at the start of `text`, ending at a boundary.
fn port_at(text: &str) -> Option<u16> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 5 || digits.starts_with('0') {
        return None;
    }
    let after = text[digits.len()..].chars().next();
    // `:3000.5`, `:3000abc` and `:3000:4000` are not ports; `:3000/`, `:3000.` and `:3000,` are.
    if let Some(c) = after {
        let rest = &text[digits.len() + c.len_utf8()..];
        let ends_sentence = c == '.' && !rest.starts_with(|n: char| n.is_ascii_digit());
        if !(c.is_whitespace() || "/)\"'>,;]".contains(c) || ends_sentence) {
            return None;
        }
    }
    digits.parse::<u16>().ok().filter(|p| *p != 0)
}

/// Removes escape sequences and splits output into lines, across reads.
#[derive(Default)]
struct Lines {
    line: String,
    too_long: bool,
    escape: Escape,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Escape {
    #[default]
    None,
    Started,
    Csi,
    /// OSC, DCS and similar strings, until BEL or ST.
    String,
    StringEsc,
}

impl Lines {
    /// Feeds output; returns the complete lines.
    fn feed(&mut self, data: &[u8]) -> Vec<String> {
        let mut done = Vec::new();
        for &b in data {
            match self.escape {
                Escape::Started => {
                    self.escape = match b {
                        b'[' => Escape::Csi,
                        b']' | b'P' | b'X' | b'^' | b'_' => Escape::String,
                        _ => Escape::None,
                    };
                    continue;
                }
                Escape::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.escape = Escape::None;
                    }
                    continue;
                }
                Escape::String => {
                    match b {
                        0x07 => self.escape = Escape::None,
                        0x1b => self.escape = Escape::StringEsc,
                        _ => {}
                    }
                    continue;
                }
                Escape::StringEsc => {
                    self.escape = if b == b'\\' { Escape::None } else { Escape::String };
                    continue;
                }
                Escape::None => {}
            }
            match b {
                0x1b => self.escape = Escape::Started,
                b'\n' | b'\r' => {
                    if !self.too_long && !self.line.is_empty() {
                        done.push(std::mem::take(&mut self.line));
                    }
                    self.line.clear();
                    self.too_long = false;
                }
                // Printable ASCII only: ports and the host names above are ASCII.
                0x20..=0x7e if !self.too_long => {
                    if self.line.len() >= MAX_LINE {
                        self.too_long = true;
                        self.line.clear();
                    } else {
                        self.line.push(char::from(b));
                    }
                }
                _ => {}
            }
        }
        done
    }
}

/// Ports suggested per session; a quick forward is only started for one of them.
#[derive(Default)]
pub(crate) struct Suggested(Mutex<HashMap<String, HashSet<u16>>>);

impl Suggested {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashSet<u16>>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Records `port` for the session; false if it was already suggested or the session has
    /// reached its limit.
    fn add(&self, session_id: &str, port: u16) -> bool {
        let mut map = self.map();
        let ports = map.entry(session_id.to_owned()).or_default();
        ports.len() < MAX_PORTS_PER_SESSION && ports.insert(port)
    }

    pub(crate) fn contains(&self, session_id: &str, port: u16) -> bool {
        self.map().get(session_id).is_some_and(|p| p.contains(&port))
    }

    pub(crate) fn session_ended(&self, session_id: &str) {
        self.map().remove(session_id);
    }
}

/// Passes output on and suggests ports it names. Events pass through untouched.
struct SuggestingSink {
    inner: Arc<dyn SessionSink>,
    session_id: String,
    lines: Mutex<Lines>,
    suggested: Arc<Suggested>,
}

impl SessionSink for SuggestingSink {
    fn output(&self, data: Vec<u8>) -> bool {
        let lines = self.lines.lock().unwrap_or_else(|p| p.into_inner()).feed(&data);
        let delivered = self.inner.output(data);
        for line in lines {
            for port in detect(&line) {
                if self.suggested.add(&self.session_id, port) {
                    self.inner.event(SessionEvent::PortSuggestion { port });
                }
            }
        }
        delivered
    }

    fn event(&self, event: SessionEvent) -> bool {
        self.inner.event(event)
    }
}

/// Wraps a session's sink so the ports its output names are suggested to the window.
pub(crate) fn wrap(inner: Arc<dyn SessionSink>, session_id: &str, suggested: &Arc<Suggested>) -> Arc<dyn SessionSink> {
    Arc::new(SuggestingSink {
        inner,
        session_id: session_id.to_owned(),
        lines: Mutex::new(Lines::default()),
        suggested: Arc::clone(suggested),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_any_address_listeners_are_found() {
        assert_eq!(detect("Listening on http://localhost:3000"), vec![3000]);
        assert_eq!(detect("  ➜  Local:   http://127.0.0.1:5173/"), vec![5173]);
        assert_eq!(detect("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."), vec![8000]);
        assert_eq!(detect("listening on [::1]:9229"), vec![9229]);
        assert_eq!(detect("Server running at http://[::]:4000."), vec![4000]);
        assert_eq!(detect("server listening on port 8080"), vec![8080]);
        assert_eq!(detect("LISTENING ON LOCALHOST:65535"), vec![65535]);
        assert_eq!(detect("http://localhost:3000 and http://localhost:3001"), vec![3000, 3001]);
        assert_eq!(detect("http://localhost:3000/ again http://127.0.0.1:3000/"), vec![3000]);
    }

    #[test]
    fn other_hosts_are_never_suggested() {
        for line in [
            "Listening on http://10.0.0.5:3000",
            "listening on evil.example.com:3000",
            "listening on http://evil.localhost:3000",
            "listening on http://localhost.evil.com:3000",
            "listening on 127.0.0.10:3000",
            "listening on 127.0.0.1.evil.com:3000",
            "ssh user@localhost:22",
            "listening on http://192.168.1.10:80/",
            "listening on [2001:db8::1]:443",
        ] {
            assert!(detect(line).is_empty(), "{line}");
        }
    }

    #[test]
    fn invalid_ports_are_never_suggested() {
        for line in [
            "listening on localhost:0",
            "listening on localhost:65536",
            "listening on localhost:99999",
            "listening on localhost:123456",
            "listening on localhost:03000",
            "listening on localhost:-1",
            "listening on localhost:3000abc",
            "listening on localhost:3000:4000",
            "listening on localhost:30.5",
            "listening on localhost:",
            "port 3000 is free", // a bare port needs a line that says something listens
            "listening on port 0",
        ] {
            assert!(detect(line).is_empty(), "{line}");
        }
    }

    #[test]
    fn escape_sequences_and_split_reads_are_handled() {
        let mut lines = Lines::default();
        assert!(lines.feed(b"\x1b[32mListening on http://local").is_empty());
        assert_eq!(lines.feed(b"host:30\x1b[0m00\r\n"), vec!["Listening on http://localhost:3000".to_owned()]);
        // A link's hidden target is not text: only what is shown counts.
        let osc = b"\x1b]8;;http://10.0.0.5:3000\x07see the docs\x1b]8;;\x1b\\\n";
        assert_eq!(lines.feed(osc), vec!["see the docs".to_owned()]);
        // Overlong lines are skipped entirely.
        let mut long = vec![b'a'; MAX_LINE + 10];
        long.extend_from_slice(b" localhost:3000\n");
        assert!(lines.feed(&long).is_empty());
        assert_eq!(lines.feed(b"localhost:4000\n"), vec!["localhost:4000".to_owned()]);
    }

    #[test]
    fn each_port_is_suggested_once_and_only_so_many_per_session() {
        let s = Suggested::default();
        assert!(s.add("a", 3000));
        assert!(!s.add("a", 3000));
        assert!(s.add("b", 3000), "per session");
        for port in 1..MAX_PORTS_PER_SESSION as u16 {
            s.add("a", 4000 + port);
        }
        assert!(!s.add("a", 9999), "limit reached");
        assert!(s.contains("a", 3000) && !s.contains("a", 9999));
        s.session_ended("a");
        assert!(!s.contains("a", 3000));
    }
}

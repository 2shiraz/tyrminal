//! Command history for suggestions (AUT-01): local, encrypted in the vault, opt-in, and a
//! setting of its own (separate from session recording and diagnostics, BUILD_SPEC §4.9).
//!
//! The renderer submits the command line the shell showed between its prompt-end and
//! command-start marks (shell integration, OSC 133), so input typed while a command runs, such
//! as a password at a `sudo` prompt, never becomes history. Lines that start with a space are not
//! kept (the shell convention for "do not remember this"), and neither are lines with control
//! characters. One record per host, and one for local terminals, each bounded.

use tyrminal_contracts::IpcError;
use tyrminal_contracts::limits::{MAX_HISTORY_COMMAND_LEN, MAX_HISTORY_ENTRIES, MAX_HISTORY_SUGGESTIONS};

use crate::error::invalid;
use crate::records::{HistoryEntryRecord, HistoryRecord};

/// The scope of local terminals (host scopes are host ids, which never equal this).
pub(crate) const LOCAL_SCOPE: &str = "local";

/// What to keep of a submitted line: `None` when it should not become history.
pub(crate) fn normalize(line: &str) -> Result<Option<String>, IpcError> {
    if line.len() > MAX_HISTORY_COMMAND_LEN * 4 {
        return Err(invalid("That command is too long."));
    }
    if line.starts_with(' ') || line.starts_with('\t') {
        return Ok(None);
    }
    let command = line.trim_end();
    if command.is_empty() || command.len() > MAX_HISTORY_COMMAND_LEN || command.chars().any(char::is_control) {
        return Ok(None);
    }
    Ok(Some(command.to_owned()))
}

/// Adds or refreshes a command, dropping the least recently used beyond the limit.
pub(crate) fn add(record: &mut HistoryRecord, command: String, now: u64) {
    if let Some(at) = record.commands.iter().position(|e| e.command == command) {
        let mut entry = record.commands.remove(at);
        entry.last_used = now;
        entry.uses = entry.uses.saturating_add(1);
        record.commands.push(entry);
    } else {
        record.commands.push(HistoryEntryRecord { command, last_used: now, uses: 1 });
    }
    if record.commands.len() > MAX_HISTORY_ENTRIES {
        let excess = record.commands.len() - MAX_HISTORY_ENTRIES;
        record.commands.drain(..excess);
    }
}

/// Removes one command; whether it was there.
pub(crate) fn remove(record: &mut HistoryRecord, command: &str) -> bool {
    let before = record.commands.len();
    record.commands.retain(|e| e.command != command);
    record.commands.len() != before
}

/// Suggestions for `query`, most recently used first: commands that start with it, then
/// commands that contain it (case-insensitive). An empty query gives the most recent commands.
pub(crate) fn suggest(record: &HistoryRecord, query: &str) -> Vec<String> {
    let recent = record.commands.iter().rev();
    if query.trim().is_empty() {
        return recent.take(MAX_HISTORY_SUGGESTIONS).map(|e| e.command.clone()).collect();
    }
    let lower = query.to_lowercase();
    let starts = recent.clone().filter(|e| e.command.starts_with(query));
    let contains = recent.filter(|e| !e.command.starts_with(query) && e.command.to_lowercase().contains(&lower));
    starts.chain(contains).take(MAX_HISTORY_SUGGESTIONS).map(|e| e.command.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_with_a_leading_space_control_characters_or_nothing_are_not_kept() {
        assert_eq!(normalize("ls -la  ").unwrap().as_deref(), Some("ls -la"));
        assert_eq!(normalize(" secret-command").unwrap(), None);
        assert_eq!(normalize("\tsecret").unwrap(), None);
        assert_eq!(normalize("   ").unwrap(), None);
        assert_eq!(normalize("echo \u{1b}[31m").unwrap(), None);
        assert_eq!(normalize("for x in a b\ndo echo $x; done").unwrap(), None);
        assert_eq!(normalize(&"x".repeat(MAX_HISTORY_COMMAND_LEN + 1)).unwrap(), None);
        assert!(normalize(&"x".repeat(MAX_HISTORY_COMMAND_LEN * 4 + 1)).is_err());
    }

    #[test]
    fn suggestions_are_recent_first_prefix_then_substring_and_bounded() {
        let mut h = HistoryRecord { scope: LOCAL_SCOPE.into(), commands: Vec::new() };
        add(&mut h, "git status".into(), 1);
        add(&mut h, "git log".into(), 2);
        add(&mut h, "tail -f /var/log/syslog".into(), 3);
        add(&mut h, "git status".into(), 4);
        assert_eq!(suggest(&h, "git "), ["git status", "git log"]);
        assert_eq!(suggest(&h, "LOG"), ["tail -f /var/log/syslog", "git log"]);
        assert_eq!(suggest(&h, ""), ["git status", "tail -f /var/log/syslog", "git log"]);
        assert_eq!(h.commands.iter().find(|e| e.command == "git status").unwrap().uses, 2);
        assert!(remove(&mut h, "git log"));
        assert!(!remove(&mut h, "git log"));
        assert_eq!(suggest(&h, "git"), ["git status"]);
        for n in 0..(MAX_HISTORY_ENTRIES + 5) {
            add(&mut h, format!("cmd {n}"), 10 + n as u64);
        }
        assert_eq!(h.commands.len(), MAX_HISTORY_ENTRIES);
        assert!(!h.commands.iter().any(|e| e.command == "git status"), "the least recently used are dropped");
        assert_eq!(suggest(&h, "cmd ").len(), MAX_HISTORY_SUGGESTIONS);
    }
}

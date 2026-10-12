//! Local diagnostics (P-22). Off by default, separate from session recording and command
//! history, and never sent anywhere: the user saves a report to a file of their choosing and
//! decides what to do with it.
//!
//! A report holds only facts that cannot carry user data: the application version and platform,
//! and recent failures as (command name, error code, time). Command names and codes are checked
//! against fixed shapes here, so a renderer cannot smuggle text (a host name, a path, a secret)
//! into the file.

use tyrminal_contracts::limits::MAX_DIAGNOSTIC_ENTRIES;
use tyrminal_contracts::{DiagnosticEntry, IpcError};

use crate::error::invalid;

/// Non-secret facts about this installation for the report header.
#[derive(Debug)]
pub struct ReportInfo<'a> {
    pub version: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
    pub vault_unlocked: bool,
    pub sessions: usize,
}

fn command_ok(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name.as_bytes()[0].is_ascii_lowercase()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Builds the report text. Fails (writing nothing) if any entry is not of the expected shape.
pub fn report(info: &ReportInfo<'_>, entries: &[DiagnosticEntry], now: u64) -> Result<String, IpcError> {
    if entries.len() > MAX_DIAGNOSTIC_ENTRIES {
        return Err(invalid("The diagnostic report has too many entries."));
    }
    if entries.iter().any(|e| !command_ok(&e.command) || e.at > now + 86_400) {
        return Err(invalid("The diagnostic report contains an entry it cannot include."));
    }
    let mut out = String::with_capacity(256 + entries.len() * 64);
    out.push_str("Tyrminal diagnostic report\n");
    out.push_str("Contains no host names, user names, paths, commands typed, output or secrets.\n\n");
    out.push_str(&format!("version: {}\nplatform: {}-{}\n", info.version, info.os, info.arch));
    out.push_str(&format!(
        "vault: {}\nsessions open: {}\n",
        if info.vault_unlocked { "unlocked" } else { "locked" },
        info.sessions
    ));
    out.push_str(&format!("report time (unix): {now}\n\nrecent failures ({}):\n", entries.len()));
    for e in entries {
        // `{:?}` of the enum is its fixed variant name.
        out.push_str(&format!("{}  {}  {:?}\n", e.at, e.command, e.code));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tyrminal_contracts::ErrorCode;

    fn info() -> ReportInfo<'static> {
        ReportInfo { version: "0.1.0", os: "linux", arch: "x86_64", vault_unlocked: true, sessions: 2 }
    }

    fn entry(command: &str) -> DiagnosticEntry {
        DiagnosticEntry { command: command.into(), code: ErrorCode::Disconnected, at: 1_000 }
    }

    #[test]
    fn a_report_lists_failures_by_command_and_code_only() {
        let text = report(&info(), &[entry("session_open_ssh"), entry("files_upload_chunk")], 2_000).unwrap();
        assert!(text.contains("1000  session_open_ssh  Disconnected"));
        assert!(text.contains("platform: linux-x86_64"));
        assert!(text.contains("recent failures (2)"));
    }

    #[test]
    fn anything_that_could_carry_user_text_is_refused() {
        for bad in ["", "Session", "host db.internal", "a/b", "x".repeat(49).as_str(), "pass=hunter2", "\u{1b}[2J"] {
            assert!(report(&info(), &[entry(bad)], 2_000).is_err(), "{bad:?}");
        }
        let far_future = DiagnosticEntry { at: 2_000 + 86_401, ..entry("vault_unlock") };
        assert!(report(&info(), &[far_future], 2_000).is_err());
        let many = vec![entry("vault_unlock"); MAX_DIAGNOSTIC_ENTRIES + 1];
        assert!(report(&info(), &many, 2_000).is_err());
    }
}

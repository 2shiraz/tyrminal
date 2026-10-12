//! tmux and screen session awareness (P-31, ADR 0011): lists the server's sessions over a
//! separate exec channel of a verified SSH connection.
//!
//! The listing command is a constant and is never typed into the user's shell. The answer is
//! untrusted: names are shown as plain text (control characters removed, length capped), and an
//! attach command is built only from a name that matches a strict pattern. The renderer types
//! that command into the session only after the user chooses it.

use std::time::Duration;

use tyrminal_contracts::limits::MAX_MULTIPLEXER_SESSIONS;
use tyrminal_contracts::{MultiplexerKind, MultiplexerList, MultiplexerSession, MultiplexerUnavailable};
use tyrminal_ssh::VerifiedConnection;

/// The fixed command. Each multiplexer's part starts with a marker that says whether it is
/// installed, so "not installed" and "no sessions" are told apart. tmux prints the numbers first
/// and the name last, so a name with spaces is the rest of the line.
pub(crate) const COMMAND: &str = "LC_ALL=C; export LC_ALL; \
if command -v tmux >/dev/null 2>&1; then echo @@tmux; \
tmux list-sessions -F '#{session_attached} #{session_windows} #{session_created} #{session_name}' 2>/dev/null; \
else echo @@no-tmux; fi; \
if command -v screen >/dev/null 2>&1; then echo @@screen; screen -ls 2>/dev/null; \
else echo @@no-screen; fi; echo @@end";

const MAX_OUTPUT: usize = 64 * 1024;
const LIMIT: Duration = Duration::from_secs(10);
/// Longest name shown.
const MAX_SHOWN: usize = 128;
/// Longest name an attach command is built from.
const MAX_ATTACHABLE: usize = 64;

/// Runs the command on its own channel and parses the answer.
pub(crate) async fn list(conn: &VerifiedConnection) -> MultiplexerList {
    match conn.exec(COMMAND, MAX_OUTPUT, LIMIT).await {
        Ok(out) => parse(&out.stdout),
        Err(_) => MultiplexerList::NotAvailable { reason: MultiplexerUnavailable::Failed },
    }
}

/// Parses the command's standard output. Exit statuses are not used: `screen -ls` exits non-zero
/// on some versions when it lists nothing.
pub(crate) fn parse(stdout: &[u8]) -> MultiplexerList {
    let malformed = MultiplexerList::NotAvailable { reason: MultiplexerUnavailable::Malformed };
    // Lossy: a name in another encoding is still listed (and never attachable).
    let text = String::from_utf8_lossy(stdout);
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
    let marker = |name: &str| lines.iter().position(|l| *l == name);
    let (Some(tmux_at), Some(screen_at), Some(end_at)) = (
        marker("@@tmux").or_else(|| marker("@@no-tmux")),
        marker("@@screen").or_else(|| marker("@@no-screen")),
        marker("@@end"),
    ) else {
        return malformed;
    };
    if !(tmux_at < screen_at && screen_at < end_at) {
        return malformed;
    }
    let tmux_installed = lines[tmux_at] == "@@tmux";
    let screen_installed = lines[screen_at] == "@@screen";
    let mut truncated = false;
    let mut sessions = Vec::new();

    let mut tmux = 0;
    for line in &lines[tmux_at + 1..screen_at] {
        match tmux_line(line) {
            Some(_) if tmux >= MAX_MULTIPLEXER_SESSIONS => truncated = true,
            Some(session) => {
                tmux += 1;
                sessions.push(session);
            }
            // tmux prints nothing else; a name with a line break leaves fragments.
            None => truncated = true,
        }
    }
    let mut screen = 0;
    for line in &lines[screen_at + 1..end_at] {
        // Only the session lines start with a tab; the rest is screen's own text.
        if !line.starts_with('\t') {
            continue;
        }
        match screen_line(line) {
            Some(_) if screen >= MAX_MULTIPLEXER_SESSIONS => truncated = true,
            Some(session) => {
                screen += 1;
                sessions.push(session);
            }
            None => truncated = true,
        }
    }
    MultiplexerList::Listed { tmux_installed, screen_installed, sessions, truncated }
}

/// `<attached> <windows> <created> <name>`: three decimal numbers, then the rest is the name.
fn tmux_line(line: &str) -> Option<MultiplexerSession> {
    let mut parts = line.splitn(4, ' ');
    let attached: u32 = number(parts.next()?)?;
    let windows: u32 = number(parts.next()?)?;
    let created: u64 = number(parts.next()?)?;
    let raw = parts.next()?;
    if raw.is_empty() {
        return None;
    }
    Some(MultiplexerSession {
        kind: MultiplexerKind::Tmux,
        name: shown(raw),
        attached: attached > 0,
        windows: Some(windows),
        created_at: Some(created),
        attach_command: tmux_name_ok(raw).then(|| format!("tmux attach-session -t '={raw}'")),
    })
}

/// `\t<pid>.<name>\t[(<date>)\t](Attached|Detached|Multi, attached|...)`.
fn screen_line(line: &str) -> Option<MultiplexerSession> {
    let fields: Vec<&str> = line.strip_prefix('\t')?.split('\t').collect();
    let (raw, status) = match fields.as_slice() {
        [id, status] | [id, _, status] => (*id, *status),
        _ => return None,
    };
    let status = status.strip_prefix('(')?.strip_suffix(')')?;
    let (pid, _) = raw.split_once('.')?;
    number::<u32>(pid)?;
    Some(MultiplexerSession {
        kind: MultiplexerKind::Screen,
        name: shown(raw),
        attached: status.to_ascii_lowercase().contains("attached"),
        windows: None,
        created_at: None,
        attach_command: screen_id_ok(raw).then(|| format!("screen -r '{raw}'")),
    })
}

/// A plain decimal number of at most 20 digits.
fn number<T: std::str::FromStr>(text: &str) -> Option<T> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// tmux names that an attach command may name: letters, digits, `_` and `-`, not starting with
/// `-`. (tmux itself turns `.` and `:` into `_`.)
fn tmux_name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_ATTACHABLE && !name.starts_with('-') && name.bytes().all(name_char)
}

/// screen ids that an attach command may name: `<pid>.<name>`, the name of letters, digits,
/// `_`, `-` and `.`, not starting with `-` or `.`.
fn screen_id_ok(id: &str) -> bool {
    let Some((pid, name)) = id.split_once('.') else { return false };
    !pid.is_empty()
        && pid.len() <= 10
        && pid.bytes().all(|b| b.is_ascii_digit())
        && !name.is_empty()
        && name.len() <= MAX_ATTACHABLE
        && !name.starts_with(['-', '.'])
        && name.bytes().all(|b| name_char(b) || b == b'.')
}

/// The name as shown: control characters (including bidirectional overrides) removed and cut to
/// `MAX_SHOWN` characters.
fn shown(raw: &str) -> String {
    raw.chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(MAX_SHOWN)
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    fn listed(out: &str) -> (bool, bool, Vec<MultiplexerSession>, bool) {
        match parse(out.as_bytes()) {
            MultiplexerList::Listed { tmux_installed, screen_installed, sessions, truncated } => {
                (tmux_installed, screen_installed, sessions, truncated)
            }
            other => panic!("not listed: {other:?}"),
        }
    }

    fn commands(sessions: &[MultiplexerSession]) -> Vec<(&str, Option<&str>)> {
        sessions.iter().map(|s| (s.name.as_str(), s.attach_command.as_deref())).collect()
    }

    // Recorded from tmux 3.4 and screen 4.09 (names as created; `.` and `:` already replaced by tmux).
    const REAL: &str = "@@tmux\n\
        0 1 1791832383 dots_and_colons\n\
        1 3 1791832390 odd name; rm -rf ~\n\
        0 1 1791832383 work\n\
        @@screen\n\
        There are screens on:\r\n\
        \t9881.work\t(10/12/26 19:13:03)\t(Detached)\n\
        \t9883.evil;$(id)\t(10/12/26 19:13:03)\t(Attached)\n\
        2 Sockets in /run/screen/S-tyr.\r\n\
        @@end\n";

    #[test]
    fn real_output_is_listed_and_only_strict_names_get_an_attach_command() {
        let (tmux, screen, sessions, truncated) = listed(REAL);
        assert!(tmux && screen && !truncated);
        assert_eq!(
            commands(&sessions),
            vec![
                ("dots_and_colons", Some("tmux attach-session -t '=dots_and_colons'")),
                ("odd name; rm -rf ~", None),
                ("work", Some("tmux attach-session -t '=work'")),
                ("9881.work", Some("screen -r '9881.work'")),
                ("9883.evil;$(id)", None),
            ]
        );
        assert_eq!(sessions[1].windows, Some(3));
        assert!(sessions[1].attached && !sessions[0].attached);
        assert_eq!(sessions[0].created_at, Some(1_791_832_383));
        assert!(!sessions[3].attached && sessions[4].attached);
        assert_eq!((sessions[3].windows, sessions[3].created_at), (None, None));
    }

    #[test]
    fn missing_multiplexers_and_empty_lists_are_told_apart() {
        let (tmux, screen, sessions, truncated) = listed("@@no-tmux\n@@no-screen\n@@end\n");
        assert!(!tmux && !screen && sessions.is_empty() && !truncated);
        let (tmux, screen, sessions, _) = listed("@@tmux\n@@screen\nNo Sockets found in /run/screen/S-tyr.\r\n@@end\n");
        assert!(tmux && screen && sessions.is_empty());
    }

    #[test]
    fn hostile_names_are_shown_as_text_and_never_attachable() {
        let out = "@@tmux\n\
            0 1 1 -t evil\n\
            0 1 1 a'b\n\
            0 1 1 \u{1b}]0;title\u{7}x\n\
            0 1 1 \u{202e}gnp.exe\n\
            0 1 1 x\u{feff}y\n\
            0 1 1 ok-name_2\n\
            @@screen\n\
            \t1.-r\t(Detached)\n\
            \t2..hidden\t(Detached)\n\
            \t3.a b\t(Detached)\n\
            \t4.fine.name\t(Detached)\n\
            \tnotapid.x\t(Detached)\n\
            @@end\n";
        let (_, _, sessions, truncated) = listed(out);
        assert_eq!(
            commands(&sessions),
            vec![
                ("-t evil", None),
                ("a'b", None),
                ("]0;titlex", None),
                ("gnp.exe", None),
                ("x\u{feff}y", None),
                ("ok-name_2", Some("tmux attach-session -t '=ok-name_2'")),
                ("1.-r", None),
                ("2..hidden", None),
                ("3.a b", None),
                ("4.fine.name", Some("screen -r '4.fine.name'")),
            ]
        );
        assert!(truncated, "the line without a numeric pid is left out and reported");
        // Every attach command is one of the two fixed shapes over an allowed character set.
        for s in &sessions {
            if let Some(cmd) = &s.attach_command {
                assert!(cmd.bytes().all(|b| b.is_ascii_graphic() || b == b' '), "{cmd}");
                assert_eq!(cmd.matches('\'').count(), 2, "{cmd}");
            }
        }
    }

    #[test]
    fn long_names_and_long_lists_are_bounded() {
        let long = "n".repeat(300);
        let mut out = format!("@@tmux\n0 1 1 {long}\n0 1 1 {}\n", "a".repeat(64));
        for i in 0..70 {
            out.push_str(&format!("0 1 1 s{i}\n"));
        }
        out.push_str("@@screen\n@@end\n");
        let (_, _, sessions, truncated) = listed(&out);
        assert_eq!(sessions.len(), MAX_MULTIPLEXER_SESSIONS);
        assert!(truncated);
        assert_eq!(sessions[0].name.chars().count(), MAX_SHOWN);
        assert_eq!(sessions[0].attach_command, None, "over 64 characters: not attachable");
        assert!(sessions[1].attach_command.is_some(), "exactly 64 characters: attachable");
    }

    #[test]
    fn malformed_answers_are_not_listed() {
        for out in [
            "",
            "@@tmux\n@@screen\n",
            "@@screen\n@@tmux\n@@end\n",
            "something else entirely\n",
            "@@end\n@@tmux\n@@screen\n",
        ] {
            assert_eq!(
                parse(out.as_bytes()),
                MultiplexerList::NotAvailable { reason: MultiplexerUnavailable::Malformed },
                "{out:?}"
            );
        }
        // A broken tmux line is left out and reported, the rest kept.
        let (_, _, sessions, truncated) = listed("@@tmux\nx 1 1 bad\n0 1 1 good\n@@no-screen\n@@end\n");
        assert_eq!(commands(&sessions), vec![("good", Some("tmux attach-session -t '=good'"))]);
        assert!(truncated);
    }

    #[test]
    fn the_command_is_fixed_and_names_nothing_from_outside() {
        assert!(COMMAND.contains("tmux list-sessions -F"));
        assert!(COMMAND.contains("screen -ls"));
        assert!(!COMMAND.contains('$'), "no expansion of anything");
    }
}

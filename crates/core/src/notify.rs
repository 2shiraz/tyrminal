//! Command-finished notifications (P-23). The text is built here from validated fields only: the
//! tab's title (the user's own label or a sanitized remote title), the exit status and the
//! duration. Command text and output never reach a notification, because operating systems keep
//! notification history and commands can carry secrets.

use tyrminal_contracts::IpcError;

const MAX_TITLE_CHARS: usize = 80;

fn is_deceptive(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}' | '\u{FEFF}')
}

fn duration_text(ms: u64) -> String {
    // To the nearest second: the two marks are timed as they arrive, a few milliseconds apart
    // from the shell's own clock, so a 4 s command can measure 3 999 ms.
    let s = (ms + 500) / 1000;
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min {} s", s / 60, s % 60),
        _ => format!("{} h {:02} min", s / 3600, (s % 3600) / 60),
    }
}

/// `(title, body)` for a command that finished in the tab titled `tab_title`.
pub fn command_finished_notice(
    tab_title: &str,
    exit_status: Option<i32>,
    duration_ms: u64,
) -> Result<(String, String), IpcError> {
    let cleaned: String = tab_title.chars().filter(|c| !is_deceptive(*c)).collect();
    let cleaned = cleaned.trim();
    let mut title: String = cleaned.chars().take(MAX_TITLE_CHARS).collect();
    if cleaned.chars().count() > MAX_TITLE_CHARS {
        title.push('…');
    }
    if title.is_empty() {
        title = "Tyrminal".to_owned();
    }
    let took = duration_text(duration_ms);
    let body = match exit_status {
        Some(0) => format!("Command finished successfully after {took}."),
        Some(code) => format!("Command failed with exit status {code} after {took}."),
        None => format!("Command finished after {took}."),
    };
    Ok((title, body))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::command_finished_notice;

    #[test]
    fn text_has_title_status_and_duration_only() {
        assert_eq!(
            command_finished_notice("prod-db", Some(0), 12_400).unwrap(),
            ("prod-db".to_owned(), "Command finished successfully after 12 s.".to_owned())
        );
        assert_eq!(
            command_finished_notice("api", Some(2), 192_000).unwrap().1,
            "Command failed with exit status 2 after 3 min 12 s."
        );
        assert_eq!(command_finished_notice("api", None, 3_900_000).unwrap().1, "Command finished after 1 h 05 min.");
        assert_eq!(command_finished_notice("api", None, 3_996).unwrap().1, "Command finished after 4 s.");
        assert_eq!(command_finished_notice("api", None, 4_499).unwrap().1, "Command finished after 4 s.");
    }

    #[test]
    fn titles_are_display_safe_and_bounded() {
        let (title, _) = command_finished_notice("\u{1b}]0;x\u{7}evil\u{202e}gnp.exe", Some(0), 1).unwrap();
        assert!(!title.chars().any(|c| c.is_control() || c == '\u{202e}'), "{title:?}");
        assert_eq!(command_finished_notice("   ", Some(0), 1).unwrap().0, "Tyrminal");
        let long = "x".repeat(200);
        assert_eq!(command_finished_notice(&long, Some(0), 1).unwrap().0.chars().count(), 81);
    }
}

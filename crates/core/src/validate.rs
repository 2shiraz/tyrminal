//! Native validation of renderer-supplied values. TypeScript types are not a security boundary;
//! everything is checked again here before it is stored or used (spec §4.6).

use tyrminal_contracts::IpcError;
use tyrminal_contracts::limits::{
    MAX_ADDRESS_LEN, MAX_FOLDER_LEN, MAX_LABEL_LEN, MAX_LINK_LEN, MAX_REASON_LEN, MAX_SECRET_LEN, MAX_SNIPPET_LEN,
    MAX_TAG_LEN, MAX_TAGS_PER_HOST, MAX_USERNAME_LEN,
};
use tyrminal_vault::Id;

use crate::error::invalid;

/// Characters that are never acceptable in a stored display string: C0/C1 controls (including
/// ESC, so labels cannot smuggle terminal sequences) and the bidirectional override/isolate
/// controls used to disguise text.
fn is_deceptive(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}' | '\u{FEFF}')
}

pub(crate) fn label(value: &str) -> Result<String, IpcError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(invalid("Enter a name."));
    }
    if trimmed.len() > MAX_LABEL_LEN {
        return Err(invalid("The name is too long (256 bytes at most)."));
    }
    if trimmed.chars().any(is_deceptive) {
        return Err(invalid("The name contains control or invisible characters."));
    }
    Ok(trimmed.to_owned())
}

/// A DNS name or IP literal. Deliberately strict about shape and silent about reachability:
/// private and LAN addresses are legitimate destinations.
pub(crate) fn address(value: &str) -> Result<String, IpcError> {
    let trimmed = value.trim();
    let bare = trimmed.strip_prefix('[').and_then(|v| v.strip_suffix(']')).unwrap_or(trimmed);
    if bare.is_empty() {
        return Err(invalid("Enter the server's address."));
    }
    if bare.len() > MAX_ADDRESS_LEN {
        return Err(invalid("The address is too long."));
    }
    if bare.parse::<std::net::IpAddr>().is_ok() {
        return Ok(bare.to_owned());
    }
    // Host name: letters, digits, hyphen, dot and underscore, plus non-ASCII letters for IDNs.
    // No whitespace, slashes, `@`, `:` or anything a URL or shell could reinterpret.
    let ok = bare.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '.' | '_'))
        && !bare.starts_with(['-', '.'])
        && !bare.contains("..");
    if !ok {
        return Err(invalid("The address must be a host name or an IP address, without a scheme, user or path."));
    }
    Ok(bare.to_owned())
}

/// A host's protocol as stored (serial line settings checked; the device itself at connect).
pub(crate) fn protocol(value: tyrminal_contracts::HostProtocol) -> Result<tyrminal_contracts::HostProtocol, IpcError> {
    if let tyrminal_contracts::HostProtocol::Serial { settings } = &value {
        crate::serial::validate_line(settings)?;
    }
    Ok(value)
}

pub(crate) fn port(value: u16) -> Result<u16, IpcError> {
    if value == 0 { Err(invalid("The port must be between 1 and 65535.")) } else { Ok(value) }
}

pub(crate) fn username(value: &str) -> Result<String, IpcError> {
    if value.is_empty() {
        return Err(invalid("Enter the user name."));
    }
    if value.len() > MAX_USERNAME_LEN {
        return Err(invalid("The user name is too long."));
    }
    // A leading hyphen could be read as an option by tools the name is later passed to.
    if value.chars().any(|c| is_deceptive(c) || c.is_whitespace()) || value.starts_with('-') {
        return Err(invalid("The user name contains spaces or characters that are not allowed."));
    }
    Ok(value.to_owned())
}

pub(crate) fn secret(value: &str) -> Result<(), IpcError> {
    if value.is_empty() {
        return Err(invalid("Enter the password."));
    }
    if value.len() > MAX_SECRET_LEN {
        return Err(invalid("That is too long (1024 bytes at most)."));
    }
    Ok(())
}

pub(crate) fn reason(value: &str) -> Result<String, IpcError> {
    let trimmed = value.trim();
    if trimmed.len() < 3 {
        return Err(invalid("Describe why the server's key is expected to have changed."));
    }
    if trimmed.len() > MAX_REASON_LEN || trimmed.chars().any(|c| is_deceptive(c) && c != '\n') {
        return Err(invalid("The reason is too long or contains control characters."));
    }
    Ok(trimmed.to_owned())
}

/// Snippet folder path: `/`-separated segments, each a valid label; empty means top level.
pub(crate) fn folder(value: &str) -> Result<String, IpcError> {
    let trimmed = value.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > MAX_FOLDER_LEN {
        return Err(invalid("The folder path is too long (256 bytes at most)."));
    }
    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        let segment = segment.trim();
        if segment.is_empty() || segment.chars().any(is_deceptive) {
            return Err(invalid("Folder names cannot be empty or contain control characters."));
        }
        segments.push(segment);
    }
    Ok(segments.join("/"))
}

/// Host tags: trimmed, case-insensitively de-duplicated (first spelling kept), sorted, bounded.
/// Commas separate tags in the UI, so a tag cannot contain one.
pub(crate) fn tags(values: &[String]) -> Result<Vec<String>, IpcError> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let tag = value.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.len() > MAX_TAG_LEN {
            return Err(invalid("A tag is too long (32 bytes at most)."));
        }
        if tag.chars().any(|c| is_deceptive(c) || c == ',') {
            return Err(invalid("Tags cannot contain commas or control characters."));
        }
        if !out.iter().any(|t| t.to_lowercase() == tag.to_lowercase()) {
            out.push(tag.to_owned());
        }
    }
    if out.len() > MAX_TAGS_PER_HOST {
        return Err(invalid("A host can have 16 tags at most."));
    }
    out.sort_by_key(|t| t.to_lowercase());
    Ok(out)
}

/// Snippet command text. Multi-line is allowed (tabs and newlines); other control characters,
/// including ESC, are not: a snippet is something the user types, not a terminal sequence.
pub(crate) fn snippet_text(value: &str) -> Result<String, IpcError> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.trim().is_empty() {
        return Err(invalid("Enter the command text."));
    }
    if normalized.len() > MAX_SNIPPET_LEN {
        return Err(invalid("The snippet is too long (64 KiB at most)."));
    }
    if normalized.chars().any(|c| is_deceptive(c) && c != '\n' && c != '\t') {
        return Err(invalid("The snippet contains control or invisible characters."));
    }
    Ok(normalized)
}

/// A note's text (P-30): line breaks normalized, at most `MAX_NOTE_LEN`, no control or invisible
/// characters except newline and tab. `None`: the note is empty (deleting it).
pub(crate) fn note_text(value: &str) -> Result<Option<String>, IpcError> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.trim().is_empty() {
        return Ok(None);
    }
    if normalized.len() > tyrminal_contracts::limits::MAX_NOTE_LEN {
        return Err(invalid("The note is too long (64 KiB at most)."));
    }
    if normalized.chars().any(|c| is_deceptive(c) && c != '\n' && c != '\t') {
        return Err(invalid("The note contains control or invisible characters."));
    }
    Ok(Some(normalized))
}

/// A link the user asked to open from terminal output: `http`/`https` only, no embedded
/// credentials (a classic way to disguise the real destination), no whitespace or controls.
/// Returns the URL exactly as validated, which is what the confirmation showed.
pub(crate) fn link(value: &str) -> Result<String, IpcError> {
    let bad = || invalid("Only web links (http and https) can be opened.");
    if value.is_empty() || value.len() > MAX_LINK_LEN || value.chars().any(|c| c.is_whitespace() || is_deceptive(c)) {
        return Err(bad());
    }
    let lower = value.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")).ok_or_else(bad)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return Err(bad());
    }
    Ok(value.to_owned())
}

pub(crate) fn id(value: &str) -> Result<Id, IpcError> {
    let bytes = value.as_bytes();
    if bytes.len() != 32 {
        return Err(invalid("That identifier is not valid."));
    }
    let mut out = [0u8; 16];
    for (i, pair) in bytes.as_chunks::<2>().0.iter().enumerate() {
        let hi = (pair[0] as char).to_digit(16);
        let lo = (pair[1] as char).to_digit(16);
        match (hi, lo) {
            (Some(hi), Some(lo)) if !pair[0].is_ascii_uppercase() && !pair[1].is_ascii_uppercase() => {
                out[i] = (hi * 16 + lo) as u8;
            }
            _ => return Err(invalid("That identifier is not valid.")),
        }
    }
    Ok(out)
}

pub(crate) fn id_text(id: &Id) -> String {
    use core::fmt::Write;
    id.iter().fold(String::with_capacity(32), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Most environment variables one host or group sends.
const MAX_ENV_VARS: usize = 64;
const MAX_ENV_VALUE: usize = 4096;

/// Environment variables for a host or group: portable names (`[A-Za-z_][A-Za-z0-9_]*`, 64
/// bytes at most, each once), values without control characters other than tab.
pub(crate) fn env_vars(vars: &[tyrminal_contracts::EnvVar]) -> Result<Vec<(String, String)>, IpcError> {
    if vars.len() > MAX_ENV_VARS {
        return Err(invalid("At most 64 environment variables per host or group."));
    }
    let mut out: Vec<(String, String)> = Vec::with_capacity(vars.len());
    for var in vars {
        let name = var.name.trim();
        let mut bytes = name.bytes();
        let valid = name.len() <= 64
            && bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !valid {
            return Err(invalid("Variable names use letters, digits and _, and do not start with a digit."));
        }
        if out.iter().any(|(n, _)| n == name) {
            return Err(invalid("Each variable name can appear only once."));
        }
        // One line of visible text: no control characters (tab and ESC included) and no
        // bidirectional or zero-width characters that make the editor show a different value
        // than the server receives.
        if var.value.len() > MAX_ENV_VALUE || var.value.chars().any(is_deceptive) {
            return Err(invalid(
                "Variable values are at most 4096 bytes, on one line, without control or invisible characters.",
            ));
        }
        out.push((name.to_owned(), var.value.clone()));
    }
    Ok(out)
}

/// A startup list (SNP-08): at most `MAX_STARTUP_SNIPPETS` snippet ids, each once.
pub(crate) fn startup_snippet_ids(ids: &[String]) -> Result<Vec<String>, IpcError> {
    if ids.len() > tyrminal_contracts::limits::MAX_STARTUP_SNIPPETS {
        return Err(invalid("Choose 16 startup snippets at most."));
    }
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id_text(&self::id(id)?);
        if out.contains(&id) {
            return Err(invalid("A startup snippet is listed twice."));
        }
        out.push(id);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_reject_control_and_bidi_characters() {
        assert_eq!(label("  prod db  ").unwrap(), "prod db");
        assert_eq!(label("Büro-サーバー 🖥").unwrap(), "Büro-サーバー 🖥");
        for bad in ["", "   ", "a\u{1b}[31mred", "a\nb", "safe\u{202E}gnp.exe", "zero\u{200B}width", &"x".repeat(257)] {
            assert!(label(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn addresses_are_hosts_or_ip_literals_only() {
        for good in [
            "example.com",
            "db-1.internal",
            "192.168.1.10",
            "10.0.0.1",
            "::1",
            "[2001:db8::1]",
            "bücher.example",
            "host_name",
        ] {
            assert!(address(good).is_ok(), "{good:?}");
        }
        assert_eq!(address("[::1]").unwrap(), "::1");
        for bad in [
            "",
            "ssh://example.com",
            "user@example.com",
            "example.com:22",
            "example.com/path",
            "a b",
            "-oProxyCommand=x",
            "a..b",
            ".example",
            "exa\u{202E}mple.com",
            "host;rm -rf",
            "$(id)",
            "`id`",
            "a\tb",
            &"a".repeat(254),
        ] {
            assert!(address(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn usernames_reject_spaces_controls_and_leading_hyphen() {
        for good in ["root", "deploy.user", "DOMAIN\\user", "user@realm", "ユーザー"] {
            assert!(username(good).is_ok(), "{good:?}");
        }
        for bad in ["", "-oProxyCommand=evil", "a b", "a\nb", "a\u{1b}b", &"u".repeat(256)] {
            assert!(username(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ids_are_exactly_32_lowercase_hex_characters() {
        let raw: Id = core::array::from_fn(|i| (i * 17) as u8);
        let text = id_text(&raw);
        assert_eq!(text.len(), 32);
        assert_eq!(id(&text).unwrap(), raw);
        for bad in [
            "",
            "abc",
            &text[..31],
            &format!("{text}0"),
            &text.to_uppercase(),
            "zz000000000000000000000000000000",
            "../../../../etc/passwd/aaaaaaaaaa",
        ] {
            assert!(id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn folders_are_normalized_label_paths() {
        assert_eq!(folder("").unwrap(), "");
        assert_eq!(folder(" /Deploy / Staging/ ").unwrap(), "Deploy/Staging");
        for bad in ["a//b", "a/\u{1b}b", &"f".repeat(257)] {
            assert!(folder(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn env_values_are_one_visible_line() {
        let var = |name: &str, value: &str| tyrminal_contracts::EnvVar { name: name.into(), value: value.into() };
        assert_eq!(env_vars(&[var("A", "")]).unwrap(), [("A".to_owned(), String::new())]);
        let ok = "a b=c;$(d) 'é' ✓";
        assert_eq!(env_vars(&[var("A", ok)]).unwrap()[0].1, ok);
        let long = "x".repeat(MAX_ENV_VALUE + 1);
        for bad in [
            "a\tb",
            "a\nb",
            "a\rb",
            "\u{1b}[31m",
            "a\u{0}b",
            "\u{9b}",
            "a\u{202e}b",
            "a\u{2067}b",
            "\u{200b}",
            "\u{feff}x",
            &long,
        ] {
            assert!(env_vars(&[var("A", bad)]).is_err(), "{bad:?}");
        }
        for bad in ["", "9A", "A-B", "A=B", "A B", "Ä", "$A"] {
            assert!(env_vars(&[var(bad, "v")]).is_err(), "{bad:?}");
        }
        assert!(env_vars(&[var("A", "1"), var("A", "2")]).is_err(), "duplicate names");
    }

    #[test]
    fn startup_lists_are_bounded_well_formed_and_free_of_duplicates() {
        let a = "0".repeat(32);
        let b = "1".repeat(32);
        assert_eq!(startup_snippet_ids(&[a.clone(), b.clone()]).unwrap(), [a.clone(), b]);
        assert!(startup_snippet_ids(&[]).unwrap().is_empty());
        assert!(startup_snippet_ids(&[a.clone(), a.clone()]).is_err());
        assert!(startup_snippet_ids(&["not an id".into()]).is_err());
        assert!(startup_snippet_ids(&["A".repeat(32)]).is_err(), "ids are lower-case hex");
        let many: Vec<String> = (0..17).map(|i| format!("{i:032x}")).collect();
        assert!(startup_snippet_ids(&many).is_err());
        assert_eq!(startup_snippet_ids(&many[..16]).unwrap().len(), 16);
    }

    #[test]
    fn snippet_text_allows_lines_and_tabs_but_not_escape_sequences() {
        assert_eq!(snippet_text("ls -la\r\n\tdf -h\r").unwrap(), "ls -la\n\tdf -h\n");
        for bad in ["", "  \n ", "printf '\u{1b}]52;c;AAAA\u{7}'", "echo \u{202E}evil", &"x".repeat(64 * 1024 + 1)] {
            assert!(snippet_text(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn note_text_keeps_lines_and_refuses_controls() {
        assert_eq!(note_text("# Box\r\n\tport 22\r").unwrap().as_deref(), Some("# Box\n\tport 22\n"));
        assert_eq!(note_text(" \n\t ").unwrap(), None);
        for bad in ["a\u{1b}[31m", "x\u{7}", "look \u{202E}here", "zero\u{200B}width", &"x".repeat(64 * 1024 + 1)] {
            assert!(note_text(bad).is_err(), "{bad:?}");
        }
        assert!(note_text(&"x".repeat(64 * 1024)).is_ok());
    }

    #[test]
    fn links_are_plain_http_or_https_without_credentials() {
        for good in ["https://example.com", "http://10.0.0.1:8080/a?b=c#d", "HTTPS://Example.com/Path"] {
            assert_eq!(link(good).unwrap(), good);
        }
        for bad in [
            "",
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "ssh://host",
            "vscode://x",
            "https://bank.example@evil.example/",
            "https://evil.example\\@bank.example",
            "https://a b",
            "https://ex\u{202E}moc.ample",
            "https:///path",
            "https://",
            &format!("https://e.com/{}", "a".repeat(2048)),
        ] {
            assert!(link(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ports_secrets_and_reasons_are_bounded() {
        assert!(port(0).is_err() && port(1).is_ok() && port(65535).is_ok());
        assert!(secret("").is_err() && secret("x").is_ok() && secret(&"p".repeat(1025)).is_err());
        assert!(reason("  ").is_err() && reason("ok").is_err() && reason("server was reinstalled").is_ok());
        assert!(reason(&"r".repeat(501)).is_err());
    }
}

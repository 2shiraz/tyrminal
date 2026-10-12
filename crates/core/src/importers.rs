//! Importers for other SSH clients' saved sessions: PuTTY (registry export), MobaXterm (`.ini` /
//! `.mxtsessions`) and SecureCRT (XML export or a session `.ini`).
//!
//! Same contract as `import.rs`: the text of a file the user picked is read as data only. Nothing
//! in it is run, opened, followed or decrypted; stored passwords (encrypted or not) are never
//! imported, and key files they name are not read. Every host goes through the same validation as
//! a host typed into the editor, the result is a preview, and nothing is written until the user
//! confirms it.

use std::borrow::Cow;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use tyrminal_contracts::limits::MAX_IMPORT_HOSTS;
use tyrminal_contracts::{ImportHost, IpcError};

use crate::error::invalid;
use crate::import::{Parsed, check_size, checked};

const TOO_MANY: &str = "The file defines more hosts than one import allows (10,000).";
const PASSWORD_NOTE: &str = "Its stored password was not imported. Tyrminal asks for it on first connection.";
const PORT_FORWARD_NOTE: &str = "Port forwarding rules were not imported.";
const PROXY_NOTE: &str = "A proxy or jump host was configured and was not imported.";

fn key_note(file: &str) -> String {
    let name = file.rsplit(['\\', '/']).next().unwrap_or(file);
    format!(
        "Uses the key file {name}, which was not read. Import that key in the keychain and choose it for this host."
    )
}

/// Adds a candidate host, or a skipped entry with the validation reason.
fn add(out: &mut Parsed, line: usize, shown: &str, host: ImportHost) -> Result<(), IpcError> {
    if out.hosts.len() >= MAX_IMPORT_HOSTS {
        return Err(invalid(TOO_MANY));
    }
    match checked(host) {
        Ok(host) => out.hosts.push(host),
        Err(reason) => out.skip(line, shown, &reason),
    }
    Ok(())
}

/// `user@host` in a host field (PuTTY and SecureCRT accept it) split into its parts.
fn split_user(address: &str, user: &str) -> (String, String) {
    match address.rsplit_once('@') {
        Some((u, h)) if user.is_empty() && !u.is_empty() => (h.to_owned(), u.to_owned()),
        _ => (address.to_owned(), user.to_owned()),
    }
}

// ---------- PuTTY ----------

const PUTTY_SESSIONS: &str = "\\software\\simontatham\\putty\\sessions\\";

/// A `.reg` string value: `"..."` with `\\` and `\"` escapes.
fn reg_string(raw: &str) -> Option<String> {
    let inner = raw.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            out.push(chars.next()?);
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// PuTTY stores session names percent-encoded.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[derive(Default)]
struct PuttySession {
    line: usize,
    name: String,
    host: String,
    port: Option<u32>,
    user: String,
    protocol: String,
    key_file: String,
    forwards: bool,
    proxy: bool,
}

/// A `.reg` export of `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions` (`regedit` or
/// `reg export`). Only SSH sessions become hosts; their key files and tunnels are reported.
pub(crate) fn parse_putty_reg(text: &str) -> Result<Parsed, IpcError> {
    check_size(text)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines().enumerate().peekable();
    match lines.peek().map(|(_, l)| l.trim()) {
        Some("Windows Registry Editor Version 5.00" | "REGEDIT4") => {}
        _ => return Err(invalid("This is not a registry export (.reg) file.")),
    }
    let mut out = Parsed::default();
    let mut sessions: Vec<PuttySession> = Vec::new();
    let mut current: Option<usize> = None;
    let mut ignored_keys = 0usize;

    while let Some((index, raw)) = lines.next() {
        let number = index + 1;
        // Values continue onto the next line after a trailing backslash (long hex values).
        let mut line = raw.trim().to_owned();
        while line.ends_with('\\') {
            line.pop();
            match lines.next() {
                Some((_, more)) => line.push_str(more.trim()),
                None => break,
            }
        }
        if line.is_empty() || line.starts_with(';') || index == 0 {
            continue;
        }
        if let Some(key) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = None;
            let lower = key.to_lowercase();
            let Some(at) = lower.find(PUTTY_SESSIONS) else {
                ignored_keys += 1;
                continue;
            };
            if key.starts_with('-') {
                continue;
            }
            let encoded = &key[at + PUTTY_SESSIONS.len()..];
            if encoded.contains('\\') {
                continue;
            }
            let Some(name) = percent_decode(encoded) else {
                out.skip(number, encoded, "session name is not valid text");
                continue;
            };
            if name == "Default Settings" {
                out.skip(number, &name, "PuTTY's defaults for new sessions; not a host");
                continue;
            }
            if sessions.len() >= MAX_IMPORT_HOSTS {
                return Err(invalid(TOO_MANY));
            }
            sessions.push(PuttySession { line: number, name, protocol: "ssh".into(), ..PuttySession::default() });
            current = Some(sessions.len() - 1);
            continue;
        }
        let Some(session) = current.and_then(|i| sessions.get_mut(i)) else { continue };
        let Some((name, value)) = line.split_once('=') else { continue };
        let Some(name) = reg_string(name) else { continue };
        let string = || reg_string(value).unwrap_or_default();
        match name.as_str() {
            "HostName" => session.host = string(),
            "UserName" => session.user = string(),
            "Protocol" => session.protocol = string().to_lowercase(),
            "PublicKeyFile" => session.key_file = string(),
            "PortForwardings" => session.forwards = !string().is_empty(),
            "ProxyMethod" => {
                session.proxy = value.strip_prefix("dword:").is_some_and(|v| !v.trim_start_matches('0').is_empty())
            }
            "PortNumber" => {
                session.port = value.strip_prefix("dword:").and_then(|v| u32::from_str_radix(v, 16).ok());
            }
            _ => {}
        }
    }
    if ignored_keys > 0 && sessions.is_empty() {
        return Err(invalid("The file does not contain PuTTY sessions (Software\\SimonTatham\\PuTTY\\Sessions)."));
    }

    for s in sessions {
        let shown = format!("[{}]", s.name);
        if s.protocol != "ssh" {
            out.skip(s.line, &shown, &format!("{} session; only SSH sessions are imported", s.protocol));
            continue;
        }
        if s.host.is_empty() {
            out.skip(s.line, &shown, "no host name");
            continue;
        }
        let Some(port) = s.port.map_or(Some(22), |p| u16::try_from(p).ok()) else {
            out.skip(s.line, &shown, "port is not a number from 1 to 65535");
            continue;
        };
        let (address, username) = split_user(&s.host, &s.user);
        let mut notes = Vec::new();
        if !s.key_file.is_empty() {
            notes.push(key_note(&s.key_file));
        }
        if s.forwards {
            notes.push(PORT_FORWARD_NOTE.into());
        }
        if s.proxy {
            notes.push(PROXY_NOTE.into());
        }
        let host = ImportHost {
            label: s.name,
            address,
            port,
            username,
            group: String::new(),
            tags: Vec::new(),
            notes,
            jump_via: None,
        };
        add(&mut out, s.line, &shown, host)?;
    }
    Ok(out)
}

// ---------- MobaXterm ----------

/// MobaXterm session types (the number after the icon in a bookmark).
fn moba_type(code: &str) -> &'static str {
    match code {
        "0" => "SSH",
        "1" => "Telnet",
        "2" => "Rlogin",
        "3" => "RDP",
        "4" => "VNC",
        "5" => "FTP",
        "6" => "SFTP",
        "7" => "Serial",
        "8" => "File",
        "9" => "Shell",
        "10" => "Browser",
        "11" => "Mosh",
        "12" => "S3",
        "13" => "WSL",
        _ => "unknown",
    }
}

/// `MobaXterm.ini` or an exported `.mxtsessions` file. Sessions are in `[Bookmarks]` and
/// `[Bookmarks_N]` sections whose `SubRep` is the folder; a session line is
/// `name=#icon#type%host%port%user%...`. SSH and SFTP sessions become hosts.
pub(crate) fn parse_mobaxterm(text: &str) -> Result<Parsed, IpcError> {
    check_size(text)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Parsed::default();
    let mut section = String::new();
    let mut folder = String::new();
    let mut saw_bookmarks = false;
    let mut passwords_reported = false;
    let mut candidates = 0usize;

    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = name.to_lowercase();
            folder.clear();
            if section == "bookmarks" || section.starts_with("bookmarks_") {
                saw_bookmarks = true;
            }
            if matches!(section.as_str(), "passwords" | "credentials") && !passwords_reported {
                passwords_reported = true;
                out.skip(number, name, "stored passwords and credentials are never imported");
            }
            continue;
        }
        if !(section == "bookmarks" || section.starts_with("bookmarks_")) {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else { continue };
        match name {
            "SubRep" => {
                folder = value.split('\\').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/");
                continue;
            }
            "ImgNum" => continue,
            _ => {}
        }
        // `#icon#type%host%port%user%...#terminal settings#...`
        let mut parts = value.split('#');
        let (Some(""), Some(_icon), Some(connection)) = (parts.next(), parts.next(), parts.next()) else {
            out.skip(number, name, "not a session line");
            continue;
        };
        candidates += 1;
        if candidates > MAX_IMPORT_HOSTS {
            return Err(invalid(TOO_MANY));
        }
        let fields: Vec<&str> = connection.split('%').collect();
        let kind = moba_type(fields.first().copied().unwrap_or_default());
        if !matches!(kind, "SSH" | "SFTP") {
            out.skip(number, name, &format!("{kind} session; only SSH and SFTP sessions are imported"));
            continue;
        }
        let host = fields.get(1).copied().unwrap_or_default();
        if host.is_empty() {
            out.skip(number, name, "no host name");
            continue;
        }
        let Ok(port) = fields.get(2).copied().filter(|p| !p.is_empty()).unwrap_or("22").parse::<u16>() else {
            out.skip(number, name, "port is not a number from 1 to 65535");
            continue;
        };
        let (address, username) = split_user(host, fields.get(3).copied().unwrap_or_default());
        let mut notes = Vec::new();
        if kind == "SFTP" {
            notes.push(
                "Was an SFTP session in MobaXterm; imported as an SSH host (open its files from a session).".into(),
            );
        }
        if let Some(key) = fields.iter().find(|f| {
            let lower = f.to_lowercase();
            lower.ends_with(".ppk") || lower.ends_with(".pem") || lower.contains("_profiledir_")
        }) {
            notes.push(key_note(key));
        }
        let host = ImportHost {
            label: name.trim().to_owned(),
            address,
            port,
            username,
            group: folder.clone(),
            tags: Vec::new(),
            notes,
            jump_via: None,
        };
        add(&mut out, number, name, host)?;
    }
    if !saw_bookmarks {
        return Err(invalid("The file has no MobaXterm sessions ([Bookmarks] sections)."));
    }
    Ok(out)
}

// ---------- SecureCRT ----------

/// Nested `<key>` levels in a SecureCRT export; deeper documents are refused.
const MAX_XML_DEPTH: usize = 64;
/// XML elements read from one export.
const MAX_XML_ELEMENTS: usize = 1_000_000;

#[derive(Default)]
struct CrtSession {
    line: usize,
    path: Vec<String>,
    host: Option<String>,
    port: Option<u32>,
    user: String,
    protocol: Option<String>,
    password: bool,
    key_file: String,
    forwards: bool,
    firewall: bool,
}

impl CrtSession {
    fn set(&mut self, name: &str, value: &str) {
        match name {
            "Hostname" => self.host = Some(value.trim().to_owned()),
            "Username" => self.user = value.trim().to_owned(),
            "Protocol Name" => self.protocol = Some(value.trim().to_owned()),
            "[SSH2] Port" => self.port = value.trim().parse().ok(),
            "Password" | "Password V2" | "Session Password Saved" => {
                self.password |= !value.trim().is_empty() && value.trim() != "00000000";
            }
            "Identity Filename" | "Identity Filename V2" => self.key_file = value.trim().to_owned(),
            "Port Forward Table V2" | "Reverse Forward Table V2" => {
                self.forwards |= value.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("0"));
            }
            "Firewall Name" => self.firewall = !matches!(value.trim(), "" | "None"),
            _ => {}
        }
    }
}

fn finish_crt(out: &mut Parsed, s: CrtSession) -> Result<(), IpcError> {
    let label = s.path.last().cloned().unwrap_or_default();
    let shown = s.path.join("/");
    let protocol = s.protocol.unwrap_or_else(|| "SSH2".into());
    if label == "Default" && s.path.len() == 1 {
        out.skip(s.line, &shown, "SecureCRT's defaults for new sessions; not a host");
        return Ok(());
    }
    if !protocol.eq_ignore_ascii_case("SSH2") {
        let why = if protocol.eq_ignore_ascii_case("SSH1") {
            "SSH1 session; the SSH1 protocol is insecure and not supported".to_owned()
        } else {
            format!("{protocol} session; only SSH2 sessions are imported")
        };
        out.skip(s.line, &shown, &why);
        return Ok(());
    }
    let Some(host) = s.host.filter(|h| !h.is_empty()) else {
        out.skip(s.line, &shown, "no host name");
        return Ok(());
    };
    let Some(port) = s.port.map_or(Some(22), |p| u16::try_from(p).ok()) else {
        out.skip(s.line, &shown, "port is not a number from 1 to 65535");
        return Ok(());
    };
    let (address, username) = split_user(&host, &s.user);
    let mut notes = Vec::new();
    if s.password {
        notes.push(PASSWORD_NOTE.into());
    }
    if !s.key_file.is_empty() {
        notes.push(key_note(&s.key_file));
    }
    if s.forwards {
        notes.push(PORT_FORWARD_NOTE.into());
    }
    if s.firewall {
        notes.push(PROXY_NOTE.into());
    }
    let group = s.path[..s.path.len().saturating_sub(1)].join("/");
    let label = if label.is_empty() { address.clone() } else { label };
    add(
        out,
        s.line,
        &shown,
        ImportHost { label, address, port, username, group, tags: Vec::new(), notes, jump_via: None },
    )
}

fn name_attr(start: &BytesStart<'_>) -> Result<Option<String>, IpcError> {
    let bad = || invalid("The XML file is not valid.");
    match start.try_get_attribute("name").map_err(|_| bad())? {
        Some(attr) => {
            Ok(Some(attr.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|_| bad())?.into_owned()))
        }
        None => Ok(None),
    }
}

/// SecureCRT's "Export Settings" XML (`<VanDyke><key name="Sessions">…`). Sessions are `<key>`
/// elements with connection values; the keys around them are folders. A DOCTYPE (and with it any
/// entity definition) is refused outright, and entity references other than the five predefined
/// ones and character references are errors, so nothing outside the file is ever read.
fn parse_securecrt_xml(text: &str) -> Result<Parsed, IpcError> {
    let bad = || invalid("The XML file is not valid.");
    let mut out = Parsed::default();
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    // Names of the open <key> elements, outermost first.
    let mut keys: Vec<String> = Vec::new();
    // Index in `keys` of the "Sessions" key, once inside it.
    let mut sessions_at: Option<usize> = None;
    // A session being read, at its depth in `keys`.
    let mut open: Vec<(usize, CrtSession)> = Vec::new();
    let mut value: Option<(String, String)> = None;
    let mut elements = 0usize;
    let mut found_sessions = false;

    // Line numbers for the preview, counted incrementally (never rescanning from the start).
    let (mut line, mut counted) = (1usize, 0usize);
    loop {
        let position = usize::try_from(reader.buffer_position()).unwrap_or(usize::MAX).min(text.len());
        if position > counted {
            line += text.as_bytes()[counted..position].iter().filter(|b| **b == b'\n').count();
            counted = position;
        }
        let event = reader.read_event().map_err(|_| bad())?;
        elements += 1;
        if elements > MAX_XML_ELEMENTS {
            return Err(invalid("The XML file is too complex to import."));
        }
        match event {
            Event::DocType(_) => {
                return Err(invalid("XML files with a DOCTYPE are not imported (they can refer to other files)."));
            }
            Event::Start(start) if start.name().as_ref() == "key" => {
                let name = name_attr(&start)?.ok_or_else(bad)?;
                keys.push(name);
                if keys.len() > MAX_XML_DEPTH {
                    return Err(invalid("The XML file is nested too deeply to import."));
                }
                if sessions_at.is_none() && keys.last().is_some_and(|k| k == "Sessions") && keys.len() <= 2 {
                    sessions_at = Some(keys.len() - 1);
                    found_sessions = true;
                } else if let Some(at) = sessions_at {
                    let path = keys[at + 1..].to_vec();
                    open.push((keys.len(), CrtSession { line, path, ..CrtSession::default() }));
                }
            }
            Event::Empty(start) if start.name().as_ref() == "key" => {}
            Event::End(end) if end.name().as_ref() == "key" => {
                if let Some((depth, _)) = open.last()
                    && *depth == keys.len()
                    && let Some((_, session)) = open.pop()
                    && (session.host.is_some() || session.protocol.is_some())
                {
                    if out.hosts.len() + out.skipped.len() > MAX_IMPORT_HOSTS {
                        return Err(invalid(TOO_MANY));
                    }
                    finish_crt(&mut out, session)?;
                }
                if sessions_at == Some(keys.len().saturating_sub(1)) {
                    sessions_at = None;
                }
                keys.pop();
            }
            Event::Start(start) => {
                // A value element (<string>, <dword>, <array>...): collect its text.
                if let Some(name) = name_attr(&start)? {
                    value = Some((name, String::new()));
                }
            }
            Event::Text(t) => {
                if let Some((_, v)) = value.as_mut() {
                    v.push_str(&t.xml10_content());
                    if v.len() > 64 * 1024 {
                        return Err(invalid("A value in the XML file is too long."));
                    }
                }
            }
            Event::CData(c) => {
                if let Some((_, v)) = value.as_mut() {
                    v.push_str(&c);
                }
            }
            Event::GeneralRef(r) => {
                let resolved: Cow<'_, str> = if r.is_char_ref() {
                    match r.resolve_char_ref().map_err(|_| bad())? {
                        Some(c) => Cow::Owned(c.to_string()),
                        None => return Err(bad()),
                    }
                } else {
                    match r.as_ref() {
                        "amp" => "&".into(),
                        "lt" => "<".into(),
                        "gt" => ">".into(),
                        "quot" => "\"".into(),
                        "apos" => "'".into(),
                        _ => return Err(invalid("The XML file uses an entity that is not supported.")),
                    }
                };
                if let Some((_, v)) = value.as_mut() {
                    v.push_str(&resolved);
                }
            }
            Event::End(_) => {
                if let Some((name, v)) = value.take()
                    && let Some((depth, session)) = open.last_mut()
                    && *depth == keys.len()
                {
                    session.set(&name, &v);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !found_sessions {
        return Err(invalid("The file has no SecureCRT sessions (a \"Sessions\" key)."));
    }
    Ok(out)
}

/// One session's `.ini` file (`S:"Hostname"=…`, `D:"[SSH2] Port"=00000016`). There is no
/// session name inside it, so the host name becomes the label.
fn parse_securecrt_ini(text: &str) -> Result<Parsed, IpcError> {
    let mut out = Parsed::default();
    let mut session = CrtSession { line: 1, ..CrtSession::default() };
    for raw in text.lines() {
        let line = raw.trim();
        let Some((kind, rest)) = line.split_once(":\"") else { continue };
        let Some((name, value)) = rest.split_once("\"=") else { continue };
        let value = match kind {
            "D" => u32::from_str_radix(value.trim(), 16).map(|n| n.to_string()).unwrap_or_default(),
            "S" | "Z" => value.to_owned(),
            _ => continue,
        };
        session.set(name, &value);
    }
    if session.host.is_none() && session.protocol.is_none() {
        return Err(invalid("The file is not a SecureCRT session (.ini) or settings export (.xml)."));
    }
    session.path = vec![String::new()];
    finish_crt(&mut out, session)?;
    Ok(out)
}

pub(crate) fn parse_securecrt(text: &str) -> Result<Parsed, IpcError> {
    check_size(text)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim_start().starts_with('<') { parse_securecrt_xml(text) } else { parse_securecrt_ini(text) }
}

// ---------- OpenSSH known_hosts ----------

/// One parsed `known_hosts` key for one host, before it is compared with the vault.
pub(crate) struct KnownHostLine {
    pub line: usize,
    pub host: String,
    pub port: u16,
    pub key: tyrminal_ssh::PresentedHostKey,
}

/// `host`, `[host]:port` → canonical host and port.
fn known_host_name(name: &str) -> Option<(String, u16)> {
    let (host, port) = match name.strip_prefix('[') {
        Some(rest) => {
            let (host, port) = rest.split_once("]:")?;
            (host, port.parse::<u16>().ok().filter(|p| *p > 0)?)
        }
        None => (name, 22),
    };
    let host = crate::validate::address(host).ok()?;
    Some((tyrminal_ssh::canonical_host(&host), port))
}

/// An OpenSSH `known_hosts` file (the user picked it; it is read as data). Hashed host names,
/// patterns and negations cannot be mapped to one host and are skipped; `@cert-authority` lines
/// are not supported yet; a key listed under `@revoked` anywhere in the file is never imported.
pub(crate) fn parse_known_hosts(text: &str) -> Result<(Vec<KnownHostLine>, Parsed), IpcError> {
    check_size(text)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Parsed::default();
    let mut lines = Vec::new();
    let mut revoked: Vec<String> = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.len() > tyrminal_contracts::limits::MAX_IMPORT_LINE_LEN {
            out.skip(number, line, "line is too long");
            continue;
        }
        let mut fields = line.split_whitespace();
        let mut first = fields.next().unwrap_or_default();
        let marker = first.strip_prefix('@').map(str::to_owned);
        if marker.is_some() {
            first = fields.next().unwrap_or_default();
        }
        let key_text = format!("{} {}", fields.next().unwrap_or_default(), fields.next().unwrap_or_default());
        match marker.as_deref() {
            Some("revoked") => {
                if let Some(key) = tyrminal_ssh::host_key_from_openssh(&key_text) {
                    revoked.push(key.public_key);
                }
                out.skip(number, line, "revocation entry: the key it names is never imported");
                continue;
            }
            Some("cert-authority") => {
                out.skip(number, line, "host certificate authorities are not supported yet");
                continue;
            }
            Some(_) => {
                out.skip(number, line, "unknown marker");
                continue;
            }
            None => {}
        }
        let Some(key) = tyrminal_ssh::host_key_from_openssh(&key_text) else {
            out.skip(number, line, "not a host key type Tyrminal accepts, or not a valid key");
            continue;
        };
        if first.starts_with('|') {
            out.skip(number, line, "hashed host name: which host it is for cannot be known");
            continue;
        }
        for name in first.split(',').filter(|n| !n.is_empty()) {
            if name.contains(['*', '?', '!']) {
                out.skip(number, name, "host pattern: not one host");
                continue;
            }
            let Some((host, port)) = known_host_name(name) else {
                out.skip(number, name, "not a valid host name or address");
                continue;
            };
            if lines.len() >= MAX_IMPORT_HOSTS {
                return Err(invalid(TOO_MANY));
            }
            lines.push(KnownHostLine { line: number, host, port, key: key.clone() });
        }
    }
    let (kept, dropped): (Vec<_>, Vec<_>) = lines.into_iter().partition(|l| !revoked.contains(&l.key.public_key));
    for l in dropped {
        out.skip(l.line, &l.host, "this key is also listed as revoked in the file; not imported");
    }
    Ok((kept, out))
}

// ---------- key files ----------

/// Whether private-key text (OpenSSH, PEM or PuTTY) needs a passphrase to decode. Used to tell
/// the user before import, without the text leaving the native side.
pub fn key_text_is_encrypted(text: &str) -> bool {
    tyrminal_ssh::ClientKey::is_passphrase_protected(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn putty_reg_imports_ssh_sessions_and_reports_the_rest() {
        let reg = "Windows Registry Editor Version 5.00\r\n\r\n\
            [HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]\r\n\
            \"HostName\"=\"\"\r\n\r\n\
            [HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\web%201]\r\n\
            \"HostName\"=\"admin@web1.example\"\r\n\
            \"PortNumber\"=dword:000008ae\r\n\
            \"Protocol\"=\"ssh\"\r\n\
            \"PublicKeyFile\"=\"C:\\\\Users\\\\me\\\\keys\\\\web.ppk\"\r\n\
            \"PortForwardings\"=\"L8080=localhost:80\"\r\n\r\n\
            [HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\router]\r\n\
            \"HostName\"=\"192.0.2.1\"\r\n\
            \"Protocol\"=\"telnet\"\r\n";
        let parsed = parse_putty_reg(reg).unwrap();
        assert_eq!(parsed.hosts.len(), 1);
        let h = &parsed.hosts[0];
        assert_eq!(
            (h.label.as_str(), h.address.as_str(), h.port, h.username.as_str()),
            ("web 1", "web1.example", 2222, "admin")
        );
        assert!(h.notes.iter().any(|n| n.contains("web.ppk") && !n.contains("Users")), "{:?}", h.notes);
        assert!(h.notes.iter().any(|n| n.contains("forwarding")));
        let reasons: Vec<&str> = parsed.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.iter().any(|r| r.contains("defaults")), "{reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("telnet")), "{reasons:?}");

        assert!(parse_putty_reg("Host web\n").is_err());
        assert!(parse_putty_reg("REGEDIT4\n[HKEY_CURRENT_USER\\Software\\Other]\n\"a\"=\"b\"\n").is_err());
        // A port PuTTY would never write.
        let bad = "REGEDIT4\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\x]\n\"HostName\"=\"h\"\n\"PortNumber\"=dword:00010000\n";
        assert_eq!(parse_putty_reg(bad).unwrap().hosts.len(), 0);
    }

    #[test]
    fn mobaxterm_imports_ssh_and_sftp_with_folders_and_never_passwords() {
        let ini = "[Bookmarks]\nSubRep=\nImgNum=42\n\
            jump=#109#0%jump.example%22%ops%%-1%-1%%%%%0%0%0%_ProfileDir_\\keys\\id.ppk%%-1%0#MobaFont%10#0# #-1\n\
            [Bookmarks_1]\nSubRep=Prod\\DB\nImgNum=41\n\
            db-1=#109#6%10.0.0.5%2200%postgres%#MobaFont#0# #-1\n\
            desk=#91#4%10.0.0.9%5900%#MobaFont#0# #-1\n\
            [Passwords]\nops@jump.example=_@encrypted@_\n";
        let parsed = parse_mobaxterm(ini).unwrap();
        assert_eq!(parsed.hosts.len(), 2);
        let jump = &parsed.hosts[0];
        assert_eq!((jump.address.as_str(), jump.username.as_str(), jump.group.as_str()), ("jump.example", "ops", ""));
        assert!(jump.notes.iter().any(|n| n.contains("id.ppk")));
        let db = &parsed.hosts[1];
        assert_eq!((db.port, db.group.as_str()), (2200, "Prod/DB"));
        assert!(db.notes.iter().any(|n| n.contains("SFTP")));
        let reasons: Vec<&str> = parsed.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.iter().any(|r| r.contains("VNC")), "{reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("passwords")), "{reasons:?}");
        assert!(!format!("{:?}", parsed.hosts).contains("encrypted"));
        assert!(parse_mobaxterm("[Misc]\na=b\n").is_err());
    }

    #[test]
    fn securecrt_xml_reads_folders_refuses_doctype_and_never_imports_passwords() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Default"><string name="Hostname"></string><string name="Protocol Name">SSH2</string></key>
    <key name="Prod &amp; Co">
      <key name="web-1">
        <string name="Hostname">web1.example</string>
        <dword name="[SSH2] Port">2022</dword>
        <string name="Username">deploy</string>
        <string name="Protocol Name">SSH2</string>
        <string name="Password V2">02:0123abcd</string>
        <string name="Identity Filename V2">C:\keys\web.pub::rawkey</string>
      </key>
      <key name="old"><string name="Hostname">old.example</string><string name="Protocol Name">SSH1</string></key>
    </key>
    <key name="console"><string name="Protocol Name">Serial</string></key>
  </key>
</VanDyke>"#;
        let parsed = parse_securecrt(xml).unwrap();
        assert_eq!(parsed.hosts.len(), 1, "{:?}", parsed.skipped);
        let h = &parsed.hosts[0];
        assert_eq!(
            (h.label.as_str(), h.group.as_str(), h.port, h.username.as_str()),
            ("web-1", "Prod & Co", 2022, "deploy")
        );
        assert!(h.notes.iter().any(|n| n.contains("password")));
        assert!(!format!("{:?}", parsed.hosts).contains("0123abcd"));
        let reasons: Vec<&str> = parsed.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.iter().any(|r| r.contains("defaults")), "{reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("SSH1")), "{reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("Serial")), "{reasons:?}");

        // External entities: refused before anything is resolved.
        let xxe = r#"<?xml version="1.0"?><!DOCTYPE v [<!ENTITY x SYSTEM "file:///etc/passwd">]><VanDyke><key name="Sessions"><key name="a"><string name="Hostname">&x;</string></key></key></VanDyke>"#;
        assert!(parse_securecrt(xxe).unwrap_err().message.contains("DOCTYPE"));
        let undefined =
            r#"<VanDyke><key name="Sessions"><key name="a"><string name="Hostname">&x;</string></key></key></VanDyke>"#;
        assert!(parse_securecrt(undefined).is_err());
        let deep = format!("<VanDyke><key name=\"Sessions\">{}</key></VanDyke>", "<key name=\"k\">".repeat(100));
        assert!(parse_securecrt(&deep).is_err());
        assert!(parse_securecrt("<VanDyke><key name=\"Other\"/></VanDyke>").is_err());
    }

    #[test]
    fn securecrt_ini_is_one_session() {
        let ini =
            "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=bastion.example\nD:\"[SSH2] Port\"=00000016\nS:\"Username\"=me\n";
        let parsed = parse_securecrt(ini).unwrap();
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!((parsed.hosts[0].label.as_str(), parsed.hosts[0].port), ("bastion.example", 22));
        assert!(parse_securecrt("hello\n").is_err());
    }

    #[test]
    fn known_hosts_skip_hashed_patterns_authorities_and_revoked_keys() {
        let text =
            std::fs::read_to_string(format!("{}/../../tests/fixtures/import/known_hosts", env!("CARGO_MANIFEST_DIR")))
                .unwrap();
        let (lines, parsed) = parse_known_hosts(&text).unwrap();
        let got: Vec<(String, u16, String)> =
            lines.iter().map(|l| (l.host.clone(), l.port, l.key.algorithm.clone())).collect();
        assert_eq!(
            got,
            [
                ("web.example.net".to_owned(), 22, "ssh-ed25519".to_owned()),
                ("192.0.2.10".to_owned(), 22, "ssh-ed25519".to_owned()),
                ("web.example.net".to_owned(), 22, "ecdsa-sha2-nistp256".to_owned()),
            ]
        );
        let reasons: Vec<&str> = parsed.skipped.iter().map(|s| s.reason.as_str()).collect();
        for expected in
            ["hashed", "pattern", "certificate authorities", "revocation", "not a host key", "also listed as revoked"]
        {
            assert!(reasons.iter().any(|r| r.contains(expected)), "{expected}: {reasons:?}");
        }
        // The bracketed form carries the port; the revoked bastion key never appears.
        assert!(lines.iter().all(|l| l.host != "bastion.example.net"));
        let (bracketed, _) =
            parse_known_hosts(&format!("[h.example]:2200 {}", text.lines().nth(1).unwrap().split_once(' ').unwrap().1))
                .unwrap();
        assert_eq!((bracketed[0].host.as_str(), bracketed[0].port), ("h.example", 2200));
        assert!(parse_known_hosts(&"x".repeat(2 * 1024 * 1024)).is_err());
    }
}

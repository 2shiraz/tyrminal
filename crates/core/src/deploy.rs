//! Installing a public key on a server (Phase 04, KEY-05).
//!
//! Runs over a session's already verified and authenticated connection, on separate exec
//! channels. The remote commands are fixed strings: nothing from the vault, the renderer or the
//! server is ever interpolated into them. The key line travels on the channel's standard input.
//! Only `~/.ssh/authorized_keys` is touched, only by appending one line; every other line is
//! kept. A file that does not end with a newline gets one first, so the last existing entry is
//! not corrupted. A new `~/.ssh` is made 0700 and a new `authorized_keys` 0600 (explicitly, since
//! a default ACL would override the umask); existing ones keep their permissions.

use std::time::Duration;

use tyrminal_contracts::{ErrorCode, IpcError, KeyDeployPreview};
use tyrminal_ssh::{ShellEvent, VerifiedConnection};

use crate::error::{err, from_ssh};

pub(crate) const PATH: &str = "~/.ssh/authorized_keys";
const READ: &str = "cat ~/.ssh/authorized_keys 2>/dev/null; exit 0";
// A default ACL on the home folder overrides the umask, so what this creates is also chmod-ed
// explicitly (sshd's StrictModes refuses a group-writable authorized_keys). Existing files and
// folders keep their permissions.
const APPEND: &str = "umask 077 && \
     { [ -d ~/.ssh ] || { mkdir ~/.ssh && chmod 700 ~/.ssh; }; } && \
     { [ -e ~/.ssh/authorized_keys ] || { touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; }; } && \
     { [ -z \"$(tail -c 1 ~/.ssh/authorized_keys)\" ] || echo >> ~/.ssh/authorized_keys; } && \
     cat >> ~/.ssh/authorized_keys";
/// Largest authorized_keys file read back (servers with more keys than this are unusual).
const MAX_FILE: usize = 512 * 1024;
const LIMIT: Duration = Duration::from_secs(20);

/// The key material of an OpenSSH public-key line (`<type> <base64> [comment]`).
fn blob(line: &str) -> Option<&str> {
    let mut parts = line.split_whitespace();
    let kind = parts.next()?;
    if !(kind.starts_with("ssh-") || kind.starts_with("ecdsa-") || kind.starts_with("sk-")) {
        return None;
    }
    parts.next()
}

/// Counts keys in an authorized_keys file and whether `line`'s key is among them. Lines may
/// carry options before the key type (`from="...",no-pty ssh-ed25519 AAAA...`), so every
/// whitespace-separated token is compared with the key material.
pub(crate) fn scan(file: &str, line: &str) -> (u32, bool) {
    let wanted = blob(line);
    let mut keys = 0u32;
    let mut present = false;
    for entry in file.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        keys += 1;
        if wanted.is_some_and(|w| entry.split_whitespace().any(|token| token == w)) {
            present = true;
        }
    }
    (keys, present)
}

fn failed() -> IpcError {
    err(
        ErrorCode::IoError,
        "The server did not accept the change. It may not run a POSIX shell, or the account cannot write ~/.ssh.",
    )
}

async fn read(conn: &VerifiedConnection) -> Result<String, IpcError> {
    let out = conn.exec(READ, MAX_FILE, LIMIT).await.map_err(|e| from_ssh(&e))?;
    if out.exit_status != Some(0) {
        return Err(failed());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub(crate) async fn preview(conn: &VerifiedConnection, line: &str) -> Result<KeyDeployPreview, IpcError> {
    let file = read(conn).await?;
    let (existing_keys, already_present) = scan(&file, line);
    Ok(KeyDeployPreview { path: PATH.into(), existing_keys, already_present, line: line.to_owned() })
}

pub(crate) async fn install(conn: &VerifiedConnection, line: &str) -> Result<KeyDeployPreview, IpcError> {
    // A public-key line is one line of printable text; refuse anything else outright.
    if line.is_empty() || line.chars().any(char::is_control) || blob(line).is_none() {
        return Err(err(ErrorCode::InvalidInput, "That key cannot be installed."));
    }
    let before = preview(conn, line).await?;
    if before.already_present {
        return Ok(before);
    }
    let (mut reader, writer) = conn.open_command(APPEND).await.map_err(|e| from_ssh(&e))?;
    writer.write(format!("{line}\n").as_bytes()).await.map_err(|e| from_ssh(&e))?;
    writer.eof().await.map_err(|e| from_ssh(&e))?;
    let status = tokio::time::timeout(LIMIT, async {
        let mut status = None;
        while let Some(event) = reader.next().await {
            if let ShellEvent::ExitStatus(code) = event {
                status = Some(code);
            }
        }
        status
    })
    .await
    .map_err(|_| err(ErrorCode::Timeout, "The server did not finish the change in time."))?;
    if status != Some(0) {
        return Err(failed());
    }
    let after = preview(conn, line).await?;
    if !after.already_present {
        return Err(failed());
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial deploy-key";

    #[test]
    fn scan_finds_the_key_with_or_without_options_and_counts_keys() {
        let file = "# comment\n\nssh-rsa AAAAB3other a@b\nfrom=\"10.0.0.0/8\",no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial old-comment\n";
        assert_eq!(scan(file, KEY), (2, true));
        assert_eq!(scan("ssh-rsa AAAAB3other a@b", KEY), (1, false));
        assert_eq!(scan("", KEY), (0, false));
        // A different key whose material merely contains ours is not a match.
        assert_eq!(scan("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialX x", KEY), (1, false));
    }

    #[test]
    fn the_remote_commands_are_fixed_text() {
        assert!(!READ.contains('$'));
        // The only expansion in APPEND is the command substitution that reads the last byte.
        assert_eq!(APPEND.matches('$').count(), 1);
        assert!(APPEND.ends_with("cat >> ~/.ssh/authorized_keys"), "the key comes from stdin");
    }
}

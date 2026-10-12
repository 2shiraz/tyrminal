//! Opt-in shell integration (AUT-06, AUT-07).
//!
//! A versioned script (`shell-integration/`) makes Bash or Zsh print OSC 133 marks (prompt
//! start and end, command start and end with its exit status) and OSC 7 (the current folder).
//! The script only prints those sequences; it runs nothing it receives and contains no `eval`.
//!
//! It is written into the shell's startup file only when the user asks, inside a marked block
//! that is shown in full first, replaced on upgrade and removed on request. Every other line of
//! the file is kept. Before the file changes, its previous content is copied next to it
//! (`<file>.tyrminal-backup`). A begin marker without an end marker means the block was edited
//! by hand, and the file is then left alone.
//!
//! Remote installs run over the session's verified connection on exec channels with fixed
//! command text; the new file content travels on standard input. Remote targets are Bash
//! (`~/.bashrc`); local targets are Bash or Zsh in the home folder.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tyrminal_contracts::{ErrorCode, IntegrationShell, IntegrationStatus, IpcError};
use tyrminal_ssh::{ShellEvent, VerifiedConnection};

use crate::error::{err, from_ssh};

/// The script version this build installs. Bump it whenever a script changes.
pub const VERSION: u32 = 1;

const BASH: &str = include_str!("../shell-integration/tyrminal.bash");
const ZSH: &str = include_str!("../shell-integration/tyrminal.zsh");

const BEGIN: &str = "# >>> tyrminal shell integration v";
const END: &str = "# <<< tyrminal shell integration <<<";
/// Startup files larger than this are not edited.
const MAX_FILE: usize = 1024 * 1024;
const LIMIT: Duration = Duration::from_secs(20);

pub(crate) fn file_name(shell: IntegrationShell) -> &'static str {
    match shell {
        IntegrationShell::Bash => ".bashrc",
        IntegrationShell::Zsh => ".zshrc",
    }
}

/// The exact block written to the startup file, markers included.
pub fn block(shell: IntegrationShell) -> String {
    let script = match shell {
        IntegrationShell::Bash => BASH,
        IntegrationShell::Zsh => ZSH,
    };
    format!(
        "{BEGIN}{VERSION} >>>\n# Added by Tyrminal when you installed shell integration. Remove it in Tyrminal or delete\n# everything up to the closing marker.\n{script}{END}\n"
    )
}

fn begin_version(line: &str) -> Option<Option<u32>> {
    let rest = line.trim_end().strip_prefix(BEGIN)?;
    Some(rest.strip_suffix(" >>>").and_then(|v| v.parse().ok()))
}

fn hand_edited() -> IpcError {
    err(
        ErrorCode::Conflict,
        "The shell integration block in this file was changed by hand (its closing line is missing). Fix or remove it in the file first.",
    )
}

/// The installed version (`None`: not installed). Errors when a block has no closing marker.
pub fn installed_version(text: &str) -> Result<Option<u32>, IpcError> {
    let mut found = None;
    let mut open = false;
    for line in text.lines() {
        if let Some(version) = begin_version(line) {
            if open {
                return Err(hand_edited());
            }
            open = true;
            // An unreadable version still counts as installed (an older or newer build).
            found = Some(version.unwrap_or(0));
        } else if line.trim_end() == END {
            if !open {
                return Err(hand_edited());
            }
            open = false;
        }
    }
    if open {
        return Err(hand_edited());
    }
    Ok(found)
}

/// `text` without any integration block. Lines outside blocks are kept byte for byte.
pub fn without_block(text: &str) -> Result<String, IpcError> {
    installed_version(text)?;
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        if begin_version(line).is_some() {
            inside = true;
        } else if inside && line.trim_end() == END {
            inside = false;
        } else if !inside {
            out.push_str(line);
        }
    }
    Ok(out)
}

/// `text` with exactly one current block at the end (an older block is removed first).
pub fn with_block(text: &str, shell: IntegrationShell) -> Result<String, IpcError> {
    let mut out = without_block(text)?;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&block(shell));
    Ok(out)
}

fn status_for(shell: IntegrationShell, path: String, text: Option<&str>) -> Result<IntegrationStatus, IpcError> {
    let installed_version = match text {
        Some(t) => installed_version(t)?,
        None => None,
    };
    Ok(IntegrationStatus {
        shell,
        backup_path: format!("{path}.tyrminal-backup"),
        path,
        file_exists: text.is_some(),
        version: VERSION,
        installed_version,
        script: block(shell),
        login_shell: None,
    })
}

fn too_large() -> IpcError {
    err(ErrorCode::InvalidInput, "This startup file is larger than 1 MiB, so Tyrminal does not edit it.")
}

// ---------- this computer ----------

fn local_path(home: &Path, shell: IntegrationShell) -> PathBuf {
    home.join(file_name(shell))
}

fn local_read(path: &Path) -> Result<Option<String>, IpcError> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_FILE as u64 => return Err(too_large()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(err(ErrorCode::IoError, "The startup file could not be read.")),
    }
    let bytes = std::fs::read(path).map_err(|_| err(ErrorCode::IoError, "The startup file could not be read."))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| err(ErrorCode::InvalidInput, "This startup file is not UTF-8 text, so Tyrminal does not edit it."))
}

/// What installing in `home` would change for `shell`. Reads only.
pub fn local_status(home: &Path, shell: IntegrationShell) -> Result<IntegrationStatus, IpcError> {
    let text = local_read(&local_path(home, shell))?;
    status_for(shell, format!("~/{}", file_name(shell)), text.as_deref())
}

/// Writes the file in place (keeping its owner, mode and any symlink) after copying the old
/// content to the backup. A new file is created readable by the user only.
fn local_write(home: &Path, shell: IntegrationShell, old: Option<&str>, new: &str) -> Result<(), IpcError> {
    use std::io::Write;
    let path = local_path(home, shell);
    let failed = || err(ErrorCode::IoError, "The startup file could not be written. Nothing was changed.");
    if let Some(old) = old {
        let backup = home.join(format!("{}.tyrminal-backup", file_name(shell)));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&backup).map_err(|_| failed())?;
        file.write_all(old.as_bytes()).and_then(|()| file.sync_all()).map_err(|_| failed())?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&path).map_err(|_| failed())?;
    file.write_all(new.as_bytes()).and_then(|()| file.sync_all()).map_err(|_| failed())
}

/// Installs (or upgrades) the block in `home`'s startup file for `shell`.
pub fn local_install(home: &Path, shell: IntegrationShell) -> Result<IntegrationStatus, IpcError> {
    let old = local_read(&local_path(home, shell))?;
    let new = with_block(old.as_deref().unwrap_or(""), shell)?;
    if old.as_deref() != Some(new.as_str()) {
        local_write(home, shell, old.as_deref(), &new)?;
    }
    local_status(home, shell)
}

/// Removes the block from `home`'s startup file for `shell`. A file without one is unchanged.
pub fn local_remove(home: &Path, shell: IntegrationShell) -> Result<IntegrationStatus, IpcError> {
    let Some(old) = local_read(&local_path(home, shell))? else {
        return local_status(home, shell);
    };
    let new = without_block(&old)?;
    if new != old {
        local_write(home, shell, Some(&old), &new)?;
    }
    local_status(home, shell)
}

// ---------- a server, over a session ----------

/// Prints the login shell's name, a marker for whether `~/.bashrc` exists, then its content.
const READ: &str = "printf '%s\\n' \"${SHELL##*/}\"; if [ -e ~/.bashrc ]; then echo Y; cat ~/.bashrc; else echo N; fi";
/// Keeps a copy of the old file, then rewrites it in place from standard input (so its owner,
/// mode and any symlink stay). A new file is created readable by the user only.
const WRITE: &str =
    "umask 077 && { [ ! -e ~/.bashrc ] || cp -p ~/.bashrc ~/.bashrc.tyrminal-backup; } && cat > ~/.bashrc";

fn remote_failed() -> IpcError {
    err(
        ErrorCode::IoError,
        "The server did not accept the change. It may not run a POSIX shell, or the account cannot write ~/.bashrc.",
    )
}

/// Login shell name as shown to the user: a short word of safe characters, or nothing.
fn clean_shell_name(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)))
        .then(|| name.to_owned())
}

async fn remote_read(conn: &VerifiedConnection) -> Result<(Option<String>, Option<String>), IpcError> {
    let out = conn.exec(READ, MAX_FILE + 128, LIMIT).await.map_err(|e| match e {
        tyrminal_ssh::SshError::LimitExceeded => too_large(),
        other => from_ssh(&other),
    })?;
    if out.exit_status != Some(0) {
        return Err(remote_failed());
    }
    if out.stdout.len() > MAX_FILE {
        return Err(too_large());
    }
    let text = String::from_utf8(out.stdout).map_err(|_| {
        err(ErrorCode::InvalidInput, "This startup file is not UTF-8 text, so Tyrminal does not edit it.")
    })?;
    let mut parts = text.splitn(3, '\n');
    let shell = parts.next().and_then(clean_shell_name);
    let content = match (parts.next(), parts.next()) {
        (Some("Y"), rest) => Some(rest.unwrap_or("").to_owned()),
        (Some("N"), _) => None,
        _ => return Err(remote_failed()),
    };
    Ok((shell, content))
}

pub(crate) async fn remote_status(conn: &VerifiedConnection) -> Result<IntegrationStatus, IpcError> {
    let (login_shell, text) = remote_read(conn).await?;
    let mut status = status_for(IntegrationShell::Bash, "~/.bashrc".into(), text.as_deref())?;
    status.login_shell = login_shell;
    Ok(status)
}

async fn remote_write(conn: &VerifiedConnection, content: &str) -> Result<(), IpcError> {
    let (mut reader, writer) = conn.open_command(WRITE).await.map_err(|e| from_ssh(&e))?;
    writer.write(content.as_bytes()).await.map_err(|e| from_ssh(&e))?;
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
        return Err(remote_failed());
    }
    Ok(())
}

/// Rewrites `~/.bashrc` with `edit` applied, then reads it back to confirm the result.
async fn remote_edit(
    conn: &VerifiedConnection,
    edit: impl FnOnce(&str) -> Result<String, IpcError>,
    expect_installed: bool,
) -> Result<IntegrationStatus, IpcError> {
    let (_, old) = remote_read(conn).await?;
    let new = edit(old.as_deref().unwrap_or(""))?;
    let unchanged = match &old {
        Some(old) => *old == new,
        None => new.is_empty(),
    };
    if !unchanged {
        remote_write(conn, &new).await?;
    }
    let after = remote_status(conn).await?;
    if (after.installed_version == Some(VERSION)) != expect_installed {
        return Err(remote_failed());
    }
    Ok(after)
}

pub(crate) async fn remote_install(conn: &VerifiedConnection) -> Result<IntegrationStatus, IpcError> {
    remote_edit(conn, |old| with_block(old, IntegrationShell::Bash), true).await
}

pub(crate) async fn remote_remove(conn: &VerifiedConnection) -> Result<IntegrationStatus, IpcError> {
    remote_edit(conn, without_block, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_appends_one_block_and_keeps_every_other_line() {
        let rc = "export A=1\nalias ll='ls -l'"; // no final newline
        let once = with_block(rc, IntegrationShell::Bash).unwrap();
        assert!(once.starts_with("export A=1\nalias ll='ls -l'\n# >>> tyrminal shell integration v1 >>>\n"));
        assert!(once.ends_with("# <<< tyrminal shell integration <<<\n"));
        assert_eq!(installed_version(&once).unwrap(), Some(VERSION));
        // Installing again changes nothing; removing restores the lines (plus the added newline).
        assert_eq!(with_block(&once, IntegrationShell::Bash).unwrap(), once);
        assert_eq!(without_block(&once).unwrap(), "export A=1\nalias ll='ls -l'\n");
        assert_eq!(with_block("", IntegrationShell::Zsh).unwrap(), block(IntegrationShell::Zsh));
    }

    #[test]
    fn an_older_block_is_replaced_in_place_of_being_duplicated() {
        let rc = "a\n# >>> tyrminal shell integration v0 >>>\nold\n# <<< tyrminal shell integration <<<\nb\n";
        assert_eq!(installed_version(rc).unwrap(), Some(0));
        let new = with_block(rc, IntegrationShell::Bash).unwrap();
        assert!(new.starts_with("a\nb\n# >>> tyrminal shell integration v1 >>>"));
        assert!(!new.contains("\nold\n"));
        assert_eq!(new.matches(BEGIN).count(), 1);
    }

    #[test]
    fn a_block_edited_by_hand_is_never_rewritten() {
        let unterminated = "a\n# >>> tyrminal shell integration v1 >>>\nmy own lines\n";
        assert_eq!(with_block(unterminated, IntegrationShell::Bash).unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(without_block(unterminated).unwrap_err().code, ErrorCode::Conflict);
        let stray_end = "a\n# <<< tyrminal shell integration <<<\n";
        assert_eq!(installed_version(stray_end).unwrap_err().code, ErrorCode::Conflict);
        let nested = "# >>> tyrminal shell integration v1 >>>\n# >>> tyrminal shell integration v1 >>>\n# <<< tyrminal shell integration <<<\n";
        assert_eq!(installed_version(nested).unwrap_err().code, ErrorCode::Conflict);
    }

    #[test]
    fn the_scripts_only_print_escape_sequences() {
        for script in [BASH, ZSH] {
            assert!(!script.contains("eval"), "no eval");
            assert!(!script.contains("source") && !script.contains(". /"), "loads nothing");
            // `$((...))` is arithmetic; `$(...)` (command substitution) and backticks are not allowed.
            assert!(!script.replace("$((", "").contains("$(") && !script.contains('`'), "no command substitution");
            assert!(!script.contains(BEGIN) && !script.contains(END), "markers stay unique");
            assert!(script.ends_with('\n'));
        }
    }

    #[test]
    fn the_remote_commands_are_fixed_text() {
        // READ expands only the login shell's name; WRITE takes the content from stdin.
        assert_eq!(READ.matches('$').count(), 1);
        assert!(!WRITE.contains('$'));
        assert!(WRITE.ends_with("cat > ~/.bashrc"));
    }

    #[test]
    fn login_shell_names_are_short_safe_words() {
        assert_eq!(clean_shell_name("bash\n").as_deref(), Some("bash"));
        assert_eq!(clean_shell_name("\u{1b}[31mbash"), None);
        assert_eq!(clean_shell_name(""), None);
    }
}

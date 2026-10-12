//! AUT-06/07 on this computer: the shell integration block is written into a startup file in a
//! temporary home folder (never the real one), and real Bash and Zsh processes started with that
//! home report their folder, prompt and command boundaries.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

use tempfile::TempDir;
use tyrminal_core::contracts::{ErrorCode, IntegrationShell};
use tyrminal_core::shell_integration::{local_install, local_remove, local_status};

/// Runs an interactive shell with `home` as its home folder, typing `input` on its standard
/// input. Returns everything it printed. Only `HOME`, `TERM` and `PATH` are passed in.
fn interactive(shell: &str, home: &Path, input: &str) -> Option<String> {
    let mut command = Command::new(shell);
    command
        .arg("-i")
        .env_clear()
        .env("HOME", home)
        .env("ZDOTDIR", home)
        .env("TERM", "xterm")
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    use std::io::Write;
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    Some(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// Bash is expected everywhere these tests run, and Zsh on macOS (it is the default shell there).
/// A shell missing elsewhere is reported and its process check left out.
#[allow(clippy::print_stderr, reason = "says which process check did not run")]
fn require(shell: &str) -> bool {
    let present = Command::new(shell).arg("-c").arg("exit 0").status().is_ok_and(|s| s.success());
    if !present {
        assert!(shell != "bash" && !cfg!(target_os = "macos"), "{shell} is expected here");
        eprintln!("{shell} is not installed here; its process check did not run");
    }
    present
}

fn check_marks(out: &str, home: &Path) {
    // The shell reports the physical folder (`/private/var/...` for `/var/...` on macOS).
    let folder = std::fs::canonicalize(home).unwrap().join("a b").join("ü");
    let mut encoded = String::new();
    for b in folder.to_str().unwrap().bytes() {
        if b.is_ascii_alphanumeric() || b"/._~-".contains(&b) {
            encoded.push(char::from(b));
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    assert!(out.contains("\u{1b}]7;file://"), "{out:?}");
    assert!(out.contains(&format!("{encoded}\u{1b}\\")), "folder reported, percent-encoded: {out:?}");
    assert!(out.contains("\u{1b}]133;A\u{1b}\\") && out.contains("\u{1b}]133;B\u{1b}\\"), "{out:?}");
    assert!(out.contains("\u{1b}]133;D;1\u{1b}\\"), "the failed command's status: {out:?}");
}

/// What is typed into the shell: ASCII only, since a shell's line editor without a UTF-8 locale
/// (macOS's Bash 3.2 with a cleared environment) mangles typed non-ASCII. The folder with a space
/// and a non-ASCII name is made beforehand by [`prepare`], and the glob reaches it.
const SESSION: &str = "cd a*/*\nfalse\nexit\n";

fn prepare(home: &Path) {
    std::fs::create_dir_all(home.join("a b").join("ü")).unwrap();
}

#[test]
fn bash_integration_is_written_on_request_and_a_real_bash_reports_its_context() {
    let home = TempDir::new().unwrap();
    let rc = home.path().join(".bashrc");
    std::fs::write(&rc, "export KEEP_ME=1\n").unwrap();
    std::fs::set_permissions(&rc, std::fs::Permissions::from_mode(0o640)).unwrap();

    let before = local_status(home.path(), IntegrationShell::Bash).unwrap();
    assert_eq!((before.installed_version, before.file_exists), (None, true));
    assert_eq!(std::fs::read_to_string(&rc).unwrap(), "export KEEP_ME=1\n", "looking changes nothing");

    let installed = local_install(home.path(), IntegrationShell::Bash).unwrap();
    assert_eq!(installed.installed_version, Some(installed.version));
    let text = std::fs::read_to_string(&rc).unwrap();
    assert_eq!(text, format!("export KEEP_ME=1\n{}", installed.script), "exactly the reviewed block");
    assert_eq!(std::fs::metadata(&rc).unwrap().permissions().mode() & 0o777, 0o640, "mode kept");
    let backup = home.path().join(".bashrc.tyrminal-backup");
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), "export KEEP_ME=1\n");
    assert_eq!(std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);

    if require("bash") {
        prepare(home.path());
        let out = interactive("bash", home.path(), SESSION).unwrap();
        check_marks(&out, home.path());
        let version =
            Command::new("bash").args(["-c", "echo ${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}"]).output().unwrap();
        let version: u32 = String::from_utf8_lossy(&version.stdout).trim().parse().unwrap();
        if version >= 44 {
            assert!(out.contains("\u{1b}]133;C\u{1b}\\"), "command start (PS0): {out:?}");
        }
    }

    let removed = local_remove(home.path(), IntegrationShell::Bash).unwrap();
    assert_eq!(removed.installed_version, None);
    assert_eq!(std::fs::read_to_string(&rc).unwrap(), "export KEEP_ME=1\n");
}

#[test]
fn zsh_integration_creates_a_private_startup_file_and_a_real_zsh_reports_its_context() {
    let home = TempDir::new().unwrap();
    let rc = home.path().join(".zshrc");
    let installed = local_install(home.path(), IntegrationShell::Zsh).unwrap();
    assert_eq!(installed.path, "~/.zshrc");
    assert_eq!(std::fs::read_to_string(&rc).unwrap(), installed.script);
    assert_eq!(std::fs::metadata(&rc).unwrap().permissions().mode() & 0o777, 0o600, "new file is private");
    assert!(!home.path().join(".zshrc.tyrminal-backup").exists(), "nothing to back up");

    if require("zsh") {
        prepare(home.path());
        let out = interactive("zsh", home.path(), SESSION).unwrap();
        check_marks(&out, home.path());
        assert!(out.contains("\u{1b}]133;C\u{1b}\\"), "command start (preexec): {out:?}");
    }
    assert_eq!(local_remove(home.path(), IntegrationShell::Zsh).unwrap().installed_version, None);
    assert_eq!(std::fs::read_to_string(&rc).unwrap(), "");
}

#[test]
fn a_hand_edited_block_or_an_unreadable_file_is_left_alone() {
    let home = TempDir::new().unwrap();
    let rc = home.path().join(".bashrc");
    let edited = "# >>> tyrminal shell integration v1 >>>\nmy own lines\n";
    std::fs::write(&rc, edited).unwrap();
    assert_eq!(local_install(home.path(), IntegrationShell::Bash).unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(local_remove(home.path(), IntegrationShell::Bash).unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(std::fs::read_to_string(&rc).unwrap(), edited);

    std::fs::write(&rc, [0xff, 0xfe, b'\n']).unwrap();
    assert_eq!(local_install(home.path(), IntegrationShell::Bash).unwrap_err().code, ErrorCode::InvalidInput);
    std::fs::write(&rc, vec![b'#'; 1024 * 1024 + 1]).unwrap();
    assert_eq!(local_install(home.path(), IntegrationShell::Bash).unwrap_err().code, ErrorCode::InvalidInput);
    assert!(!home.path().join(".bashrc.tyrminal-backup").exists());

    // Removing from a home without the file changes nothing.
    let empty = TempDir::new().unwrap();
    assert!(!local_remove(empty.path(), IntegrationShell::Zsh).unwrap().file_exists);
    assert!(!empty.path().join(".zshrc").exists());
}

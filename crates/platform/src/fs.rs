//! Owner-only directories for application data.

use std::io;
use std::path::Path;

/// Restricts `dir` (and, by inheritance, everything created in it) to the current user.
///
/// - Unix: mode 0700.
/// - Windows: replaces the DACL with full control for the current user's SID and SYSTEM only,
///   inherited by files and subdirectories, and removes inherited entries. Applied with the
///   system `icacls.exe` (absolute path, structured arguments, no shell). Administrators can
///   still take ownership; that is outside what an application can prevent.
pub fn restrict_to_owner(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(windows)]
    {
        windows::restrict(dir)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = dir;
        Err(io::Error::other("owner-only directories are not supported on this platform"))
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn system32() -> PathBuf {
        let root = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
        root.join("System32")
    }

    /// The current user's SID, from `whoami /user /fo csv /nh` ("DOMAIN\user","S-1-5-...").
    pub(super) fn current_user_sid() -> io::Result<String> {
        let out = Command::new(system32().join("whoami.exe")).args(["/user", "/fo", "csv", "/nh"]).output()?;
        if !out.status.success() {
            return Err(io::Error::other("whoami failed"));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let sid = text.trim().rsplit(',').next().unwrap_or("").trim_matches('"').to_owned();
        let valid = sid.starts_with("S-1-") && sid.bytes().all(|b| b.is_ascii_digit() || b == b'-' || b == b'S');
        if valid { Ok(sid) } else { Err(io::Error::other("unexpected whoami output")) }
    }

    pub(super) fn restrict(dir: &Path) -> io::Result<()> {
        let sid = current_user_sid()?;
        let status = Command::new(system32().join("icacls.exe"))
            .arg(dir)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("*{sid}:(OI)(CI)F"))
            .args(["/grant:r", "*S-1-5-18:(OI)(CI)F", "/q"])
            .status()?;
        if !status.success() {
            return Err(io::Error::other("icacls failed"));
        }
        // An elevated process can get explicit (non-inherited) entries for Administrators or
        // CREATOR OWNER on a new directory, which /inheritance:r does not remove. Remove the
        // broad well-known groups explicitly: Administrators, Users, Authenticated Users,
        // Everyone, CREATOR OWNER.
        let status = Command::new(system32().join("icacls.exe"))
            .arg(dir)
            .args(["/remove:g", "*S-1-5-32-544", "*S-1-5-32-545", "*S-1-5-11", "*S-1-1-0", "*S-1-3-0", "/q"])
            .status()?;
        if status.success() { Ok(()) } else { Err(io::Error::other("icacls failed")) }
    }

    #[cfg(test)]
    #[allow(clippy::unwrap_used)]
    mod tests {
        use super::*;

        /// The directory ends up with exactly two entries: this user and SYSTEM.
        #[test]
        fn data_directory_is_owner_only() {
            let dir = std::env::temp_dir().join(format!("tyrminal-acl-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            restrict(&dir).unwrap();
            std::fs::write(dir.join("child"), b"x").unwrap();
            let sid = current_user_sid().unwrap();
            for target in [dir.clone(), dir.join("child")] {
                let out = Command::new(system32().join("icacls.exe")).arg(&target).output().unwrap();
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                let entries: Vec<&str> = text.lines().filter(|l| l.contains(':') && l.contains('(')).collect();
                assert_eq!(entries.len(), 2, "{text}");
                assert!(text.contains("NT AUTHORITY\\SYSTEM"), "{text}");
                assert!(
                    !text.contains("BUILTIN\\Administrators")
                        && !text.contains("BUILTIN\\Users")
                        && !text.contains("Everyone")
                        && !text.contains("Authenticated Users"),
                    "{text}"
                );
                let _ = &sid;
            }
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn data_directory_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile_dir();
        restrict_to_owner(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tyrminal-perm-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

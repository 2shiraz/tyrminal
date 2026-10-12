//! OS auto-detection: after an SSH connection opens, the server's OS is read once with a fixed
//! command on a separate exec channel (no PTY, nothing typed into the user's shell) and mapped to
//! a [`HostOs`] for the host's icon. The answer is untrusted text: only known identifiers map to
//! an OS, and anything else is no answer.

use std::time::Duration;

use tyrminal_contracts::HostOs;
use tyrminal_ssh::VerifiedConnection;

/// The fixed command: the system name, then `/etc/os-release` where it exists. Nothing from the
/// user or the server goes into it.
pub(crate) const COMMAND: &str = "uname -s 2>/dev/null; echo @@; cat /etc/os-release 2>/dev/null";

const MAX_OUTPUT: usize = 16 * 1024;
const LIMIT: Duration = Duration::from_secs(10);

/// Reads and maps the server's OS; `None` when it cannot be told.
pub(crate) async fn detect(conn: &VerifiedConnection) -> Option<HostOs> {
    let out = conn.exec(COMMAND, MAX_OUTPUT, LIMIT).await.ok()?;
    parse(&out.stdout)
}

pub(crate) fn parse(stdout: &[u8]) -> Option<HostOs> {
    let text = std::str::from_utf8(stdout).ok()?;
    let (system, release) = text.split_once("@@\n").or_else(|| text.split_once("@@\r\n"))?;
    match system.trim() {
        "Linux" => Some(linux(release)),
        "Darwin" => Some(HostOs::Macos),
        "FreeBSD" => Some(HostOs::FreeBsd),
        "OpenBSD" => Some(HostOs::OpenBsd),
        s if s.starts_with("CYGWIN_NT") || s.starts_with("MINGW") || s.starts_with("MSYS_NT") => Some(HostOs::Windows),
        _ => None,
    }
}

/// The distribution from `ID` (then each `ID_LIKE` word); a Linux whose release file names no
/// known distribution is plain Linux.
fn linux(release: &str) -> HostOs {
    let field = |key: &str| -> Option<String> {
        release.lines().find_map(|line| {
            let value = line.trim().strip_prefix(key)?.strip_prefix('=')?;
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            (value.len() <= 64).then(|| value.to_ascii_lowercase())
        })
    };
    let id = field("ID");
    let like = field("ID_LIKE").unwrap_or_default();
    id.iter().map(String::as_str).chain(like.split_whitespace()).find_map(distribution).unwrap_or(HostOs::Linux)
}

fn distribution(id: &str) -> Option<HostOs> {
    Some(match id {
        "ubuntu" => HostOs::Ubuntu,
        "debian" => HostOs::Debian,
        "raspbian" => HostOs::RaspberryPi,
        "fedora" => HostOs::Fedora,
        "rhel" | "rocky" | "almalinux" | "ol" => HostOs::RedHat,
        "centos" => HostOs::Centos,
        "alpine" => HostOs::Alpine,
        "arch" | "archarm" | "manjaro" | "endeavouros" => HostOs::Arch,
        "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" | "sles" | "suse" => HostOs::Suse,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux_with(release: &str) -> Option<HostOs> {
        parse(format!("Linux\n@@\n{release}").as_bytes())
    }

    #[test]
    fn distributions_map_from_id_then_id_like() {
        assert_eq!(linux_with("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n"), Some(HostOs::Ubuntu));
        assert_eq!(linux_with("ID=debian\n"), Some(HostOs::Debian));
        assert_eq!(linux_with("ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n"), Some(HostOs::RedHat));
        assert_eq!(linux_with("ID=\"almalinux\"\n"), Some(HostOs::RedHat));
        assert_eq!(linux_with("ID=\"centos\"\n"), Some(HostOs::Centos));
        assert_eq!(linux_with("ID=alpine\n"), Some(HostOs::Alpine));
        assert_eq!(linux_with("ID=arch\n"), Some(HostOs::Arch));
        assert_eq!(linux_with("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n"), Some(HostOs::Suse));
        assert_eq!(linux_with("ID=raspbian\nID_LIKE=debian\n"), Some(HostOs::RaspberryPi));
        // An unknown distribution falls back to what it is like, then to plain Linux.
        assert_eq!(linux_with("ID=pop\nID_LIKE=\"ubuntu debian\"\n"), Some(HostOs::Ubuntu));
        assert_eq!(linux_with("ID=nixos\n"), Some(HostOs::Linux));
        assert_eq!(linux_with(""), Some(HostOs::Linux), "no release file");
        // Keys are matched exactly: VERSION_ID or PLATFORM_ID never stand in for ID.
        assert_eq!(linux_with("VERSION_ID=\"ubuntu\"\nPLATFORM_ID=\"platform:el9\"\n"), Some(HostOs::Linux));
    }

    #[test]
    fn other_systems_map_from_uname() {
        assert_eq!(parse(b"Darwin\n@@\n"), Some(HostOs::Macos));
        assert_eq!(parse(b"FreeBSD\n@@\n"), Some(HostOs::FreeBsd));
        assert_eq!(parse(b"OpenBSD\n@@\n"), Some(HostOs::OpenBsd));
        assert_eq!(parse(b"MINGW64_NT-10.0-19045\n@@\n"), Some(HostOs::Windows));
    }

    #[test]
    fn anything_else_is_no_answer() {
        for out in [&b""[..], b"SunOS\n@@\n", b"garbage", b"\xff\xfe\n@@\n", b"Linux"] {
            assert_eq!(parse(out), None, "{out:?}");
        }
        // An over-long value is ignored rather than trusted.
        assert_eq!(linux_with(&format!("ID={}ubuntu\n", "x".repeat(80))), Some(HostOs::Linux));
    }

    #[test]
    fn the_command_is_fixed() {
        assert!(!COMMAND.contains('$'));
        assert!(COMMAND.contains("/etc/os-release"));
    }
}

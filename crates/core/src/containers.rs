//! P-33: container shells on the connected host (ADR 0011).
//!
//! Containers are listed with one fixed command on an exec channel of the session's verified
//! connection. Everything the server sends back is untrusted: names, images and statuses are kept
//! as plain text with control and direction-override characters removed, and an entry is shown
//! only when its ID is a container ID (`^[0-9a-f]{12,64}$`). A shell's command is built only from
//! the engine (chosen here from a fixed list) and such an ID; nothing else reaches the remote
//! shell. `sudo` is never added and nothing is retried with more privilege: the engine's own
//! error is reported as it is.

use tyrminal_contracts::{ContainerEngine, ContainerInfo, ContainerList, IpcError};

use crate::error::invalid;

/// Most entries kept from one listing.
pub(crate) const MAX_CONTAINERS: usize = 500;
/// Longest name, image or status kept, in characters.
const MAX_FIELD: usize = 256;
/// Longest engine error kept, in characters.
const MAX_PROBLEM: usize = 2048;
/// Largest listing output read, in bytes.
pub(crate) const MAX_LIST_OUTPUT: usize = 1024 * 1024;

const MARKER: &str = "tyrminal-engine=";

/// The listing command. Fixed text: it never contains anything from the user or the server.
/// Running containers only, full IDs, one JSON object per line from the engine's own template.
pub(crate) const LIST_COMMAND: &str = concat!(
    "if command -v docker >/dev/null 2>&1; then echo tyrminal-engine=docker; ",
    "exec docker ps --no-trunc --format ",
    r#"'{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"status":{{json .Status}}}'; "#,
    "elif command -v podman >/dev/null 2>&1; then echo tyrminal-engine=podman; ",
    "exec podman ps --no-trunc --format ",
    r#"'{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"status":{{json .Status}}}'; "#,
    "else echo tyrminal-engine=none; fi"
);

/// Whether `id` is a container ID: 12 to 64 lowercase hexadecimal characters, nothing else.
pub fn valid_id(id: &str) -> bool {
    (12..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether `token` is one of ours: 32 lowercase hexadecimal characters.
fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The command that opens a shell in container `id` (Bash when the container has it, else sh).
/// Refused unless `id` is a container ID; `token` is a random marker made by the app.
///
/// An engine does not end a process it started with `exec` when its client goes away (closing
/// the channel ends the client normally, with status 0), so the shell, and whatever it runs, would
/// stay in the container. The shell therefore carries `TYRMINAL_SHELL=<token>` in its environment,
/// which its children inherit, and once the client has ended, for any reason (the user left the
/// shell, the channel or the connection closed, the vault locked), the server ends every process
/// in the container that carries it: hang-up first, then, only if any were found, kill after a
/// second. A hang-up of the server-side shell itself is caught so the clean-up still runs. It all
/// runs on the server and needs nothing more from the app. Everything goes through
/// `sh -c '…'` with no single quote inside, so the user's login shell does not matter.
pub fn shell_command(engine: ContainerEngine, id: &str, token: &str) -> Result<String, IpcError> {
    if !valid_id(id) {
        return Err(invalid("That is not a container ID."));
    }
    if !valid_token(token) {
        return Err(invalid("That is not a shell marker."));
    }
    let program = match engine {
        ContainerEngine::Docker => "docker",
        ContainerEngine::Podman => "podman",
    };
    let mark = format!("TYRMINAL_SHELL={token}");
    // Inside the container: every process with our marker.
    let each = format!("for p in /proc/[0-9]*; do grep -qs {mark} \\$p/environ &&");
    let reap = format!(
        "f=; {each} kill -HUP \\${{p#/proc/}} && f=1; done; \
         [ -z \\$f ] || {{ sleep 1; {each} kill -KILL \\${{p#/proc/}}; done; }}"
    );
    Ok(format!(
        "exec sh -c 'reap() {{ {program} exec {id} sh -c \"{reap}\" >/dev/null 2>&1; }}; \
         trap \"reap; exit 129\" HUP TERM INT; \
         {program} exec -it -e {mark} {id} sh -c \"if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi\"; \
         s=$?; reap; exit $s'"
    ))
}

/// Untrusted text made safe to show: control characters (newlines and tabs included) and
/// bidirectional overrides/isolates removed, then bounded.
fn plain(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

#[derive(serde::Deserialize)]
struct Line {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    status: String,
}

/// Reads what [`LIST_COMMAND`] printed. `stderr` and `exit_status` belong to the engine.
pub(crate) fn parse_listing(stdout: &[u8], stderr: &[u8], exit_status: Option<u32>) -> Result<ContainerList, IpcError> {
    let stdout = String::from_utf8_lossy(stdout);
    // Startup files of the remote shell may print before the marker; only what follows it counts.
    let mut lines = stdout.lines().skip_while(|l| !l.trim().starts_with(MARKER));
    let engine = match lines.next().map(|l| l.trim().trim_start_matches(MARKER)) {
        Some("docker") => Some(ContainerEngine::Docker),
        Some("podman") => Some(ContainerEngine::Podman),
        Some("none") => None,
        _ => return Err(invalid("The server's answer to the container listing was not understood.")),
    };
    let mut list = ContainerList { engine, containers: Vec::new(), problem: None, skipped: 0 };
    if engine.is_none() {
        return Ok(list);
    }
    for line in lines.map(str::trim).filter(|l| !l.is_empty()) {
        match serde_json::from_str::<Line>(line) {
            Ok(entry) if valid_id(&entry.id) && list.containers.len() < MAX_CONTAINERS => {
                list.containers.push(ContainerInfo {
                    id: entry.id,
                    name: plain(&entry.name, MAX_FIELD),
                    image: plain(&entry.image, MAX_FIELD),
                    status: plain(&entry.status, MAX_FIELD),
                });
            }
            _ => list.skipped = list.skipped.saturating_add(1),
        }
    }
    if exit_status != Some(0) {
        let text = plain(&String::from_utf8_lossy(stderr).replace(['\n', '\r', '\t'], " "), MAX_PROBLEM);
        list.problem = Some(if text.is_empty() {
            match exit_status {
                Some(code) => format!("The container engine ended with status {code}."),
                None => "The container engine ended without a status.".to_owned(),
            }
        } else {
            text
        });
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a";

    fn json(id: &str, name: &str) -> String {
        serde_json::json!({ "id": id, "name": name, "image": "nginx:1.27", "status": "Up 3 hours" }).to_string()
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn container_ids_are_twelve_to_sixty_four_lowercase_hex_characters() {
        assert!(valid_id(&ID[..12]));
        assert!(valid_id(ID));
        for bad in [
            "",
            &ID[..11],
            &format!("{ID}0"),
            &ID.to_uppercase(),
            "4f1c2b3a9d8g",
            "4f1c2b3a9d8e; rm -rf /",
            "4f1c2b3a9d8e'",
            "4f1c2b3a9d8e$(id)",
            "4f1c2b3a9d8e`id`",
            "4f1c2b3a9d8e\n",
            " 4f1c2b3a9d8e",
            "--privileged",
            "my-container",
            "４f1c2b3a9d8e",
        ] {
            assert!(!valid_id(bad), "{bad:?}");
            assert!(shell_command(ContainerEngine::Docker, bad, TOKEN).is_err(), "{bad:?}");
        }
        for bad in ["", "0123", &TOKEN.to_uppercase(), &format!("{TOKEN}0"), "0123456789abcdef0123456789abcde'"] {
            assert!(shell_command(ContainerEngine::Docker, ID, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_shell_command_holds_only_fixed_text_the_engine_the_id_and_the_marker() {
        for (engine, program) in [(ContainerEngine::Docker, "docker"), (ContainerEngine::Podman, "podman")] {
            let command = shell_command(engine, &ID[..12], TOKEN).unwrap();
            // One single-quoted script for `sh`, whatever the login shell is.
            assert!(command.starts_with("exec sh -c '") && command.ends_with('\''), "{command}");
            assert_eq!(command.matches('\'').count(), 2, "{command}");
            assert!(command.contains(&format!("{program} exec -it -e TYRMINAL_SHELL={TOKEN} {} sh -c", &ID[..12])));
            // The clean-up runs when the client ends and on a hang-up, in the same container, for
            // our marker only.
            assert!(command.contains("trap \"reap; exit 129\" HUP TERM INT"), "{command}");
            assert!(command.ends_with("s=$?; reap; exit $s'"), "{command}");
            assert!(command.contains(&format!("reap() {{ {program} exec {} sh -c", &ID[..12])), "{command}");
            assert_eq!(command.matches(&format!("grep -qs TYRMINAL_SHELL={TOKEN} ")).count(), 2);
            assert!(command.contains("[ -z \\$f ] || { sleep 1;"), "{command}");
            assert!(!command.contains("sudo"));
            // Nothing but fixed text, the program, the ID and the marker.
            let stripped = command.replace(&ID[..12], "").replace(TOKEN, "").replace(program, "");
            assert!(!stripped.contains("docker") && !stripped.contains("podman"));
        }
    }

    #[test]
    fn the_listing_command_is_fixed_and_never_asks_for_privilege() {
        assert!(!LIST_COMMAND.contains("sudo"));
        assert!(LIST_COMMAND.contains("docker ps --no-trunc --format"));
        assert!(LIST_COMMAND.contains("podman ps --no-trunc --format"));
    }

    #[test]
    fn hostile_names_and_ids_from_the_server_stay_plain_text_or_are_left_out() {
        let stdout = [
            "Welcome to the server!".to_owned(),
            "tyrminal-engine=docker".to_owned(),
            json(ID, "web\u{1b}]0;pwned\u{7}\u{202e}gnp.exe\n\r\tend"),
            json(&ID[..12], "<img src=x onerror=alert(1)>"),
            json("NOT-AN-ID", "evil"),
            json(&format!("{ID}; reboot"), "evil"),
            json(&ID.to_uppercase(), "evil"),
            r#"{"id": 42}"#.to_owned(),
            "not json at all".to_owned(),
            json(&ID[..20], &"x".repeat(10_000)),
        ]
        .join("\n");
        let list = parse_listing(stdout.as_bytes(), b"", Some(0)).unwrap();
        assert_eq!(list.engine, Some(ContainerEngine::Docker));
        assert_eq!(list.problem, None);
        assert_eq!(list.skipped, 5);
        let names: Vec<&str> = list.containers.iter().map(|c| c.name.as_str()).collect();
        // Escapes, newlines, tabs and direction overrides are gone; markup is kept as text.
        assert_eq!(names[0], "web]0;pwnedgnp.exeend");
        assert_eq!(names[1], "<img src=x onerror=alert(1)>");
        assert_eq!(names[2].chars().count(), MAX_FIELD);
        assert!(list.containers.iter().all(|c| valid_id(&c.id)));
    }

    #[test]
    fn listings_are_bounded() {
        let mut lines = vec!["tyrminal-engine=podman".to_owned()];
        for i in 0..MAX_CONTAINERS + 7 {
            lines.push(json(&format!("{i:012x}"), "c"));
        }
        let list = parse_listing(lines.join("\n").as_bytes(), b"", Some(0)).unwrap();
        assert_eq!(list.engine, Some(ContainerEngine::Podman));
        assert_eq!((list.containers.len(), list.skipped), (MAX_CONTAINERS, 7));
    }

    #[test]
    fn no_engine_and_engine_errors_are_reported_as_they_are() {
        let none = parse_listing(b"tyrminal-engine=none\n", b"", Some(0)).unwrap();
        assert_eq!((none.engine, none.containers.len(), none.problem), (None, 0, None));

        let denied = parse_listing(
            b"tyrminal-engine=docker\n",
            b"permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
            Some(1),
        )
        .unwrap();
        assert_eq!(denied.engine, Some(ContainerEngine::Docker));
        assert_eq!(
            denied.problem.as_deref(),
            Some(
                "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
            )
        );
        let silent = parse_listing(b"tyrminal-engine=podman\n", b"", Some(125)).unwrap();
        assert_eq!(silent.problem.as_deref(), Some("The container engine ended with status 125."));
        let hostile = parse_listing(b"tyrminal-engine=podman\n", "bad\u{1b}[2J\u{202e}x".as_bytes(), Some(2)).unwrap();
        assert_eq!(hostile.problem.as_deref(), Some("bad[2Jx"));
    }

    #[test]
    fn an_answer_without_the_marker_or_with_an_unknown_engine_is_refused() {
        assert!(parse_listing(b"", b"", Some(0)).is_err());
        assert!(parse_listing(b"docker ps output\n", b"", Some(0)).is_err());
        assert!(parse_listing(b"tyrminal-engine=lxc\n", b"", Some(0)).is_err());
        assert!(parse_listing(b"tyrminal-engine=docker; rm -rf /\n", b"", Some(0)).is_err());
    }
}

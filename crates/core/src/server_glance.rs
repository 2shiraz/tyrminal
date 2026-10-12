//! Server at a glance (P-32, ADR 0011): reads uptime, load, memory and disk use over a separate
//! exec channel of a verified SSH connection.
//!
//! The command is a constant: nothing typed by the user or sent by the server is ever put into
//! it, and nothing is typed into the user's shell. The answer is untrusted: it is parsed strictly,
//! and a value that does not parse is left out (`None`), never guessed.

use std::time::Duration;

use tyrminal_contracts::limits::MAX_GLANCE_DISKS;
use tyrminal_contracts::{DiskUse, GlanceUnavailable, MemoryUse, ServerGlance, ServerStats};
use tyrminal_ssh::VerifiedConnection;

/// The fixed command. `uname -s` comes first so a non-Linux server is recognised before anything
/// else is read; `/proc` and `df -P` (POSIX output, 1024-byte blocks) give the values.
pub(crate) const COMMAND: &str = "LC_ALL=C; export LC_ALL; uname -s; echo @@; cat /proc/uptime; echo @@; \
cat /proc/loadavg; echo @@; cat /proc/meminfo; echo @@; df -P -k";

/// More output than this is refused (a real answer is a few KiB).
const MAX_OUTPUT: usize = 64 * 1024;
const LIMIT: Duration = Duration::from_secs(10);
const SEPARATOR: &str = "@@";
/// Bounds that no real server reaches; a larger value is treated as malformed.
const MAX_UPTIME_SECONDS: u64 = 100 * 365 * 24 * 3600;
const MAX_LOAD: f64 = 1_000_000.0;
/// 1 EiB in KiB.
const MAX_KIB: u64 = 1 << 50;
const MAX_MOUNT_LEN: usize = 512;

/// Runs the command on its own channel and parses the answer.
pub(crate) async fn fetch(conn: &VerifiedConnection) -> ServerGlance {
    match conn.exec(COMMAND, MAX_OUTPUT, LIMIT).await {
        Ok(out) => parse(&out.stdout),
        Err(_) => ServerGlance::NotAvailable { reason: GlanceUnavailable::Failed },
    }
}

/// Parses the command's standard output. Standard error and the exit status are not used: `df`
/// fails on an unreadable mount while the rest of its answer is still good.
pub(crate) fn parse(stdout: &[u8]) -> ServerGlance {
    let malformed = ServerGlance::NotAvailable { reason: GlanceUnavailable::Malformed };
    let Ok(text) = std::str::from_utf8(stdout) else { return malformed };
    let mut sections: Vec<Vec<&str>> = vec![Vec::new()];
    for line in text.lines() {
        if line == SEPARATOR {
            sections.push(Vec::new());
        } else if let Some(last) = sections.last_mut() {
            last.push(line);
        }
    }
    let [system, uptime, load, memory, disks] = sections.as_slice() else { return malformed };
    if system.as_slice() != ["Linux"] {
        return match system.as_slice() {
            [name] if is_system_name(name) => ServerGlance::NotAvailable { reason: GlanceUnavailable::NotLinux },
            _ => malformed,
        };
    }
    let stats = ServerStats {
        uptime_seconds: parse_uptime(uptime),
        load: parse_load(load),
        memory: parse_memory(memory),
        disks: parse_disks(disks),
    };
    if stats.uptime_seconds.is_none() && stats.load.is_none() && stats.memory.is_none() && stats.disks.is_none() {
        return malformed;
    }
    ServerGlance::Available { stats }
}

/// What `uname -s` prints on any system: a short word.
fn is_system_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// A non-negative decimal such as `12.34`: digits, at most one dot, nothing else.
fn decimal(text: &str) -> Option<f64> {
    let (int, frac) = text.split_once('.').unwrap_or((text, ""));
    if int.is_empty() || int.len() > 12 || frac.len() > 6 {
        return None;
    }
    if !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if text.ends_with('.') {
        return None;
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Digits only (no sign, no spaces), within `max`.
fn whole(text: &str, max: u64) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok().filter(|v| *v <= max)
}

/// `/proc/uptime`: one line, `<seconds up> <seconds idle>`.
fn parse_uptime(lines: &[&str]) -> Option<u64> {
    let [line] = lines else { return None };
    let [up, idle] = line.split(' ').collect::<Vec<_>>()[..] else { return None };
    decimal(idle)?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let seconds = decimal(up)?.floor() as u64;
    (seconds <= MAX_UPTIME_SECONDS).then_some(seconds)
}

/// `/proc/loadavg`: one line, `<1m> <5m> <15m> <running>/<total> <last pid>`.
fn parse_load(lines: &[&str]) -> Option<[f64; 3]> {
    let [line] = lines else { return None };
    let [a, b, c, tasks, pid] = line.split(' ').collect::<Vec<_>>()[..] else { return None };
    let (running, total) = tasks.split_once('/')?;
    whole(running, u64::from(u32::MAX))?;
    whole(total, u64::from(u32::MAX))?;
    whole(pid, u64::from(u32::MAX))?;
    let load = [decimal(a)?, decimal(b)?, decimal(c)?];
    load.iter().all(|v| *v <= MAX_LOAD).then_some(load)
}

/// `/proc/meminfo`: `MemTotal:` and `MemAvailable:` lines, each `<name>: <spaces><n> kB`. A
/// repeated or misshapen line for either makes memory unavailable; other lines are not read.
fn parse_memory(lines: &[&str]) -> Option<MemoryUse> {
    let mut total = None;
    let mut available = None;
    for line in lines {
        let (name, rest) = line.split_once(':')?;
        let slot = match name {
            "MemTotal" => &mut total,
            "MemAvailable" => &mut available,
            _ => continue,
        };
        let value = rest.trim_start_matches(' ').strip_suffix(" kB")?;
        if slot.replace(whole(value, MAX_KIB)?).is_some() {
            return None;
        }
    }
    let (total_kib, available_kib) = (total?, available?);
    (available_kib <= total_kib && total_kib > 0).then_some(MemoryUse { total_kib, available_kib })
}

/// `df -P -k`: a header, then `<filesystem> <total> <used> <available> <n>% <mount>` rows. Only
/// `/` and filesystems on block devices are kept (not tmpfs, proc and the like). Any row that
/// does not have that shape makes the disks unavailable, rather than showing a partial list.
fn parse_disks(lines: &[&str]) -> Option<Vec<DiskUse>> {
    let (header, rows) = lines.split_first()?;
    let head: Vec<&str> = header.split_whitespace().collect();
    if head.first() != Some(&"Filesystem") || head.get(1) != Some(&"1024-blocks") {
        return None;
    }
    let mut out: Vec<DiskUse> = Vec::new();
    for row in rows {
        // The mount point is the rest of the line after the capacity column (it may hold spaces).
        let (fields, mount) = leading_fields::<5>(row)?;
        let [device, total, used, available, capacity] = fields;
        let total_kib = whole(total, MAX_KIB)?;
        let used_kib = whole(used, MAX_KIB)?;
        let available_kib = whole(available, MAX_KIB)?;
        // `-` is what df prints for a filesystem without blocks.
        if capacity != "-" {
            whole(capacity.strip_suffix('%')?, 100)?;
        }
        if used_kib > total_kib || available_kib > total_kib {
            return None;
        }
        if !mount.starts_with('/') || mount.len() > MAX_MOUNT_LEN || mount.chars().any(char::is_control) {
            return None;
        }
        let real = mount == "/" || device.starts_with("/dev/");
        if real && total_kib > 0 && !out.iter().any(|d| d.mount == mount) && out.len() < MAX_GLANCE_DISKS {
            out.push(DiskUse { mount: mount.to_owned(), total_kib, used_kib, available_kib });
        }
    }
    Some(out)
}

/// The first `N` space-separated fields of `line` and the rest of it (without its leading spaces).
fn leading_fields<const N: usize>(line: &str) -> Option<([&str; N], &str)> {
    let mut fields = [""; N];
    let mut rest = line;
    for field in &mut fields {
        rest = rest.trim_start_matches(' ');
        let end = rest.find(' ')?;
        *field = &rest[..end];
        rest = &rest[end..];
    }
    Some((fields, rest.trim_start_matches(' ')))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DF: &str = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n\
overlay           61202244 21893584  36167700      38% /\n\
tmpfs                65536        0     65536       0% /dev\n\
/dev/vda1         61202244 21893584  36167700      38% /etc/hosts\n\
/dev/vdb1          1000000   250000    750000      25% /srv/data dir\n";

    fn answer(system: &str, uptime: &str, load: &str, memory: &str, df: &str) -> Vec<u8> {
        format!("{system}\n@@\n{uptime}\n@@\n{load}\n@@\n{memory}\n@@\n{df}").into_bytes()
    }

    fn good() -> Vec<u8> {
        answer(
            "Linux",
            "93784.52 180000.10",
            "0.15 0.30 0.45 2/321 4567",
            "MemTotal:        2048000 kB\nMemFree:          100000 kB\nMemAvailable:    1024000 kB\nCached:  5 kB",
            DF,
        )
    }

    fn stats(glance: ServerGlance) -> ServerStats {
        match glance {
            ServerGlance::Available { stats } => stats,
            other => panic!("expected stats, got {other:?}"),
        }
    }

    #[test]
    fn a_linux_answer_is_read() {
        let s = stats(parse(&good()));
        assert_eq!(s.uptime_seconds, Some(93_784));
        assert_eq!(s.load, Some([0.15, 0.30, 0.45]));
        assert_eq!(s.memory, Some(MemoryUse { total_kib: 2_048_000, available_kib: 1_024_000 }));
        let disks = s.disks.unwrap();
        let mounts: Vec<&str> = disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/etc/hosts", "/srv/data dir"]);
        assert_eq!(disks[2].used_kib, 250_000);
    }

    #[test]
    fn another_system_is_not_available_and_garbage_is_malformed() {
        for system in ["Darwin", "FreeBSD", "MINGW64_NT-10.0", "linux"] {
            let out = answer(system, "", "", "", "");
            assert_eq!(parse(&out), ServerGlance::NotAvailable { reason: GlanceUnavailable::NotLinux }, "{system}");
        }
        for out in [
            &b""[..],
            b"Linux",
            b"\xff\xfe@@",
            b"Linux\n@@\n@@\n@@\n@@\n@@\n@@\n",
            b"Linux \n@@\n1 1\n@@\n@@\n@@\n",
            b"Linux\nLinux\n@@\n1 1\n@@\n@@\n@@\n",
            b"\x1b]0;owned\x07\n@@\n@@\n@@\n@@\n",
        ] {
            assert_eq!(
                parse(out),
                ServerGlance::NotAvailable { reason: GlanceUnavailable::Malformed },
                "{:?}",
                String::from_utf8_lossy(out)
            );
        }
        // Linux, but nothing in the expected form.
        let out = answer("Linux", "soon", "high", "lots", "full");
        assert_eq!(parse(&out), ServerGlance::NotAvailable { reason: GlanceUnavailable::Malformed });
    }

    #[test]
    fn a_misshapen_value_is_unavailable_and_never_guessed() {
        for uptime in [
            "-5.0 1.0",
            "1e9 1.0",
            "NaN 1.0",
            "inf 1.0",
            "12.5",
            "12.5 1.0 3",
            " 12.5 1.0",
            "12. 1.0",
            "99999999999.0 1.0",
            "1,5 2",
        ] {
            let out = answer("Linux", uptime, "0.15 0.30 0.45 2/321 4567", "", "");
            assert_eq!(stats(parse(&out)).uptime_seconds, None, "{uptime}");
        }
        for load in [
            "0.15 0.30 0.45",
            "-1 0 0 1/2 3",
            "0.1 0.2 0.3 x/2 3",
            "1e3 0 0 1/2 3",
            "0.1  0.2 0.3 1/2 3",
            "9999999.0 0 0 1/2 3",
            "0.1 0.2 0.3 1/2 3 extra",
        ] {
            let out = answer("Linux", "1.0 1.0", load, "", "");
            assert_eq!(stats(parse(&out)).load, None, "{load}");
        }
        for memory in [
            "MemTotal: 100 kB",
            "MemTotal: 100 kB\nMemAvailable: 200 kB",
            "MemTotal: 100 MB\nMemAvailable: 50 kB",
            "MemTotal: -100 kB\nMemAvailable: 50 kB",
            "MemTotal: 100 kB\nMemTotal: 999 kB\nMemAvailable: 50 kB",
            "MemTotal: 0 kB\nMemAvailable: 0 kB",
            "MemTotal: 99999999999999999999 kB\nMemAvailable: 50 kB",
            "MemTotal: 100 kB\nnot a meminfo line\nMemAvailable: 50 kB",
        ] {
            let out = answer("Linux", "1.0 1.0", "", memory, "");
            assert_eq!(stats(parse(&out)).memory, None, "{memory:?}");
        }
        let header = "Filesystem 1024-blocks Used Available Capacity Mounted on";
        for row in [
            "/dev/sda1 100 50 50 50% relative",
            "/dev/sda1 100 150 50 150% /",
            "/dev/sda1 100 50 500 50% /",
            "/dev/sda1 100 50 50 fifty /",
            "/dev/sda1 100 -50 50 50% /",
            "/dev/sda1 100 50 50 50%",
            "/dev/sda1 100 50",
            "/dev/sda1 100 50 50 50% /mnt/\u{1b}[31mred",
            "/dev/sda1 100 50 50 50% /mnt/\u{7}bell",
        ] {
            let out = answer("Linux", "1.0 1.0", "", "", &format!("{header}\n{row}\n"));
            assert_eq!(stats(parse(&out)).disks, None, "{row:?}");
        }
        let out = answer("Linux", "1.0 1.0", "", "", "Filesystem 512-blocks Used Available Capacity Mounted on\n");
        assert_eq!(stats(parse(&out)).disks, None, "other block size");
    }

    #[test]
    fn the_disk_list_is_bounded_and_skips_pseudo_filesystems() {
        let mut df = String::from("Filesystem 1024-blocks Used Available Capacity Mounted on\n");
        for i in 0..40 {
            df.push_str(&format!("/dev/loop{i} 100 10 90 10% /snap/{i}\n"));
            df.push_str(&format!("proc 0 0 0 - /proc/{i}\n"));
        }
        let out = answer("Linux", "1.0 1.0", "", "", &df);
        let disks = stats(parse(&out)).disks.unwrap();
        assert_eq!(disks.len(), MAX_GLANCE_DISKS);
        assert!(disks.iter().all(|d| d.mount.starts_with("/snap/")));
    }

    #[test]
    fn the_command_is_fixed() {
        // Nothing is ever formatted into it: it is a constant with no placeholders.
        assert!(!COMMAND.contains('{') && !COMMAND.contains('$'));
        assert!(COMMAND.starts_with("LC_ALL=C;"));
    }
}

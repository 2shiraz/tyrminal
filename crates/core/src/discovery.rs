//! LAN discovery (HST-14): DNS-SD browsing for SSH servers (`_ssh._tcp.local.`) on one network
//! interface the user picked, for a bounded time, started only by the user (spec: LAN discovery
//! needs a user-selected scope and an explicit start).
//!
//! Announcements come from any machine on the network, so everything in them is untrusted: names
//! are cleaned of control and bidirectional-override characters and bounded, host names must be
//! plain DNS names, addresses must be usable unicast addresses, and the number of results is
//! capped. Results are only shown; nothing is saved, trusted or connected to from here. Adding a
//! result opens the normal host editor, and connecting verifies the host key as for any host.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent};
use tyrminal_contracts::{DiscoveredService, DiscoveryNetwork, DiscoveryStatus, ErrorCode, IpcError};

use crate::error::{err, invalid};

/// The DNS-SD service type browsed for.
pub const SSH_SERVICE_TYPE: &str = "_ssh._tcp.local.";
/// How long a browse listens before it stops by itself.
pub const BROWSE_DURATION: Duration = Duration::from_secs(30);
/// Services kept per browse; further answers are dropped (and reported as truncated).
const MAX_FOUND: usize = 64;
/// Addresses kept per service.
const MAX_ADDRESSES: usize = 4;
/// Characters kept of an instance name (a DNS label is at most 63 bytes).
const MAX_NAME_CHARS: usize = 63;
/// Longest DNS host name.
const MAX_HOST_LEN: usize = 253;
/// How often the worker checks for a stop request while waiting for answers.
const POLL: Duration = Duration::from_millis(200);

/// Network interfaces that can be browsed: up, not loopback, not point-to-point, with at least one
/// address. Sorted by name.
pub fn networks() -> Vec<DiscoveryNetwork> {
    let mut by_name: BTreeMap<String, Vec<IpAddr>> = BTreeMap::new();
    for intf in if_addrs::get_if_addrs().unwrap_or_default() {
        if intf.is_loopback() || !intf.is_oper_up() || intf.is_p2p() {
            continue;
        }
        by_name.entry(intf.name.clone()).or_default().push(intf.ip());
    }
    by_name
        .into_iter()
        .filter(|(name, _)| interface_name_ok(name))
        .map(|(id, mut ips)| {
            ips.sort_by_key(|ip| (ip.is_ipv6(), *ip));
            ips.dedup();
            DiscoveryNetwork { id, addresses: ips.iter().map(ToString::to_string).collect() }
        })
        .collect()
}

/// Interface names are shown and passed back as text: any characters but controls (Windows names
/// such as `Ethernet 2` have spaces and may be localised), at most 256 bytes.
fn interface_name_ok(name: &str) -> bool {
    (1..=256).contains(&name.len()) && !name.chars().any(char::is_control) && name.trim() == name
}

/// Removes control, format and bidirectional-override characters, collapses the rest to one line
/// and keeps at most `max` characters.
pub(crate) fn clean_text(text: &str, max: usize) -> String {
    let kept: String = text
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}')
        })
        .take(max)
        .collect();
    kept.trim().to_owned()
}

/// A plain DNS host name (letters, digits, hyphens; labels of 1–63), without the trailing dot.
pub(crate) fn clean_host(host: &str) -> Option<String> {
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    let ok = !host.is_empty()
        && host.len() <= MAX_HOST_LEN
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    ok.then_some(host)
}

/// Addresses a host entry can use: unicast, not unspecified; IPv6 link-local addresses are left
/// out because they need an interface scope a saved host cannot carry. IPv4 first, at most four.
pub(crate) fn clean_addresses(addresses: impl IntoIterator<Item = IpAddr>) -> Vec<String> {
    let mut usable: Vec<IpAddr> = addresses
        .into_iter()
        .filter(|ip| !ip.is_unspecified() && !ip.is_multicast())
        .filter(|ip| match ip {
            IpAddr::V4(v4) => !v4.is_broadcast(),
            IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
        })
        .collect();
    usable.sort_by_key(|ip| (ip.is_ipv6(), *ip));
    usable.dedup();
    usable.truncate(MAX_ADDRESSES);
    usable.iter().map(ToString::to_string).collect()
}

/// The instance part of a DNS-SD full name (`Build\032server._ssh._tcp.local.` → `Build server`).
fn instance_name(fullname: &str, ty_domain: &str) -> String {
    let raw = fullname.strip_suffix(ty_domain).map_or(fullname, |s| s.strip_suffix('.').unwrap_or(s));
    clean_text(&unescape_dns(raw), MAX_NAME_CHARS)
}

/// Undoes DNS presentation escapes (`\.`, `\\`, `\DDD`); malformed escapes are kept as written.
fn unescape_dns(text: &str) -> String {
    let mut out = Vec::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            let digits = bytes.get(i + 1..i + 4).filter(|d| d.iter().all(u8::is_ascii_digit));
            if let Some(value) = digits.and_then(|d| std::str::from_utf8(d).ok()?.parse::<u8>().ok()) {
                out.push(value);
                i += 4;
                continue;
            }
            if let Some(next) = bytes.get(i + 1) {
                out.push(*next);
                i += 2;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One announcement turned into a result, or `None` when nothing usable is left of it.
pub(crate) fn clean_service(
    fullname: &str,
    ty_domain: &str,
    host: &str,
    port: u16,
    addresses: impl IntoIterator<Item = IpAddr>,
) -> Option<DiscoveredService> {
    let host = clean_host(host).unwrap_or_default();
    let addresses = clean_addresses(addresses);
    if port == 0 || (host.is_empty() && addresses.is_empty()) {
        return None;
    }
    let mut name = instance_name(fullname, ty_domain);
    if name.is_empty() {
        name = if host.is_empty() { addresses[0].clone() } else { host.clone() };
    }
    Some(DiscoveredService { name, host, addresses, port })
}

#[derive(Default)]
struct Found {
    services: BTreeMap<String, DiscoveredService>,
    truncated: bool,
}

struct Browse {
    found: Mutex<Found>,
    stop: AtomicBool,
    done: AtomicBool,
    ends_at: Instant,
}

impl Browse {
    fn status(&self) -> DiscoveryStatus {
        let found = self.found.lock().unwrap_or_else(|p| p.into_inner());
        let mut services: Vec<_> = found.services.values().cloned().collect();
        services.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.host.cmp(&b.host)));
        let running = !self.done.load(Ordering::Acquire);
        let left = self.ends_at.saturating_duration_since(Instant::now());
        DiscoveryStatus {
            running,
            seconds_left: if running {
                u32::try_from(left.as_secs() + u64::from(left.subsec_nanos() > 0)).unwrap_or(0)
            } else {
                0
            },
            found: services,
            truncated: found.truncated,
        }
    }

    fn record(&self, key: String, service: DiscoveredService) {
        let mut found = self.found.lock().unwrap_or_else(|p| p.into_inner());
        if found.services.len() >= MAX_FOUND && !found.services.contains_key(&key) {
            found.truncated = true;
            return;
        }
        found.services.insert(key, service);
    }

    fn forget(&self, key: &str) {
        self.found.lock().unwrap_or_else(|p| p.into_inner()).services.remove(key);
    }
}

fn discovery_error() -> IpcError {
    err(ErrorCode::IoError, "Looking for servers on this network could not start. Check that the network is connected.")
}

/// Browses per window: one browse at a time for each window.
#[derive(Default)]
pub struct Discovery {
    browses: Mutex<HashMap<String, Arc<Browse>>>,
}

impl std::fmt::Debug for Discovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Discovery")
    }
}

impl Discovery {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Starts browsing on the network `network_id` (one of [`networks`]) for [`BROWSE_DURATION`],
    /// replacing this window's previous browse.
    pub fn start(&self, owner: &str, network_id: &str) -> Result<DiscoveryStatus, IpcError> {
        if !networks().iter().any(|n| n.id == network_id) {
            return Err(invalid("That network is not available. Choose one from the list."));
        }
        self.start_on_interface(owner, network_id, BROWSE_DURATION)
    }

    /// Starts browsing on the interface named `interface` without checking it against
    /// [`networks`] (tests use the loopback interface). The adapter calls [`Self::start`].
    pub fn start_on_interface(
        &self,
        owner: &str,
        interface: &str,
        duration: Duration,
    ) -> Result<DiscoveryStatus, IpcError> {
        if !interface_name_ok(interface) {
            return Err(invalid("That network is not available. Choose one from the list."));
        }
        self.stop(owner);
        let daemon = ServiceDaemon::new().map_err(|_| discovery_error())?;
        // Every interface off, then only the chosen one on (selections apply in order).
        let scoped = daemon
            .disable_interface(IfKind::All)
            .and_then(|()| daemon.enable_interface(IfKind::Name(interface.to_owned())))
            .and_then(|()| daemon.browse(SSH_SERVICE_TYPE));
        let receiver = match scoped {
            Ok(receiver) => receiver,
            Err(_) => {
                let _ = daemon.shutdown();
                return Err(discovery_error());
            }
        };
        let browse = Arc::new(Browse {
            found: Mutex::new(Found::default()),
            stop: AtomicBool::new(false),
            done: AtomicBool::new(false),
            ends_at: Instant::now() + duration,
        });
        let worker = Arc::clone(&browse);
        let spawned = std::thread::Builder::new().name("lan-discovery".into()).spawn(move || {
            loop {
                let left = worker.ends_at.saturating_duration_since(Instant::now());
                if worker.stop.load(Ordering::Acquire) || left.is_zero() {
                    break;
                }
                match receiver.recv_timeout(left.min(POLL)) {
                    Ok(ServiceEvent::ServiceResolved(service)) => {
                        let addresses = service.addresses.iter().map(mdns_sd::ScopedIp::to_ip_addr);
                        if let Some(found) =
                            clean_service(&service.fullname, &service.ty_domain, &service.host, service.port, addresses)
                        {
                            worker.record(service.fullname.clone(), found);
                        }
                    }
                    Ok(ServiceEvent::ServiceRemoved(_, fullname)) => worker.forget(&fullname),
                    Ok(_) | Err(mdns_sd::RecvTimeoutError::Timeout) => {}
                    Err(mdns_sd::RecvTimeoutError::Disconnected) => break,
                }
            }
            let _ = daemon.stop_browse(SSH_SERVICE_TYPE);
            let _ = daemon.shutdown();
            worker.done.store(true, Ordering::Release);
        });
        if spawned.is_err() {
            return Err(discovery_error());
        }
        let status = browse.status();
        self.browses.lock().unwrap_or_else(|p| p.into_inner()).insert(owner.to_owned(), browse);
        Ok(status)
    }

    /// This window's browse: running or finished, with what it found. Nothing running and nothing
    /// found when the window never started one.
    pub fn status(&self, owner: &str) -> DiscoveryStatus {
        self.browses
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(owner)
            .map_or(DiscoveryStatus { running: false, seconds_left: 0, found: Vec::new(), truncated: false }, |b| {
                b.status()
            })
    }

    /// Stops this window's browse (results stay readable until the next start).
    pub fn stop(&self, owner: &str) {
        if let Some(browse) = self.browses.lock().unwrap_or_else(|p| p.into_inner()).get(owner) {
            browse.stop.store(true, Ordering::Release);
        }
    }

    /// Stops this window's browse and forgets its results (the window closed).
    pub fn forget(&self, owner: &str) {
        if let Some(browse) = self.browses.lock().unwrap_or_else(|p| p.into_inner()).remove(owner) {
            browse.stop.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn names_lose_controls_and_overrides_and_are_bounded() {
        assert_eq!(clean_text("Build\u{1b}[31m server\u{202e}lmth.exe\n", 63), "Build[31m serverlmth.exe");
        assert_eq!(clean_text(&"x".repeat(500), MAX_NAME_CHARS).chars().count(), MAX_NAME_CHARS);
        assert_eq!(unescape_dns(r"Build\032server\.lab\\x\9"), r"Build server.lab\x9");
        assert_eq!(instance_name(r"Build\032server._ssh._tcp.local.", SSH_SERVICE_TYPE), "Build server");
    }

    #[test]
    fn host_names_must_be_plain_dns_names() {
        assert_eq!(clean_host("Build-1.local.").as_deref(), Some("build-1.local"));
        for bad in [
            "",
            ".",
            "a..local.",
            "-a.local.",
            "a-.local.",
            "evil host.local.",
            "a_b.local.",
            "é.local.",
            &format!("{}.local.", "a".repeat(64)),
        ] {
            assert_eq!(clean_host(bad), None, "{bad:?}");
        }
        assert_eq!(clean_host(&format!("{}.local", vec!["a".repeat(63); 4].join("."))), None, "longer than 253");
    }

    #[test]
    fn only_usable_unicast_addresses_are_kept_ipv4_first() {
        let ips = [
            IpAddr::V6("2001:db8::5".parse::<Ipv6Addr>().unwrap()),
            IpAddr::V6("fe80::1".parse::<Ipv6Addr>().unwrap()),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::BROADCAST),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)),
        ];
        assert_eq!(clean_addresses(ips), vec!["192.0.2.10".to_owned(), "2001:db8::5".to_owned()]);
        let many = (1..=9).map(|i| IpAddr::V4(Ipv4Addr::new(192, 0, 2, i)));
        assert_eq!(clean_addresses(many).len(), MAX_ADDRESSES);
    }

    #[test]
    fn a_service_needs_a_port_and_somewhere_to_connect() {
        let ip = [IpAddr::V4(Ipv4Addr::new(192, 0, 2, 7))];
        let ok = clean_service("nas._ssh._tcp.local.", SSH_SERVICE_TYPE, "nas.local.", 22, ip).unwrap();
        assert_eq!((ok.name.as_str(), ok.host.as_str(), ok.port), ("nas", "nas.local", 22));
        assert_eq!(ok.addresses, vec!["192.0.2.7".to_owned()]);
        assert!(clean_service("nas._ssh._tcp.local.", SSH_SERVICE_TYPE, "nas.local.", 0, ip).is_none());
        assert!(clean_service("nas._ssh._tcp.local.", SSH_SERVICE_TYPE, "bad host.", 22, []).is_none());
        // A name made only of controls falls back to the host name.
        let unnamed =
            clean_service("\u{7}\u{202e}._ssh._tcp.local.", SSH_SERVICE_TYPE, "nas.local.", 2222, []).unwrap();
        assert_eq!(unnamed.name, "nas.local");
        assert!(unnamed.addresses.is_empty());
    }

    #[test]
    fn results_are_capped() {
        let browse = Browse {
            found: Mutex::new(Found::default()),
            stop: AtomicBool::new(false),
            done: AtomicBool::new(true),
            ends_at: Instant::now(),
        };
        let service = |i: usize| DiscoveredService {
            name: format!("s{i}"),
            host: String::new(),
            addresses: vec!["192.0.2.1".into()],
            port: 22,
        };
        for i in 0..MAX_FOUND + 5 {
            browse.record(format!("s{i}"), service(i));
        }
        let status = browse.status();
        assert_eq!(status.found.len(), MAX_FOUND);
        assert!(status.truncated && !status.running && status.seconds_left == 0);
    }

    #[test]
    fn unknown_networks_are_refused() {
        let discovery = Discovery::default();
        assert!(discovery.start("main", "no-such-interface-xyz").is_err());
        assert!(discovery.start_on_interface("main", "bad\nname", Duration::from_secs(1)).is_err());
        assert!(discovery.start_on_interface("main", "", Duration::from_secs(1)).is_err());
        assert!(!discovery.status("main").running);
        assert!(interface_name_ok("Ethernet 2") && interface_name_ok("lo0"));
        assert!(networks().iter().all(|n| !n.addresses.is_empty() && interface_name_ok(&n.id)));
    }
}

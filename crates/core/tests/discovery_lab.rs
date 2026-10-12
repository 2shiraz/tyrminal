//! LAN discovery (HST-14) against a real DNS-SD responder started by the test. Both sides use the
//! loopback interface only, so nothing leaves this computer.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::{Duration, Instant};

use mdns_sd::{IfKind, ServiceDaemon, ServiceInfo};
use tyrminal_core::{Discovery, SSH_SERVICE_TYPE};

fn loopback_interface() -> String {
    let found = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .find(|i| i.is_loopback() && i.ip().is_ipv4())
        .map(|i| i.name);
    found.unwrap_or_else(|| panic!("BLOCKED: no IPv4 loopback interface on this machine"))
}

fn unique(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    format!("{prefix}-{}-{nanos}", std::process::id())
}

#[test]
#[ignore = "multicast on the loopback interface (pnpm test:integration)"]
fn services_announced_on_the_chosen_network_are_found_cleaned_and_bounded_in_time() {
    let lo = loopback_interface();
    let responder = ServiceDaemon::new().expect("responder");
    responder.disable_interface(IfKind::All).unwrap();
    responder.enable_interface(IfKind::Name(lo.clone())).unwrap();

    let plain = unique("tyrminal test server");
    let host = format!("{}.local.", unique("tyrminal-test-host"));
    responder.register(ServiceInfo::new(SSH_SERVICE_TYPE, &plain, &host, "127.0.0.1", 2222, None).unwrap()).unwrap();
    // A hostile announcement: terminal escapes and a bidi override in the name.
    let hostile = format!("{}\u{1b}[2J\u{202e}gnp.exe", unique("evil"));
    responder.register(ServiceInfo::new(SSH_SERVICE_TYPE, &hostile, &host, "127.0.0.1", 2200, None).unwrap()).unwrap();
    // Another service type on the same network is not an SSH server.
    responder
        .register(ServiceInfo::new("_http._tcp.local.", &unique("web"), &host, "127.0.0.1", 8080, None).unwrap())
        .unwrap();

    let discovery = Discovery::new();
    let started = discovery.start_on_interface("test", &lo, Duration::from_secs(8)).expect("start");
    assert!(started.running && started.found.is_empty());

    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        let status = discovery.status("test");
        if status.found.len() >= 2 || !status.running || Instant::now() > deadline {
            break status;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let ours: Vec<_> = status.found.iter().filter(|s| s.host == host.trim_end_matches('.')).collect();
    assert_eq!(ours.len(), 2, "{status:?}");
    let server = ours.iter().find(|s| s.port == 2222).expect("plain service");
    assert_eq!(server.name, plain);
    assert_eq!(server.addresses, vec!["127.0.0.1".to_owned()]);
    let evil = ours.iter().find(|s| s.port == 2200).expect("hostile service");
    assert!(evil.name.starts_with("evil-") && evil.name.ends_with("[2Jgnp.exe"), "{:?}", evil.name);
    assert!(!evil.name.chars().any(|c| c.is_control() || c == '\u{202e}'));
    assert!(status.found.iter().all(|s| s.port != 8080), "only _ssh._tcp is browsed");

    // Stopping ends the browse; results stay readable.
    discovery.stop("test");
    let deadline = Instant::now() + Duration::from_secs(3);
    while discovery.status("test").running {
        assert!(Instant::now() < deadline, "the browse did not stop");
        std::thread::sleep(Duration::from_millis(50));
    }
    let stopped = discovery.status("test");
    assert_eq!(stopped.seconds_left, 0);
    assert_eq!(stopped.found.len(), status.found.len());

    // A browse also ends by itself when its time is up.
    discovery.start_on_interface("test", &lo, Duration::from_millis(600)).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!discovery.status("test").running);
    let _ = responder.shutdown();
}

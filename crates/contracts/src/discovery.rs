//! LAN discovery (HST-14): opt-in DNS-SD browsing for SSH servers (`_ssh._tcp`) on one network
//! the user picks. Results are shown only; adding one goes through the normal host editor, and
//! connecting still verifies the server's host key as for any other host.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A network interface the user can browse on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiscoveryNetwork {
    /// The interface name (`en0`, `eth0`), used to start a browse.
    pub id: String,
    /// The interface's addresses, for the user to recognise the network.
    pub addresses: Vec<String>,
}

/// An SSH service announced on the network. Every field comes from other machines and is
/// untrusted: the core bounds and cleans it, the renderer shows it as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiscoveredService {
    /// The announced instance name (`Build server`).
    pub name: String,
    /// The announced host name without the trailing dot (`build.local`).
    pub host: String,
    /// Addresses announced for it, IPv4 first.
    pub addresses: Vec<String>,
    pub port: u16,
}

/// A browse in progress or finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiscoveryStatus {
    /// Still listening; false once the time ran out or the user stopped it.
    pub running: bool,
    /// Seconds left while running.
    pub seconds_left: u32,
    /// Services found so far, by name.
    pub found: Vec<DiscoveredService>,
    /// More services answered than are kept; the rest were dropped.
    pub truncated: bool,
}

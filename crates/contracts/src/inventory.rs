//! Agent D's contract types: inventory presentation, importers, keys and snippets beyond the
//! original `dto.rs` set.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The operating system a host runs, as the user recorded it. Presentation only: it picks the
/// icon on the host tile and is never used to decide how to connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HostOs {
    Linux,
    Ubuntu,
    Debian,
    Fedora,
    RedHat,
    Centos,
    Alpine,
    Arch,
    Suse,
    RaspberryPi,
    FreeBsd,
    OpenBsd,
    Macos,
    Windows,
    NetworkDevice,
}

/// Presentation settings of one host, kept apart from its connection settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostAppearance {
    pub host_id: String,
    pub os: HostOs,
}

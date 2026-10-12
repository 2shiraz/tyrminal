//! Server at a glance (P-32, ADR 0011): uptime, load, memory and disk use of the server behind a
//! connected SSH session, shown in the side panel.
//!
//! The values are read over a separate exec channel with a fixed command the app builds itself;
//! nothing typed by the user or sent by the server goes into it. The output is untrusted and parsed
//! strictly: a value that does not parse is `None` ("unavailable"), never a guess.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the panel shows for one session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ServerGlance {
    /// Read from a Linux server. Each value that did not parse is `None`.
    Available { stats: ServerStats },
    /// Not shown for this server, with why.
    NotAvailable { reason: GlanceUnavailable },
    /// Turned off for this host.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GlanceUnavailable {
    /// The server does not report itself as Linux.
    NotLinux,
    /// The server's answer was not in the expected form.
    Malformed,
    /// The command could not be run (refused, timed out, too much output).
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerStats {
    #[ts(type = "number | null")]
    pub uptime_seconds: Option<u64>,
    /// 1, 5 and 15 minute load averages.
    pub load: Option<[f64; 3]>,
    pub memory: Option<MemoryUse>,
    /// Real filesystems (`/` and block devices), at most [`crate::limits::MAX_GLANCE_DISKS`].
    pub disks: Option<Vec<DiskUse>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryUse {
    #[ts(type = "number")]
    pub total_kib: u64,
    #[ts(type = "number")]
    pub available_kib: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiskUse {
    /// Mount point as the server reported it; shown as plain text.
    pub mount: String,
    #[ts(type = "number")]
    pub total_kib: u64,
    #[ts(type = "number")]
    pub used_kib: u64,
    #[ts(type = "number")]
    pub available_kib: u64,
}

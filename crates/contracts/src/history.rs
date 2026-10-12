//! Session recordings (BUILD_SPEC Phase 08, LOG-*).
//!
//! A recording holds what a session printed, never what was typed. Recording is off until the user
//! turns it on for the vault; turning it off stops future recording and keeps existing logs, which
//! are deleted only by their own action.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The vault's recording settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordingSettings {
    /// Record new SSH and local terminal sessions.
    pub enabled: bool,
    /// How many recordings to keep per host (and for local terminals); older ones that are not
    /// bookmarked are deleted when a new one ends. 1..=100.
    pub keep_per_host: u32,
    /// Size limit of one recording, in MiB. 1..=512.
    pub max_log_mib: u32,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self { enabled: false, keep_per_host: 5, max_log_mib: 64 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionLogKind {
    Ssh,
    Local,
}

/// How much of a recording is readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionLogState {
    /// Being recorded now.
    Recording,
    /// Ended normally.
    Complete,
    /// Ended because it reached the size limit; the session went on unrecorded.
    SizeLimit,
    /// Stopped before it was finished (the application closed or crashed while recording).
    Incomplete,
    /// Part of it failed verification; only what came before is shown.
    Damaged,
    /// The file is missing or cannot be opened at all.
    Unreadable,
}

/// One recording, without its contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionLogSummary {
    pub id: String,
    /// The host's label when recorded (or "Local terminal").
    pub title: String,
    pub host_id: Option<String>,
    pub kind: SessionLogKind,
    /// Unix milliseconds.
    #[ts(type = "number")]
    pub started_at: u64,
    #[ts(type = "number | null")]
    pub ended_at: Option<u64>,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub state: SessionLogState,
    pub bookmarked: bool,
    pub comment: String,
}

/// How much space recordings use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionLogStorage {
    pub count: u32,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

/// A recording opened for playback. Rendered read-only, with active escape actions (links,
/// clipboard, title, notifications) disabled: the output is untrusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionLogPlayback {
    pub log: SessionLogSummary,
    /// The terminal size when recording started.
    pub cols: u16,
    pub rows: u16,
    pub frames: Vec<PlaybackFrame>,
    /// The recording holds more output than one playback shows; the rest is left out.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum PlaybackFrame {
    /// Output, base64-encoded. `atMs` counts from the start of the recording.
    #[serde(rename_all = "camelCase")]
    Output { at_ms: u32, data: String },
    #[serde(rename_all = "camelCase")]
    Resize { at_ms: u32, cols: u16, rows: u16 },
}

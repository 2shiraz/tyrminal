//! Command history for suggestions (AUT-01): local, encrypted in the vault, off until the user
//! turns it on, and a setting of its own (separate from session recording and diagnostics).
//!
//! Commands come from shell-integration marks: the line the shell showed between the end of its
//! prompt and the start of the command. Input typed while a command runs (a password at a
//! `sudo` prompt) is never between those marks, and keystrokes are never stored. A suggestion is
//! only ever put on the command line after the user picks it; nothing is run.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistorySettings {
    /// Remember commands and suggest them. Turning it off keeps what was remembered (clearing
    /// is its own action) and stops both remembering and suggesting.
    pub enabled: bool,
}

/// One remembered command, for the history list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryEntry {
    /// The saved host the command was run on; `None` for local terminals.
    pub host_id: Option<String>,
    /// The host's current label; `None` for local terminals or a deleted host.
    pub host_label: Option<String>,
    pub command: String,
    #[ts(type = "number")]
    pub last_used: u64,
    pub uses: u32,
}

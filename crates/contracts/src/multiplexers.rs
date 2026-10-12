//! tmux and screen session awareness (P-31, ADR 0011): the server's sessions, listed over a
//! separate exec channel of the verified connection. Names come from the server and are
//! untrusted: they are shown as plain text, and an attach command exists only for a name that
//! matches a strict pattern.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MultiplexerKind {
    Tmux,
    Screen,
}

/// One session on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MultiplexerSession {
    pub kind: MultiplexerKind,
    /// The name as the server reported it, with control characters removed and cut to 128
    /// characters. For screen, `<pid>.<name>`. Display only.
    pub name: String,
    /// A client is attached to it right now.
    pub attached: bool,
    /// tmux only: number of windows.
    pub windows: Option<u32>,
    /// tmux only: Unix seconds the session was created.
    #[ts(type = "number | null")]
    pub created_at: Option<u64>,
    /// The command that attaches to it, built by the core from a name that matched the strict
    /// pattern; `None` for any other name, which is then shown but not offered.
    pub attach_command: Option<String>,
}

/// Why the server's sessions could not be listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MultiplexerUnavailable {
    /// The exec channel failed or timed out.
    Failed,
    /// The answer did not have the expected shape.
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum MultiplexerList {
    Listed {
        tmux_installed: bool,
        screen_installed: bool,
        /// tmux sessions first, then screen; each in the server's order.
        sessions: Vec<MultiplexerSession>,
        /// More sessions than the limit, or lines that could not be read, were left out.
        truncated: bool,
    },
    NotAvailable {
        reason: MultiplexerUnavailable,
    },
}

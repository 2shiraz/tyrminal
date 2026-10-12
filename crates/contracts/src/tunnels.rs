//! Port forwarding (tunnels): saved rules and running forwards (BUILD_SPEC Phase 07).
//!
//! A saved rule belongs to a host and runs on a connected SSH session to that host. Listeners
//! bind to loopback unless the rule records an explicit approval for a non-loopback address
//! (`allow_external`), which the UI asks for separately from saving.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::IpcError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TunnelKind {
    /// A listener on this computer; connections go to `dest` as seen from the server (`-L`).
    Local,
    /// A listener on the server; connections come back to `dest` as seen from this computer (`-R`).
    Remote,
    /// A SOCKS5 proxy on this computer; each connection goes where the client asks (`-D`).
    Dynamic,
}

/// A saved forwarding rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelSummary {
    pub id: String,
    pub name: String,
    pub host_id: String,
    /// The host's label; `None` when the host was deleted (the rule then cannot start).
    pub host_label: Option<String>,
    pub kind: TunnelKind,
    /// Listener address: on this computer for local/dynamic, on the server for remote.
    pub bind_host: String,
    /// 0: a free port is picked when the rule starts.
    pub bind_port: u16,
    /// Unused (empty, 0) for dynamic rules.
    pub dest_host: String,
    pub dest_port: u16,
    /// The user approved a listener other machines can reach.
    pub allow_external: bool,
    /// Start this rule whenever a session to its host connects.
    pub auto_start: bool,
    #[ts(type = "number")]
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelInput {
    /// `None` creates a rule; `Some` edits that rule.
    pub id: Option<String>,
    pub name: String,
    pub host_id: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
    /// Must be set to save a rule whose listener is not loopback-only. The UI sets it only
    /// after a separate confirmation that names the exposure.
    pub allow_external: bool,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TunnelState {
    Running,
    /// Stopped by the user.
    Stopped,
    /// The session ended or its connection was lost; the listener is closed.
    SessionEnded,
    /// The rule could not start (see `error`) or the listener failed while running.
    Failed,
}

/// A forward that is running or has recently ended in this window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ActiveTunnel {
    /// Opaque handle for stopping it.
    pub run_id: String,
    /// The saved rule it was started from.
    pub tunnel_id: String,
    pub session_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    /// The port actually bound (the server's choice for a remote rule with port 0).
    pub bound_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
    pub state: TunnelState,
    pub active_connections: u32,
    #[ts(type = "number")]
    pub total_connections: u64,
    /// Connections refused because the limit was reached.
    #[ts(type = "number")]
    pub refused_connections: u64,
    /// Connections whose destination could not be reached or that the server refused.
    #[ts(type = "number")]
    pub failed_connections: u64,
    #[ts(type = "number")]
    pub bytes_out: u64,
    #[ts(type = "number")]
    pub bytes_in: u64,
    /// Why an auto-started rule could not start, or why a running one failed.
    pub error: Option<IpcError>,
}

// ---------- advanced connection settings (jump hosts; proxies and agent forwarding later) ----------

/// How a host is reached, beyond address and credentials. Kept apart from `HostInput` and saved
/// with its own command, so editing a host's basics never changes it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostConnection {
    /// A saved host to connect through first (`ProxyJump`). That host's own jump host, if it has
    /// one, comes before it, so chains are built by pointing hosts at each other.
    pub jump_host_id: Option<String>,
    /// Outbound proxy for the connection that leaves this computer. Used when this host is the
    /// first hop (for a host behind a jump host, set it on the jump host).
    pub proxy: Option<ProxySummary>,
    /// Post-quantum key exchange for this host (each hop of a chain uses its own setting).
    pub key_exchange: KeyExchangeMode,
}

/// How a host's connection treats hybrid post-quantum key exchange (ML-KEM-768 with X25519).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KeyExchangeMode {
    /// Use it when the server offers it, otherwise a classical exchange.
    #[default]
    PreferPostQuantum,
    /// Connect only when the server offers it; otherwise stop before signing in.
    RequirePostQuantum,
    /// Never offer it, for servers that mishandle it.
    Classic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProxyType {
    /// HTTP `CONNECT`, optionally with Basic authentication.
    Http,
    /// SOCKS5, optionally with username/password authentication.
    Socks5,
}

/// A host's proxy as shown to the user. The password itself never leaves the vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProxySummary {
    pub kind: ProxyType,
    pub host: String,
    pub port: u16,
    /// Empty: no authentication.
    pub username: String,
    pub password_stored: bool,
}

/// What the host editor sends. Contains a secret: `Debug` is redacted.
#[derive(Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostConnectionInput {
    pub jump_host_id: Option<String>,
    pub proxy: Option<ProxyInput>,
    #[serde(default)]
    pub key_exchange: KeyExchangeMode,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProxyInput {
    pub kind: ProxyType,
    pub host: String,
    pub port: u16,
    /// Empty: no authentication (the password is then dropped).
    pub username: String,
    /// `None` keeps the stored password; the UI never receives it to resend.
    pub password: Option<String>,
}

impl core::fmt::Debug for HostConnectionInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("HostConnectionInput")
            .field("jump_host_id", &self.jump_host_id)
            .field("proxy", &self.proxy)
            .field("key_exchange", &self.key_exchange)
            .finish()
    }
}

impl core::fmt::Debug for ProxyInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ProxyInput")
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// Where a prompt's server sits in a jump-host chain, so the user knows which hop is asking.
/// Present only for connections through at least one jump host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainPosition {
    /// 1-based; the destination host is `total`.
    pub index: u32,
    pub total: u32,
    /// The saved label of that hop (the user's own name for it, never server text).
    pub label: String,
}

/// One hop of a host's connection chain, first hop first; the host itself is last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainHop {
    pub host_id: String,
    pub label: String,
    pub address: String,
    pub port: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_input_debug_never_prints_the_password() {
        let input = HostConnectionInput {
            jump_host_id: None,
            key_exchange: KeyExchangeMode::default(),
            proxy: Some(ProxyInput {
                kind: ProxyType::Http,
                host: "proxy.lab".into(),
                port: 3128,
                username: "u".into(),
                password: Some("canary-proxy-secret".into()),
            }),
        };
        let text = format!("{input:?}");
        assert!(!text.contains("canary-proxy-secret"), "{text}");
    }
}

//! Group defaults for their hosts' route and appearance (HST-05). Identity, environment variables
//! and startup snippets are group defaults too; they have their own types.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{HostOs, ProxyInput, ProxySummary, SettingOrigin};

/// A group's route (jump host, proxy), as a host inherits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InheritedRoute {
    pub jump_host_id: Option<String>,
    pub proxy: Option<ProxySummary>,
    pub origin: SettingOrigin,
}

/// What a group sets for its hosts beyond user name, port, key, identity, environment and startup.
/// A host that sets none of these itself uses its nearest group's (each setting separately for
/// the OS icon; jump host and proxy together, as one route).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupDefaults {
    pub jump_host_id: Option<String>,
    pub proxy: Option<ProxySummary>,
    pub os: Option<HostOs>,
    /// What this group's hosts get from the group's own parents, when it sets nothing itself.
    pub inherited_route: Option<InheritedRoute>,
    pub inherited_os: Option<(HostOs, SettingOrigin)>,
}

/// What the group editor sends. Contains a secret (the proxy password): `Debug` is redacted.
#[derive(Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupDefaultsInput {
    pub jump_host_id: Option<String>,
    pub proxy: Option<ProxyInput>,
    pub os: Option<HostOs>,
}

impl core::fmt::Debug for GroupDefaultsInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("GroupDefaultsInput")
            .field("jump_host_id", &self.jump_host_id)
            .field("proxy", &self.proxy)
            .field("os", &self.os)
            .finish()
    }
}

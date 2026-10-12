//! Thin command adapters: take the caller's window label, validate transport-level shape and
//! dispatch to `tyrminal-core`, which owns every rule. No business logic lives here.

pub mod backup;
pub mod discovery;
pub mod files;
pub mod inventory;
pub mod output;
pub mod sessions;
pub mod settings;
pub mod snippets;
pub mod vault;
// agent B: tunnels and history
pub mod tunnels;
// agent C: workspaces
pub mod layouts;
// command history
pub mod command_history;

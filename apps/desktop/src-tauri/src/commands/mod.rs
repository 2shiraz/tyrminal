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
pub mod history;
pub mod tunnels;
// terminal notifications (P-23)
pub mod notify;
// privilege prompts (KEY-18)
pub mod privilege;
// compromised-password check (SEC-11)
pub mod password_check;
// security review (P-27)
pub mod security_review;
// tmux and screen session awareness (P-31)
pub mod multiplexers;
// agent C: workspaces
pub mod layouts;
// command history
pub mod command_history;
// server at a glance
pub mod server_glance;

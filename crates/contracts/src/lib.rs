//! The IPC contract between the Rust core and the renderer.
//!
//! Everything that crosses the boundary is declared here: DTOs, stable error codes and input
//! limits. TypeScript types are generated from these definitions (`pnpm contracts`); the generated
//! files are never edited by hand. TypeScript types are a convenience for the UI only: every
//! request is validated again in Rust.
//!
//! DTOs carry display metadata and opaque identifiers. Stored secrets never appear in a response
//! type; the few request types that accept a secret (a typed passphrase, a pasted key) say so.

pub mod limits;

mod discovery;
mod dto;
mod error;
// agent B: tunnels and history
mod tunnels;
// agent D: inventory and snippets
mod defaults;
mod inventory;
// privilege prompts (KEY-18)
mod privilege;
// identity deletion (KEY-15/16, BUILD_SPEC §10.2)
mod identity_removal;
// compromised-password check (SEC-11)
mod password_check;
// command history
mod command_history;
// server at a glance
mod server_glance;
// security review (P-27)
mod security_review;

pub use discovery::*;
pub use dto::*;
pub use error::{ErrorCode, IpcError};
// agent B: tunnels and history
pub use tunnels::*;

// agent C: workspaces
mod layouts;
pub use layouts::*;
// agent D: inventory and snippets
pub use defaults::*;
pub use inventory::*;
// privilege prompts (KEY-18)
pub use privilege::*;
// identity deletion (KEY-15/16, BUILD_SPEC §10.2)
pub use identity_removal::*;
// compromised-password check (SEC-11)
pub use password_check::*;
// command history
pub use command_history::*;
// server at a glance
pub use server_glance::*;
// security review (P-27)
pub use security_review::*;

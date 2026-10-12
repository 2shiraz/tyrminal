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

mod dto;
mod error;
// agent B: tunnels and history
mod tunnels;
// agent D: inventory and snippets
mod inventory;

pub use dto::*;
pub use error::{ErrorCode, IpcError};
// agent B: tunnels and history
pub use tunnels::*;
// agent D: inventory and snippets
pub use inventory::*;

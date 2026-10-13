//! Tyrminal local storage.
//!
//! One SQLite connection owned by one dedicated worker thread. Callers submit work through a
//! bounded queue and await the result, so SQLite never blocks the async reactor or the UI
//! (spec §6.2). The database stores **opaque** rows: this crate has no key material and no
//! dependency on the vault crate, and cannot read a record's contents.

mod db;
mod error;
mod migrations;
mod rows;

pub use db::Database;
pub use error::StorageError;
pub use migrations::{APPLICATION_ID, LATEST_SCHEMA_VERSION};
pub use rows::{RecordRow, WriteCondition};

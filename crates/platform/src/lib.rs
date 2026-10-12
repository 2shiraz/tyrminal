//! Narrow OS service adapters. Business rules never live here; this crate only answers
//! "can the operating system hold this secret for us, and if not, why".

mod fs;
mod keystore;

pub use fs::restrict_to_owner;
pub use keystore::{KeystoreError, MemorySecretStore, OsSecretStore, SecretStore, UnavailableSecretStore};

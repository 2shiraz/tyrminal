//! Narrow OS service adapters. Business rules never live here; this crate only answers
//! "can the operating system hold this secret for us, and if not, why".

mod keystore;

pub use keystore::{KeystoreError, MemorySecretStore, OsSecretStore, SecretStore, UnavailableSecretStore};

//! Tyrminal vault cryptography: key hierarchy, key slots and record envelopes.
//!
//! The byte-level format is specified in `docs/crypto-format.md`; this crate implements exactly that
//! document. It contains no cipher, hash or KDF primitive of its own, performs no I/O and knows
//! nothing about SQLite, Tauri or the UI.
//!
//! This composition has **not** been independently reviewed.

mod encoding;
mod envelope;
mod error;
mod header;
mod kdf;
mod keys;
mod recovery;
mod secret;

pub use envelope::{MAX_PAYLOAD_LEN, PAD_BLOCK, RecordContext, SealedRecord};
pub use error::VaultError;
pub use header::{
    Credential, FORMAT_VERSION, MAX_DEVICE_SLOTS, NewVault, SlotKind, UnlockedVault, VaultHeader,
    create_vault,
};
pub use kdf::{KdfProfile, PASSPHRASE_MAX_LEN, PASSPHRASE_MIN_NEW_LEN};
pub use recovery::RecoveryKey;
pub use secret::{Passphrase, SecretKey};

/// 16-byte random identifier for vaults, records and key slots.
pub type Id = [u8; 16];

/// Draws a fresh random identifier from the OS CSPRNG.
pub fn random_id() -> Result<Id, VaultError> {
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).map_err(|_| VaultError::Randomness)?;
    Ok(id)
}

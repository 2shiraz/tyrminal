use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::{Passphrase, SecretKey, VaultError};

/// Upper bound on passphrase length for every operation (bytes).
pub const PASSPHRASE_MAX_LEN: usize = 1024;
/// Lower bound when creating or changing a passphrase (bytes).
pub const PASSPHRASE_MIN_NEW_LEN: usize = 8;

/// Allowlisted key-derivation profiles. The header stores the identifier only, so a file can never
/// supply raw cost parameters (docs/crypto-format.md §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KdfProfile {
    /// Argon2id v1.3, 64 MiB, 3 iterations, parallelism 1, 32-byte output.
    Argon2idV1,
    /// HKDF-SHA-256 over a 32-byte high-entropy secret.
    HkdfSha256,
}

impl KdfProfile {
    pub const fn id(self) -> u16 {
        match self {
            Self::Argon2idV1 => 0x0001,
            Self::HkdfSha256 => 0x0100,
        }
    }

    pub fn from_id(id: u16) -> Result<Self, VaultError> {
        match id {
            0x0001 => Ok(Self::Argon2idV1),
            0x0100 => Ok(Self::HkdfSha256),
            _ => Err(VaultError::UnsupportedKdfProfile),
        }
    }
}

const ARGON2_M_COST_KIB: u32 = 64 * 1024;
const ARGON2_T_COST: u32 = 3;
const ARGON2_P_COST: u32 = 1;

/// Derives the passphrase KEK. Blocking and memory-hard (64 MiB): run it off the async reactor and
/// never concurrently for one vault.
pub(crate) fn passphrase_kek(
    passphrase: &Passphrase,
    salt: &[u8; 32],
) -> Result<SecretKey, VaultError> {
    if passphrase.is_empty() || passphrase.len() > PASSPHRASE_MAX_LEN {
        return Err(VaultError::PassphraseLength);
    }
    let params = Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|_| VaultError::Internal)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = SecretKey::from_bytes([0u8; 32]);
    argon
        .hash_password_into(passphrase.expose(), salt, key.expose_mut())
        .map_err(|_| VaultError::Internal)?;
    Ok(key)
}

/// HKDF-SHA-256 with an explicit salt and domain-separation label, 32-byte output.
pub(crate) fn hkdf_key(ikm: &[u8; 32], salt: &[u8], info: &[u8]) -> Result<SecretKey, VaultError> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut key = SecretKey::from_bytes([0u8; 32]);
    hk.expand(info, key.expose_mut())
        .map_err(|_| VaultError::Internal)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_ids_round_trip_and_unknown_ids_are_rejected() {
        for p in [KdfProfile::Argon2idV1, KdfProfile::HkdfSha256] {
            assert_eq!(KdfProfile::from_id(p.id()), Ok(p));
        }
        for id in [0x0000, 0x0002, 0x00ff, 0x0101, 0xffff] {
            assert_eq!(
                KdfProfile::from_id(id),
                Err(VaultError::UnsupportedKdfProfile)
            );
        }
    }

    #[test]
    fn passphrase_length_bounds_are_enforced_before_kdf_work() {
        let salt = [7u8; 32];
        assert_eq!(
            passphrase_kek(&Passphrase::new(String::new()), &salt).err(),
            Some(VaultError::PassphraseLength)
        );
        let long = Passphrase::new("x".repeat(PASSPHRASE_MAX_LEN + 1));
        assert_eq!(
            passphrase_kek(&long, &salt).err(),
            Some(VaultError::PassphraseLength)
        );
    }
}

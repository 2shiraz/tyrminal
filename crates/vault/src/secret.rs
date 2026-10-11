use core::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::VaultError;

/// A 256-bit secret key. Zeroized on drop; never printed; not `Clone`.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SecretKey([u8; 32]);

impl SecretKey {
    /// Generates a key from the OS CSPRNG.
    pub fn generate() -> Result<Self, VaultError> {
        let mut key = Self([0u8; 32]);
        getrandom::fill(&mut key.0).map_err(|_| VaultError::Randomness)?;
        Ok(key)
    }

    /// Wraps existing key bytes. The caller's copy should be zeroized.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Exposes the raw key. Call sites are the audit surface for key handling.
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn expose_mut(&mut self) -> &mut [u8; 32] {
        &mut self.0
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey(<redacted>)")
    }
}

/// A user passphrase. Zeroized on drop; never printed; not `Clone`.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Passphrase(Vec<u8>);

impl Passphrase {
    /// Takes ownership of the passphrase text. The `String`'s buffer is moved, not copied.
    pub fn new(text: String) -> Self {
        Self(text.into_bytes())
    }

    pub(crate) fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Passphrase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Passphrase(<redacted>)")
    }
}

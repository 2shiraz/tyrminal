use core::fmt;

use russh::keys::{HashAlg, PrivateKey, decode_secret_key};
use thiserror::Error;

/// Maximum accepted private-key text (BUILD_SPEC §13: 1 MiB imported key payloads).
pub const MAX_KEY_TEXT_LEN: usize = 1024 * 1024;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    #[error("the private key is encrypted and needs its passphrase")]
    PassphraseRequired,
    #[error("the passphrase did not decrypt the private key")]
    WrongPassphrase,
    #[error("the private key could not be parsed")]
    Malformed,
    #[error("the private key exceeds the size limit")]
    TooLarge,
    #[error("this key type is not supported")]
    Unsupported,
}

/// A decoded client private key. Never printed; the underlying key material is zeroized by the
/// `ssh-key` types when dropped.
pub struct ClientKey {
    key: PrivateKey,
}

impl fmt::Debug for ClientKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientKey").field("algorithm", &self.algorithm()).finish_non_exhaustive()
    }
}

impl ClientKey {
    /// Parses an OpenSSH/PEM private key. Bounded; never touches the filesystem.
    pub fn from_openssh(text: &str, passphrase: Option<&str>) -> Result<Self, KeyError> {
        if text.len() > MAX_KEY_TEXT_LEN {
            return Err(KeyError::TooLarge);
        }
        match decode_secret_key(text, passphrase) {
            Ok(key) => Ok(Self { key }),
            Err(russh::keys::Error::KeyIsEncrypted) => Err(KeyError::PassphraseRequired),
            Err(russh::keys::Error::UnsupportedKeyType { .. } | russh::keys::Error::UnknownAlgorithm(_)) => {
                Err(KeyError::Unsupported)
            }
            // With a passphrase supplied, a decryption failure surfaces as a parse/crypto error.
            // The library does not distinguish "wrong passphrase" from "corrupt after decrypt".
            Err(_) if passphrase.is_some() && Self::looks_encrypted(text) => Err(KeyError::WrongPassphrase),
            Err(_) => Err(KeyError::Malformed),
        }
    }

    fn looks_encrypted(text: &str) -> bool {
        matches!(decode_secret_key(text, None), Err(russh::keys::Error::KeyIsEncrypted))
    }

    pub fn algorithm(&self) -> String {
        self.key.algorithm().as_str().to_owned()
    }

    /// `SHA256:` fingerprint of the public half.
    pub fn fingerprint(&self) -> String {
        self.key.public_key().fingerprint(HashAlg::Sha256).to_string()
    }

    pub fn is_rsa(&self) -> bool {
        self.key.algorithm().is_rsa()
    }

    pub(crate) fn private_key(&self) -> &PrivateKey {
        &self.key
    }
}

/// Outcome of one authentication attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthOutcome {
    Success,
    Failure {
        /// Method names the server says may continue (untrusted, informational).
        remaining_methods: Vec<String>,
        /// The method was accepted but the server requires another factor.
        partial_success: bool,
    },
}

impl AuthOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Success)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_and_oversized_keys_are_rejected() {
        assert_eq!(ClientKey::from_openssh("", None).err(), Some(KeyError::Malformed));
        assert_eq!(ClientKey::from_openssh("not a key", None).err(), Some(KeyError::Malformed));
        assert_eq!(
            ClientKey::from_openssh(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
                None
            )
            .err(),
            Some(KeyError::Malformed)
        );
        let huge = "A".repeat(MAX_KEY_TEXT_LEN + 1);
        assert_eq!(ClientKey::from_openssh(&huge, None).err(), Some(KeyError::TooLarge));
    }
}

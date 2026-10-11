use core::fmt;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, HashAlg, PrivateKey, decode_secret_key};
use thiserror::Error;
use zeroize::Zeroizing;

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

    /// Generates a new Ed25519 key from the OS-seeded CSPRNG.
    pub fn generate_ed25519() -> Result<Self, KeyError> {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(|_| KeyError::Unsupported)?;
        Ok(Self { key })
    }

    /// Whether `text` is a private key that needs a passphrase to decode.
    pub fn is_passphrase_protected(text: &str) -> bool {
        text.len() <= MAX_KEY_TEXT_LEN && Self::looks_encrypted(text)
    }

    /// Unencrypted OpenSSH private key text. Secret: for storing inside the vault only.
    pub fn to_openssh(&self) -> Result<Zeroizing<String>, KeyError> {
        self.key.to_openssh(LineEnding::LF).map_err(|_| KeyError::Malformed)
    }

    /// `<algorithm> <base64>` public key, safe to display and to install on servers.
    pub fn public_key_openssh(&self) -> Result<String, KeyError> {
        let text = self.key.public_key().to_openssh().map_err(|_| KeyError::Malformed)?;
        let mut parts = text.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some(algorithm), Some(blob)) => Ok(format!("{algorithm} {blob}")),
            _ => Err(KeyError::Malformed),
        }
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
    fn generated_keys_round_trip_through_openssh_text() {
        let key = ClientKey::generate_ed25519().unwrap();
        assert_eq!(key.algorithm(), "ssh-ed25519");
        let text = key.to_openssh().unwrap();
        assert!(!ClientKey::is_passphrase_protected(&text));
        let again = ClientKey::from_openssh(&text, None).unwrap();
        assert_eq!(again.fingerprint(), key.fingerprint());
        assert_eq!(again.public_key_openssh().unwrap(), key.public_key_openssh().unwrap());
        assert!(key.public_key_openssh().unwrap().starts_with("ssh-ed25519 AAAA"));
        // Two generated keys differ.
        assert_ne!(ClientKey::generate_ed25519().unwrap().fingerprint(), key.fingerprint());
        // Debug output never contains key material.
        assert!(!format!("{key:?}").contains(&text[40..60]));
    }

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

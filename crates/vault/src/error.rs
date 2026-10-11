use thiserror::Error;

/// Vault failures. Messages are fixed strings: they never contain key material, passphrases,
/// plaintext or file contents (INV-18).
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    /// Wrong passphrase/recovery key/device secret, or the selected key slot was modified.
    /// The two cases are deliberately indistinguishable.
    #[error("the credential did not unlock this vault")]
    WrongCredential,
    #[error("the vault header failed its integrity check")]
    HeaderTampered,
    #[error("the vault header is malformed")]
    MalformedHeader,
    #[error("this vault uses a format version this build does not support")]
    UnsupportedVersion,
    #[error("this vault uses a key-derivation profile this build does not support")]
    UnsupportedKdfProfile,
    #[error("the vault has no key slot for this kind of credential")]
    NoSuchSlot,
    #[error("the vault already has the maximum number of key slots of this kind")]
    SlotLimit,
    #[error("the passphrase length is outside the supported range")]
    PassphraseLength,
    #[error("a record failed authentication")]
    RecordAuthentication,
    #[error("a record is malformed")]
    MalformedRecord,
    #[error("the record payload exceeds the size limit")]
    PayloadTooLarge,
    #[error("the record was written with a different key generation")]
    KeyVersionMismatch,
    #[error("the recovery key is not valid")]
    InvalidRecoveryKey,
    #[error("the operating system random number generator failed")]
    Randomness,
    #[error("an internal cryptographic operation failed")]
    Internal,
}

//! Tyrminal session recordings: what a terminal session printed, encrypted and tamper-evident.
//!
//! The byte format is specified in `docs/crypto-format.md` §11 and implemented exactly here. It
//! uses the STREAM construction (`aead-stream`, RustCrypto) over XChaCha20-Poly1305, so chunk
//! order, the file's identity and its completion are all authenticated: a reordered, swapped,
//! truncated or extended file is detected. No cipher, hash or KDF primitive is implemented here.
//!
//! A recording holds terminal **output** only. The writer has no way to receive typed input, so
//! keystrokes (and passwords typed at a prompt that does not echo them) can never be recorded.
//!
//! This crate performs no file-system work of its own: the writer appends to any `io::Write` and
//! the reader takes the bytes of one file. It knows nothing about SQLite, Tauri or the UI.
//!
//! This composition has **not** been independently reviewed.

mod format;
mod reader;
mod writer;

pub use format::{EndReason, Event, FORMAT_VERSION, HEADER_LEN, LogIdentity, MAGIC, MAX_CHUNK_PAYLOAD, PAD_BLOCK};
pub use reader::{Completeness, MAX_LOG_LEN, Playback, read_log};
pub use writer::{LogWriter, MIN_LOG_LIMIT, WriteStatus};

/// Why a recording could not be written or opened at all. (A recording that opens but is cut
/// short or damaged part-way is not an error: see [`Completeness`].)
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LogError {
    #[error("not a session recording")]
    NotALog,
    #[error("this recording was made by a newer version")]
    UnsupportedVersion,
    /// The file is a valid recording, but not the one that was asked for (another vault, another
    /// log or another key generation).
    #[error("this recording belongs to a different log")]
    WrongLog,
    /// Nothing in the file could be authenticated with this vault's key.
    #[error("the recording could not be decrypted")]
    Unreadable,
    #[error("the recording is larger than allowed")]
    TooLarge,
    #[error("the recording limit is too small")]
    LimitTooSmall,
    #[error("the recording has already been finished")]
    Finished,
    #[error("the recording could not be written")]
    Io,
    #[error("the system random number generator failed")]
    Randomness,
    #[error("internal error")]
    Internal,
}

/// Derives the key for one recording from the vault's `K_logs`: every file has its own key, bound
/// to its log id (docs/crypto-format.md §11.1).
fn file_key(logs_key: &[u8; 32], log_id: &[u8; 16]) -> Result<zeroize::Zeroizing<[u8; 32]>, LogError> {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(log_id), logs_key);
    let mut key = zeroize::Zeroizing::new([0u8; 32]);
    hk.expand(format::FILE_KEY_LABEL, key.as_mut()).map_err(|_| LogError::Internal)?;
    Ok(key)
}

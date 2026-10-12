use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable machine-readable error codes. The UI maps these to user-facing guidance; the set only
/// grows, codes are never repurposed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export)]
pub enum ErrorCode {
    VaultLocked,
    VaultNotInitialized,
    VaultAlreadyExists,
    VaultBusy,
    VaultDamaged,
    VaultUnsupportedVersion,
    WrongCredential,
    InvalidRecoveryKey,
    InvalidInput,
    NotFound,
    Conflict,
    InUse,
    LimitExceeded,
    AccessDenied,
    Cancelled,
    Timeout,
    Unreachable,
    HostKeyChanged,
    HostKeyRejected,
    AuthFailed,
    KeyInvalid,
    ChannelDenied,
    Disconnected,
    ProtocolError,
    SecretStoreUnavailable,
    StorageFull,
    IoError,
    Internal,
    /// The host needs sign-in input (no saved password or key) and the user chose not to be
    /// asked: it was skipped before anything was sent.
    NeedsSignIn,
}

/// The only error shape that crosses IPC. `message` is a fixed English sentence chosen by the
/// core for the code; it never contains secrets, remote-supplied text, paths or raw library
/// errors (INV-18).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message: message.to_owned() }
    }
}

impl core::fmt::Display for IpcError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for IpcError {}

//! Maps every lower-layer failure to the single IPC error shape with a fixed, safe message.

use tyrminal_contracts::{ErrorCode, IpcError};
use tyrminal_ssh::{KeyError, RejectReason, SshError};
use tyrminal_storage::StorageError;
use tyrminal_vault::VaultError;

pub(crate) fn err(code: ErrorCode, message: &'static str) -> IpcError {
    IpcError::new(code, message)
}

pub(crate) fn locked() -> IpcError {
    err(ErrorCode::VaultLocked, "The vault is locked. Unlock it to continue.")
}

pub(crate) fn invalid(message: &'static str) -> IpcError {
    err(ErrorCode::InvalidInput, message)
}

pub(crate) fn not_found(message: &'static str) -> IpcError {
    err(ErrorCode::NotFound, message)
}

pub(crate) fn internal() -> IpcError {
    err(ErrorCode::Internal, "Something went wrong inside Tyrminal. Your data has not been changed.")
}

pub(crate) fn from_vault(e: VaultError) -> IpcError {
    match e {
        VaultError::WrongCredential => {
            err(ErrorCode::WrongCredential, "That did not unlock the vault. Nothing was changed.")
        }
        VaultError::InvalidRecoveryKey => {
            err(ErrorCode::InvalidRecoveryKey, "That is not a valid recovery key. Check for typing mistakes.")
        }
        VaultError::PassphraseLength => invalid("The passphrase must be between 8 and 1024 characters long."),
        VaultError::UnsupportedVersion | VaultError::UnsupportedKdfProfile => err(
            ErrorCode::VaultUnsupportedVersion,
            "This vault was created by a newer version of Tyrminal. Update the application to open it.",
        ),
        VaultError::HeaderTampered
        | VaultError::MalformedHeader
        | VaultError::RecordAuthentication
        | VaultError::MalformedRecord
        | VaultError::KeyVersionMismatch => err(
            ErrorCode::VaultDamaged,
            "The vault failed an integrity check and was not opened. Restore it from a backup.",
        ),
        VaultError::NoSuchSlot => err(ErrorCode::WrongCredential, "This vault has no credential of that kind."),
        VaultError::PayloadTooLarge | VaultError::SlotLimit => {
            err(ErrorCode::LimitExceeded, "That is larger than the vault allows.")
        }
        VaultError::Randomness | VaultError::Internal => internal(),
    }
}

pub(crate) fn from_storage(e: StorageError) -> IpcError {
    match e {
        StorageError::Full => {
            err(ErrorCode::StorageFull, "The disk is full. Nothing was changed; free some space and try again.")
        }
        StorageError::Conflict => {
            err(ErrorCode::Conflict, "This item was changed by another action. Reload it and try again.")
        }
        StorageError::NotFound => not_found("That item no longer exists."),
        StorageError::AlreadyInitialized => {
            err(ErrorCode::VaultAlreadyExists, "A vault already exists here. It was not overwritten.")
        }
        StorageError::NewerSchema => err(
            ErrorCode::VaultUnsupportedVersion,
            "This vault was created by a newer version of Tyrminal. Update the application to open it.",
        ),
        StorageError::NotAVault | StorageError::Corrupt => {
            err(ErrorCode::VaultDamaged, "The vault file is damaged or is not a Tyrminal vault. It was not modified.")
        }
        StorageError::Constraint => invalid("The item could not be stored because it is not valid."),
        StorageError::Open | StorageError::Io | StorageError::Closed | StorageError::Migration => {
            err(ErrorCode::IoError, "The vault could not be read or written. Nothing was changed.")
        }
    }
}

pub(crate) fn from_ssh(e: &SshError) -> IpcError {
    match e {
        SshError::Resolve => {
            err(ErrorCode::Unreachable, "The host name could not be found. Check the address and your network.")
        }
        SshError::Unreachable => err(
            ErrorCode::Unreachable,
            "The server refused the connection or could not be reached. Check the address and port.",
        ),
        SshError::Timeout(_) => err(ErrorCode::Timeout, "The server did not respond in time."),
        SshError::HostKey(RejectReason::Changed | RejectReason::ChangedDuringSession) => err(
            ErrorCode::HostKeyChanged,
            "The server's identity has changed. The connection was blocked and no credentials were sent.",
        ),
        SshError::HostKey(RejectReason::Cancelled) => {
            err(ErrorCode::Cancelled, "The connection was cancelled before the server was trusted.")
        }
        SshError::HostKey(RejectReason::CertificateUnsupported) => err(
            ErrorCode::HostKeyRejected,
            "The server uses a host certificate, which this version cannot verify. No credentials were sent.",
        ),
        SshError::HostKey(RejectReason::NotTrusted) => {
            err(ErrorCode::HostKeyRejected, "The server's identity was not trusted. No credentials were sent.")
        }
        SshError::NoCommonAlgorithm => {
            err(ErrorCode::ProtocolError, "The server only offers encryption methods that Tyrminal considers unsafe.")
        }
        SshError::Disconnected(_) => err(ErrorCode::Disconnected, "The server closed the connection."),
        SshError::Cancelled => err(ErrorCode::Cancelled, "The connection was cancelled."),
        SshError::ChannelDenied | SshError::RequestDenied => {
            err(ErrorCode::ChannelDenied, "The server signed you in but refused to open a terminal.")
        }
        SshError::LimitExceeded => err(ErrorCode::LimitExceeded, "The server sent more data than allowed."),
        SshError::NotAuthenticated | SshError::Protocol => {
            err(ErrorCode::ProtocolError, "The server did not follow the SSH protocol. The connection was closed.")
        }
        SshError::Internal => internal(),
    }
}

pub(crate) fn from_key(e: KeyError) -> IpcError {
    match e {
        KeyError::PassphraseRequired => {
            err(ErrorCode::KeyInvalid, "This private key is encrypted. Enter its passphrase to import it.")
        }
        KeyError::WrongPassphrase => err(ErrorCode::WrongCredential, "That passphrase does not decrypt this key."),
        KeyError::TooLarge => err(ErrorCode::LimitExceeded, "That key is larger than 1 MiB."),
        KeyError::Unsupported => err(ErrorCode::KeyInvalid, "This type of key is not supported."),
        KeyError::Malformed => err(ErrorCode::KeyInvalid, "That does not look like a private key."),
    }
}

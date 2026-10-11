use thiserror::Error;

/// Storage failures. Messages never include SQL text, row contents or filesystem paths (INV-18).
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum StorageError {
    #[error("the storage location could not be opened")]
    Open,
    #[error("this file is not a Tyrminal vault database")]
    NotAVault,
    #[error("the vault database was written by a newer version of the application")]
    NewerSchema,
    #[error("the vault database is damaged")]
    Corrupt,
    #[error("the record was changed by another operation")]
    Conflict,
    #[error("the record does not exist")]
    NotFound,
    #[error("a vault already exists at this location")]
    AlreadyInitialized,
    #[error("the storage device is full")]
    Full,
    #[error("a storage operation failed")]
    Io,
    #[error("the row violates a storage constraint")]
    Constraint,
    #[error("the storage worker is no longer running")]
    Closed,
    #[error("the schema migration failed and was rolled back")]
    Migration,
}

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode as C;
        match err {
            rusqlite::Error::SqliteFailure(e, _) => match e.code {
                C::DiskFull => Self::Full,
                C::DatabaseCorrupt | C::NotADatabase => Self::Corrupt,
                C::ConstraintViolation => Self::Constraint,
                C::CannotOpen | C::PermissionDenied | C::ReadOnly => Self::Open,
                _ => Self::Io,
            },
            rusqlite::Error::QueryReturnedNoRows => Self::NotFound,
            _ => Self::Io,
        }
    }
}

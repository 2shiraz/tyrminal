/// One stored record exactly as persisted. Every field is cleartext operational metadata except
/// `ciphertext`, which only the vault crate can open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordRow {
    pub record_id: [u8; 16],
    pub kind: u16,
    pub revision: u64,
    pub key_version: u32,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
    /// Index hint mirroring the authenticated tombstone marker inside the ciphertext.
    pub deleted: bool,
}

/// Optimistic-concurrency condition for a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteCondition {
    /// The record must not exist yet.
    Create,
    /// The stored revision must equal this value, and the new revision must be exactly one more.
    Replace { expected_revision: u64 },
}

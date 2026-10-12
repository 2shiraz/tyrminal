//! Portable encrypted backups (docs/crypto-format.md §10).
//!
//! A backup carries the vault header and every live record envelope exactly as stored, so it opens
//! with the same passphrase or recovery key, plus an HMAC under `K_backup` over the whole file.
//! Record contents stay sealed under `K_records`; this module never decrypts them.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::encoding::Reader;
use crate::envelope::{MAX_PAYLOAD_LEN, PAD_BLOCK, SealedRecord};
use crate::header::{UnlockedVault, VaultHeader};
use crate::{Id, VaultError};

pub const BACKUP_MAGIC: &[u8; 8] = b"TYRBACKP";
pub const BACKUP_VERSION: u16 = 1;
/// Upper bounds a decoder enforces before allocating: records per backup and total file size.
pub const MAX_BACKUP_RECORDS: usize = 100_000;
pub const MAX_BACKUP_LEN: usize = 256 * 1024 * 1024;

const MAC_LEN: usize = 32;
/// The largest valid record ciphertext: length prefix + payload, padded, plus the AEAD tag.
const MAX_CIPHERTEXT_LEN: usize = (MAX_PAYLOAD_LEN + 4).div_ceil(PAD_BLOCK) * PAD_BLOCK + 16;
/// The largest valid header (all six slots).
const MAX_HEADER_LEN: usize = 31 + 123 * 6 + 32;

/// One record envelope inside a backup, with the coordinates its AAD binds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupRecord {
    pub record_id: Id,
    pub kind: u16,
    pub revision: u64,
    pub sealed: SealedRecord,
}

/// A structurally valid backup. Nothing in it is authenticated until
/// [`UnlockedVault::verify_backup`] succeeds with keys unlocked from `header`.
#[derive(Debug, Clone)]
pub struct ParsedBackup {
    /// Seconds since the Unix epoch when the backup was written (cleartext, informational).
    pub created_at: u64,
    pub header: VaultHeader,
    /// Ordered by `record_id`, strictly increasing (no duplicates).
    pub records: Vec<BackupRecord>,
    body_len: usize,
    mac: [u8; MAC_LEN],
    bytes: Vec<u8>,
}

fn malformed<T>(_: T) -> VaultError {
    VaultError::MalformedBackup
}

/// Strict, bounded parse. No key material is needed or used.
pub fn decode_backup(bytes: &[u8]) -> Result<ParsedBackup, VaultError> {
    if bytes.len() > MAX_BACKUP_LEN || bytes.len() < 8 + 2 + 8 + 4 + 4 + MAC_LEN {
        return Err(VaultError::MalformedBackup);
    }
    let mut r = Reader::new(bytes);
    if r.take(8).map_err(malformed)? != BACKUP_MAGIC {
        return Err(VaultError::MalformedBackup);
    }
    if r.u16().map_err(malformed)? != BACKUP_VERSION {
        return Err(VaultError::UnsupportedBackupVersion);
    }
    let created_at = u64::from_be_bytes(r.array().map_err(malformed)?);
    let header_len = r.u32().map_err(malformed)? as usize;
    if header_len > MAX_HEADER_LEN {
        return Err(VaultError::MalformedBackup);
    }
    let header = VaultHeader::decode(r.take(header_len).map_err(malformed)?)?;
    let count = r.u32().map_err(malformed)? as usize;
    if count > MAX_BACKUP_RECORDS {
        return Err(VaultError::MalformedBackup);
    }
    // Each record takes at least its fixed fields; reject counts the file cannot hold before
    // reserving memory for them.
    let fixed = 16 + 2 + 8 + 4 + 24 + 4;
    if count.saturating_mul(fixed) > bytes.len() {
        return Err(VaultError::MalformedBackup);
    }
    let mut records: Vec<BackupRecord> = Vec::with_capacity(count);
    for _ in 0..count {
        let record_id: Id = r.array().map_err(malformed)?;
        let kind = r.u16().map_err(malformed)?;
        let revision = u64::from_be_bytes(r.array().map_err(malformed)?);
        let key_version = r.u32().map_err(malformed)?;
        let nonce: [u8; 24] = r.array().map_err(malformed)?;
        let len = r.u32().map_err(malformed)? as usize;
        if revision == 0
            || !(PAD_BLOCK + 16..=MAX_CIPHERTEXT_LEN).contains(&len)
            || !(len - 16).is_multiple_of(PAD_BLOCK)
        {
            return Err(VaultError::MalformedBackup);
        }
        if records.last().is_some_and(|prev| prev.record_id >= record_id) {
            return Err(VaultError::MalformedBackup);
        }
        let ciphertext = r.take(len).map_err(malformed)?.to_vec();
        records.push(BackupRecord {
            record_id,
            kind,
            revision,
            sealed: SealedRecord { key_version, nonce, ciphertext },
        });
    }
    let body_len = r.position();
    let mac: [u8; MAC_LEN] = r.array().map_err(malformed)?;
    if !r.is_empty() {
        return Err(VaultError::MalformedBackup);
    }
    Ok(ParsedBackup { created_at, header, records, body_len, mac, bytes: bytes.to_vec() })
}

impl UnlockedVault {
    fn backup_mac(&self, body: &[u8]) -> Result<Hmac<Sha256>, VaultError> {
        let key = self.backup_key()?;
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key.expose()).map_err(|_| VaultError::Internal)?;
        mac.update(body);
        Ok(mac)
    }

    /// Writes a backup of `header` and `records` (live records only; the caller filters
    /// tombstones). Records are sorted by id; every record must belong to this key generation.
    pub fn encode_backup(
        &self,
        header: &VaultHeader,
        created_at: u64,
        records: &[BackupRecord],
    ) -> Result<Vec<u8>, VaultError> {
        self.verify_header(header)?;
        if records.len() > MAX_BACKUP_RECORDS {
            return Err(VaultError::PayloadTooLarge);
        }
        let mut sorted: Vec<&BackupRecord> = records.iter().collect();
        sorted.sort_by_key(|r| r.record_id);
        if sorted.windows(2).any(|w| w[0].record_id == w[1].record_id) {
            return Err(VaultError::Internal);
        }
        let header_bytes = header.encode();
        let mut out = Vec::new();
        out.extend_from_slice(BACKUP_MAGIC);
        out.extend_from_slice(&BACKUP_VERSION.to_be_bytes());
        out.extend_from_slice(&created_at.to_be_bytes());
        out.extend_from_slice(&u32::try_from(header_bytes.len()).map_err(|_| VaultError::Internal)?.to_be_bytes());
        out.extend_from_slice(&header_bytes);
        out.extend_from_slice(&u32::try_from(sorted.len()).map_err(|_| VaultError::Internal)?.to_be_bytes());
        for record in sorted {
            if record.sealed.key_version != self.key_version() {
                return Err(VaultError::KeyVersionMismatch);
            }
            out.extend_from_slice(&record.record_id);
            out.extend_from_slice(&record.kind.to_be_bytes());
            out.extend_from_slice(&record.revision.to_be_bytes());
            out.extend_from_slice(&record.sealed.key_version.to_be_bytes());
            out.extend_from_slice(&record.sealed.nonce);
            let len = u32::try_from(record.sealed.ciphertext.len()).map_err(|_| VaultError::Internal)?;
            out.extend_from_slice(&len.to_be_bytes());
            out.extend_from_slice(&record.sealed.ciphertext);
        }
        if out.len() + MAC_LEN > MAX_BACKUP_LEN {
            return Err(VaultError::PayloadTooLarge);
        }
        let mac = self.backup_mac(&out)?.finalize().into_bytes();
        out.extend_from_slice(&mac);
        Ok(out)
    }

    /// Authenticates a parsed backup with keys unlocked from its own header: the header MAC,
    /// then the backup MAC over every byte (constant-time), then each record's key generation.
    /// Record contents are authenticated when the caller opens them.
    pub fn verify_backup(&self, backup: &ParsedBackup) -> Result<(), VaultError> {
        self.verify_header(&backup.header)?;
        self.backup_mac(&backup.bytes[..backup.body_len])?
            .verify_slice(&backup.mac)
            .map_err(|_| VaultError::BackupTampered)?;
        if backup.records.iter().any(|r| r.sealed.key_version != self.key_version()) {
            return Err(VaultError::KeyVersionMismatch);
        }
        Ok(())
    }
}

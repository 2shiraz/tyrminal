use chacha20poly1305::aead::AeadInOut;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::header::FORMAT_VERSION;
use crate::{Id, SecretKey, VaultError};

/// Maximum record payload (1 MiB), before framing and padding.
pub const MAX_PAYLOAD_LEN: usize = 1024 * 1024;
/// Framed plaintext is padded to a multiple of this many bytes to coarsen size leakage.
pub const PAD_BLOCK: usize = 256;

const AAD_LABEL: &[u8] = b"tyrminal.record.v1\0";
const TAG_LEN: usize = 16;
const LEN_PREFIX: usize = 4;

/// The cleartext coordinates a record ciphertext is bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordContext {
    pub record_id: Id,
    pub kind: u16,
    /// Starts at 1 and increases with every write of the record.
    pub revision: u64,
}

/// An encrypted record as stored: everything here is safe to persist in clear.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedRecord {
    pub key_version: u32,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}

fn aad(vault_id: &Id, key_version: u32, ctx: &RecordContext) -> [u8; 67] {
    let mut out = [0u8; 67];
    let mut at = 0;
    let mut put = |bytes: &[u8]| {
        out[at..at + bytes.len()].copy_from_slice(bytes);
        at += bytes.len();
    };
    put(AAD_LABEL);
    put(&FORMAT_VERSION.to_be_bytes());
    put(vault_id);
    put(&ctx.record_id);
    put(&ctx.kind.to_be_bytes());
    put(&ctx.revision.to_be_bytes());
    put(&key_version.to_be_bytes());
    debug_assert_eq!(at, 67);
    out
}

pub(crate) fn seal(
    key: &SecretKey,
    vault_id: &Id,
    key_version: u32,
    ctx: &RecordContext,
    payload: &[u8],
) -> Result<SealedRecord, VaultError> {
    if payload.len() > MAX_PAYLOAD_LEN {
        return Err(VaultError::PayloadTooLarge);
    }
    if ctx.revision == 0 {
        return Err(VaultError::MalformedRecord);
    }
    let framed_len = (LEN_PREFIX + payload.len()).div_ceil(PAD_BLOCK) * PAD_BLOCK;
    // Reserve room for the tag up front so encryption never reallocates and strands a plaintext copy.
    let mut buffer = Zeroizing::new(Vec::with_capacity(framed_len + TAG_LEN));
    buffer.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buffer.extend_from_slice(payload);
    buffer.resize(framed_len, 0);

    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| VaultError::Randomness)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose()).map_err(|_| VaultError::Internal)?;
    cipher
        .encrypt_in_place(&XNonce::from(nonce), &aad(vault_id, key_version, ctx), &mut *buffer)
        .map_err(|_| VaultError::Internal)?;
    Ok(SealedRecord { key_version, nonce, ciphertext: core::mem::take(&mut *buffer) })
}

pub(crate) fn open(
    key: &SecretKey,
    vault_id: &Id,
    key_version: u32,
    ctx: &RecordContext,
    sealed: &SealedRecord,
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if sealed.key_version != key_version {
        return Err(VaultError::KeyVersionMismatch);
    }
    let max_ciphertext = (LEN_PREFIX + MAX_PAYLOAD_LEN).div_ceil(PAD_BLOCK) * PAD_BLOCK + TAG_LEN;
    if sealed.ciphertext.len() < PAD_BLOCK + TAG_LEN || sealed.ciphertext.len() > max_ciphertext {
        return Err(VaultError::MalformedRecord);
    }
    let mut buffer = Zeroizing::new(sealed.ciphertext.clone());
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose()).map_err(|_| VaultError::Internal)?;
    cipher
        .decrypt_in_place(&XNonce::from(sealed.nonce), &aad(vault_id, key_version, ctx), &mut *buffer)
        .map_err(|_| VaultError::RecordAuthentication)?;

    // Authenticated from here on; these checks reject well-formed-but-wrong writers, not attackers.
    if !buffer.len().is_multiple_of(PAD_BLOCK) {
        return Err(VaultError::MalformedRecord);
    }
    let declared = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
    let end = LEN_PREFIX.checked_add(declared).filter(|&e| e <= buffer.len()).ok_or(VaultError::MalformedRecord)?;
    if declared > MAX_PAYLOAD_LEN || buffer[end..].iter().any(|&b| b != 0) {
        return Err(VaultError::MalformedRecord);
    }
    buffer.truncate(end);
    buffer.drain(..LEN_PREFIX);
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SecretKey {
        SecretKey::from_bytes([0x42; 32])
    }
    const VAULT: Id = [0x11; 16];
    const CTX: RecordContext = RecordContext { record_id: [0x22; 16], kind: 3, revision: 7 };

    #[test]
    fn round_trip_and_padding() {
        for len in [0usize, 1, 251, 252, 253, 4096, MAX_PAYLOAD_LEN] {
            let payload = vec![0xA5u8; len];
            let sealed = seal(&key(), &VAULT, 1, &CTX, &payload).unwrap();
            assert_eq!((sealed.ciphertext.len() - TAG_LEN) % PAD_BLOCK, 0, "len {len}");
            assert_eq!(&*open(&key(), &VAULT, 1, &CTX, &sealed).unwrap(), &payload);
        }
    }

    #[test]
    fn oversized_payload_and_zero_revision_are_rejected() {
        let big = vec![0u8; MAX_PAYLOAD_LEN + 1];
        assert_eq!(seal(&key(), &VAULT, 1, &CTX, &big).err(), Some(VaultError::PayloadTooLarge));
        let ctx = RecordContext { revision: 0, ..CTX };
        assert_eq!(seal(&key(), &VAULT, 1, &ctx, b"x").err(), Some(VaultError::MalformedRecord));
    }

    #[test]
    fn nonces_are_fresh_for_every_encryption() {
        let a = seal(&key(), &VAULT, 1, &CTX, b"same").unwrap();
        let b = seal(&key(), &VAULT, 1, &CTX, b"same").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn every_bound_field_is_authenticated() {
        let sealed = seal(&key(), &VAULT, 1, &CTX, b"host: example").unwrap();
        let auth = Some(VaultError::RecordAuthentication);

        let other_vault = [0x12; 16];
        assert_eq!(open(&key(), &other_vault, 1, &CTX, &sealed).err(), auth);
        let other_record = RecordContext { record_id: [0x23; 16], ..CTX };
        assert_eq!(open(&key(), &VAULT, 1, &other_record, &sealed).err(), auth);
        let other_kind = RecordContext { kind: 4, ..CTX };
        assert_eq!(open(&key(), &VAULT, 1, &other_kind, &sealed).err(), auth);
        let other_revision = RecordContext { revision: 8, ..CTX };
        assert_eq!(open(&key(), &VAULT, 1, &other_revision, &sealed).err(), auth);
        let other_key = SecretKey::from_bytes([0x43; 32]);
        assert_eq!(open(&other_key, &VAULT, 1, &CTX, &sealed).err(), auth);

        // A relabelled key version is refused before decryption; a matching relabel fails the AAD.
        assert_eq!(open(&key(), &VAULT, 2, &CTX, &sealed).err(), Some(VaultError::KeyVersionMismatch));
        let relabelled = SealedRecord { key_version: 2, ..sealed.clone() };
        assert_eq!(open(&key(), &VAULT, 2, &CTX, &relabelled).err(), auth);
    }

    #[test]
    fn every_single_bit_flip_in_nonce_or_ciphertext_is_detected() {
        let sealed = seal(&key(), &VAULT, 1, &CTX, b"secret").unwrap();
        for i in 0..sealed.ciphertext.len() * 8 {
            let mut t = sealed.clone();
            t.ciphertext[i / 8] ^= 1 << (i % 8);
            assert_eq!(open(&key(), &VAULT, 1, &CTX, &t).err(), Some(VaultError::RecordAuthentication));
        }
        for i in 0..24 * 8 {
            let mut t = sealed.clone();
            t.nonce[i / 8] ^= 1 << (i % 8);
            assert_eq!(open(&key(), &VAULT, 1, &CTX, &t).err(), Some(VaultError::RecordAuthentication));
        }
    }

    #[test]
    fn truncated_and_oversized_ciphertexts_are_rejected_without_decrypting() {
        let sealed = seal(&key(), &VAULT, 1, &CTX, b"secret").unwrap();
        let mut short = sealed.clone();
        short.ciphertext.truncate(PAD_BLOCK + TAG_LEN - 1);
        assert_eq!(open(&key(), &VAULT, 1, &CTX, &short).err(), Some(VaultError::MalformedRecord));
        let mut empty = sealed.clone();
        empty.ciphertext.clear();
        assert_eq!(open(&key(), &VAULT, 1, &CTX, &empty).err(), Some(VaultError::MalformedRecord));
        let mut huge = sealed;
        huge.ciphertext.resize(MAX_PAYLOAD_LEN + 2 * PAD_BLOCK + TAG_LEN, 0);
        assert_eq!(open(&key(), &VAULT, 1, &CTX, &huge).err(), Some(VaultError::MalformedRecord));
    }
}

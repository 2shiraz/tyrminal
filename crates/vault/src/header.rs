use chacha20poly1305::aead::AeadInOut;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::encoding::Reader;
use crate::envelope::{self, RecordContext, SealedRecord};
use crate::kdf::{self, KdfProfile, PASSPHRASE_MAX_LEN, PASSPHRASE_MIN_NEW_LEN};
use crate::keys::{self, LABEL_HEADER_MAC, LABEL_KEK_DEVICE, LABEL_KEK_RECOVERY, LABEL_RECORDS};
use crate::{Id, Passphrase, RecoveryKey, SecretKey, VaultError, random_id};

/// The only vault format version this build reads or writes.
pub const FORMAT_VERSION: u16 = 1;
/// Maximum number of device (quick-unlock) slots in one header.
pub const MAX_DEVICE_SLOTS: usize = 4;

const MAGIC: &[u8; 8] = b"TYRVAULT";
const SLOT_AAD_LABEL: &[u8] = b"tyrminal.keyslot.v1\0";
const FIXED_PREFIX_LEN: usize = 8 + 2 + 16 + 4 + 1;
const SLOT_LEN: usize = 1 + 16 + 2 + 32 + 24 + 48;
const MAC_LEN: usize = 32;
const MAX_SLOTS: usize = 2 + MAX_DEVICE_SLOTS;

/// What kind of credential a key slot accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Passphrase = 1,
    Recovery = 2,
    Device = 3,
}

impl SlotKind {
    fn from_u8(v: u8) -> Result<Self, VaultError> {
        match v {
            1 => Ok(Self::Passphrase),
            2 => Ok(Self::Recovery),
            3 => Ok(Self::Device),
            _ => Err(VaultError::MalformedHeader),
        }
    }

    fn profile(self) -> KdfProfile {
        match self {
            Self::Passphrase => KdfProfile::Argon2idV1,
            Self::Recovery | Self::Device => KdfProfile::HkdfSha256,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct KeySlot {
    kind: SlotKind,
    id: Id,
    salt: [u8; 32],
    nonce: [u8; 24],
    wrapped: [u8; 48],
}

/// A credential presented to unlock a vault.
#[derive(Debug)]
pub enum Credential<'a> {
    Passphrase(&'a Passphrase),
    Recovery(&'a RecoveryKey),
    /// A 32-byte secret held in the OS secret store for quick unlock.
    Device(&'a SecretKey),
}

impl Credential<'_> {
    fn kind(&self) -> SlotKind {
        match self {
            Self::Passphrase(_) => SlotKind::Passphrase,
            Self::Recovery(_) => SlotKind::Recovery,
            Self::Device(_) => SlotKind::Device,
        }
    }

    fn kek(&self, salt: &[u8; 32]) -> Result<SecretKey, VaultError> {
        match self {
            Self::Passphrase(p) => kdf::passphrase_kek(p, salt),
            Self::Recovery(r) => kdf::hkdf_key(r.key().expose(), salt, LABEL_KEK_RECOVERY),
            Self::Device(d) => kdf::hkdf_key(d.expose(), salt, LABEL_KEK_DEVICE),
        }
    }
}

/// The parsed, still-locked vault header (docs/crypto-format.md §4). Contains no secret.
#[derive(Clone, PartialEq, Eq)]
pub struct VaultHeader {
    vault_id: Id,
    key_version: u32,
    slots: Vec<KeySlot>,
    mac: [u8; MAC_LEN],
}

impl core::fmt::Debug for VaultHeader {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VaultHeader")
            .field("key_version", &self.key_version)
            .field("slots", &self.slots.len())
            .finish_non_exhaustive()
    }
}

fn slot_aad(vault_id: &Id, key_version: u32, kind: SlotKind, slot_id: &Id, salt: &[u8; 32]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(SLOT_AAD_LABEL.len() + 2 + 16 + 4 + 1 + 16 + 2 + 32);
    aad.extend_from_slice(SLOT_AAD_LABEL);
    aad.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    aad.extend_from_slice(vault_id);
    aad.extend_from_slice(&key_version.to_be_bytes());
    aad.push(kind as u8);
    aad.extend_from_slice(slot_id);
    aad.extend_from_slice(&kind.profile().id().to_be_bytes());
    aad.extend_from_slice(salt);
    aad
}

fn wrap_slot(
    credential: &Credential<'_>,
    root: &SecretKey,
    vault_id: &Id,
    key_version: u32,
) -> Result<KeySlot, VaultError> {
    let kind = credential.kind();
    let id = random_id()?;
    let mut salt = [0u8; 32];
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut salt).map_err(|_| VaultError::Randomness)?;
    getrandom::fill(&mut nonce).map_err(|_| VaultError::Randomness)?;

    let kek = credential.kek(&salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(kek.expose()).map_err(|_| VaultError::Internal)?;
    let mut buffer = Zeroizing::new(Vec::with_capacity(48));
    buffer.extend_from_slice(root.expose());
    cipher
        .encrypt_in_place(&XNonce::from(nonce), &slot_aad(vault_id, key_version, kind, &id, &salt), &mut *buffer)
        .map_err(|_| VaultError::Internal)?;
    let wrapped: [u8; 48] = buffer.as_slice().try_into().map_err(|_| VaultError::Internal)?;
    Ok(KeySlot { kind, id, salt, nonce, wrapped })
}

fn unwrap_slot(
    slot: &KeySlot,
    credential: &Credential<'_>,
    vault_id: &Id,
    key_version: u32,
) -> Result<SecretKey, VaultError> {
    let kek = credential.kek(&slot.salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(kek.expose()).map_err(|_| VaultError::Internal)?;
    let mut buffer = Zeroizing::new(slot.wrapped.to_vec());
    cipher
        .decrypt_in_place(
            &XNonce::from(slot.nonce),
            &slot_aad(vault_id, key_version, slot.kind, &slot.id, &slot.salt),
            &mut *buffer,
        )
        .map_err(|_| VaultError::WrongCredential)?;
    let mut root = SecretKey::from_bytes([0u8; 32]);
    root.expose_mut().copy_from_slice(&buffer);
    Ok(root)
}

impl VaultHeader {
    pub fn vault_id(&self) -> Id {
        self.vault_id
    }

    pub fn key_version(&self) -> u32 {
        self.key_version
    }

    /// Number of key slots of the given kind.
    pub fn slot_count(&self, kind: SlotKind) -> usize {
        self.slots.iter().filter(|s| s.kind == kind).count()
    }

    /// Identifiers of the device (quick-unlock) slots, for matching against the OS secret store.
    pub fn device_slot_ids(&self) -> Vec<Id> {
        self.slots.iter().filter(|s| s.kind == SlotKind::Device).map(|s| s.id).collect()
    }

    fn encode_unsigned(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(FIXED_PREFIX_LEN + SLOT_LEN * self.slots.len() + MAC_LEN);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
        out.extend_from_slice(&self.vault_id);
        out.extend_from_slice(&self.key_version.to_be_bytes());
        out.push(self.slots.len() as u8);
        for slot in &self.slots {
            out.push(slot.kind as u8);
            out.extend_from_slice(&slot.id);
            out.extend_from_slice(&slot.kind.profile().id().to_be_bytes());
            out.extend_from_slice(&slot.salt);
            out.extend_from_slice(&slot.nonce);
            out.extend_from_slice(&slot.wrapped);
        }
        out
    }

    /// Serializes the header exactly as specified.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = self.encode_unsigned();
        out.extend_from_slice(&self.mac);
        out
    }

    /// Strictly parses untrusted header bytes. Performs no key derivation and allocates at most
    /// `MAX_SLOTS` fixed-size slots.
    pub fn decode(bytes: &[u8]) -> Result<Self, VaultError> {
        let mut r = Reader::new(bytes);
        if r.take(MAGIC.len())? != MAGIC {
            return Err(VaultError::MalformedHeader);
        }
        if r.u16()? != FORMAT_VERSION {
            return Err(VaultError::UnsupportedVersion);
        }
        let vault_id: Id = r.array()?;
        let key_version = r.u32()?;
        let slot_count = usize::from(r.u8()?);
        if key_version == 0 || slot_count == 0 || slot_count > MAX_SLOTS {
            return Err(VaultError::MalformedHeader);
        }
        if bytes.len() != FIXED_PREFIX_LEN + SLOT_LEN * slot_count + MAC_LEN {
            return Err(VaultError::MalformedHeader);
        }
        let mut slots: Vec<KeySlot> = Vec::with_capacity(slot_count);
        for _ in 0..slot_count {
            let kind = SlotKind::from_u8(r.u8()?)?;
            let id: Id = r.array()?;
            let profile = KdfProfile::from_id(r.u16()?)?;
            if profile != kind.profile() {
                return Err(VaultError::MalformedHeader);
            }
            let slot = KeySlot { kind, id, salt: r.array()?, nonce: r.array()?, wrapped: r.array()? };
            if slots.iter().any(|s| s.id == slot.id) {
                return Err(VaultError::MalformedHeader);
            }
            slots.push(slot);
        }
        debug_assert_eq!(r.position(), bytes.len() - MAC_LEN);
        let mac: [u8; MAC_LEN] = r.array()?;
        if !r.is_empty() {
            return Err(VaultError::MalformedHeader);
        }
        let header = Self { vault_id, key_version, slots, mac };
        header.check_slot_limits()?;
        Ok(header)
    }

    fn check_slot_limits(&self) -> Result<(), VaultError> {
        if self.slot_count(SlotKind::Passphrase) != 1
            || self.slot_count(SlotKind::Recovery) > 1
            || self.slot_count(SlotKind::Device) > MAX_DEVICE_SLOTS
        {
            return Err(VaultError::MalformedHeader);
        }
        Ok(())
    }

    /// Unlocks with a credential. Runs Argon2id for passphrases: blocking, 64 MiB, at most once.
    ///
    /// Returns `NoSuchSlot` if the header has no slot of that kind, `WrongCredential` if no slot
    /// opens, and `HeaderTampered` if a slot opens but the header MAC does not verify.
    pub fn unlock(&self, credential: &Credential<'_>) -> Result<UnlockedVault, VaultError> {
        let kind = credential.kind();
        let mut candidates = self.slots.iter().filter(|s| s.kind == kind).peekable();
        if candidates.peek().is_none() {
            return Err(VaultError::NoSuchSlot);
        }
        for slot in candidates {
            match unwrap_slot(slot, credential, &self.vault_id, self.key_version) {
                Ok(root) => {
                    let unlocked = UnlockedVault::from_root(root, self.vault_id, self.key_version)?;
                    unlocked.verify_header(self)?;
                    return Ok(unlocked);
                }
                Err(VaultError::WrongCredential) => {}
                Err(other) => return Err(other),
            }
        }
        Err(VaultError::WrongCredential)
    }
}

/// A freshly created vault: its header, the unlocked handle and the one-time recovery key.
#[derive(Debug)]
pub struct NewVault {
    pub header: VaultHeader,
    pub unlocked: UnlockedVault,
    pub recovery_key: RecoveryKey,
}

/// Creates a vault with a passphrase slot and a recovery slot. Blocking (Argon2id).
pub fn create_vault(passphrase: &Passphrase) -> Result<NewVault, VaultError> {
    check_new_passphrase(passphrase)?;
    let vault_id = random_id()?;
    let key_version = 1;
    let root = SecretKey::generate()?;
    let recovery_key = RecoveryKey::generate()?;
    let slots = vec![
        wrap_slot(&Credential::Passphrase(passphrase), &root, &vault_id, key_version)?,
        wrap_slot(&Credential::Recovery(&recovery_key), &root, &vault_id, key_version)?,
    ];
    let unlocked = UnlockedVault::from_root(root, vault_id, key_version)?;
    let header = unlocked.sign(VaultHeader { vault_id, key_version, slots, mac: [0u8; MAC_LEN] })?;
    Ok(NewVault { header, unlocked, recovery_key })
}

fn check_new_passphrase(passphrase: &Passphrase) -> Result<(), VaultError> {
    if passphrase.len() < PASSPHRASE_MIN_NEW_LEN || passphrase.len() > PASSPHRASE_MAX_LEN {
        return Err(VaultError::PassphraseLength);
    }
    Ok(())
}

/// Key material for an unlocked vault. Zeroized on drop; not `Clone`; never crosses IPC.
pub struct UnlockedVault {
    vault_id: Id,
    key_version: u32,
    root: SecretKey,
    records: SecretKey,
    header_mac: SecretKey,
}

impl core::fmt::Debug for UnlockedVault {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("UnlockedVault").field("key_version", &self.key_version).finish_non_exhaustive()
    }
}

impl UnlockedVault {
    fn from_root(root: SecretKey, vault_id: Id, key_version: u32) -> Result<Self, VaultError> {
        let records = keys::subkey(&root, &vault_id, LABEL_RECORDS)?;
        let header_mac = keys::subkey(&root, &vault_id, LABEL_HEADER_MAC)?;
        Ok(Self { vault_id, key_version, root, records, header_mac })
    }

    pub fn vault_id(&self) -> Id {
        self.vault_id
    }

    pub fn key_version(&self) -> u32 {
        self.key_version
    }

    /// `K_backup`, derived on demand so it exists only while a backup is written or checked.
    pub(crate) fn backup_key(&self) -> Result<SecretKey, VaultError> {
        keys::subkey(&self.root, &self.vault_id, keys::LABEL_BACKUP)
    }

    fn mac(&self, unsigned: &[u8]) -> Result<Hmac<Sha256>, VaultError> {
        let mut mac =
            <Hmac<Sha256> as KeyInit>::new_from_slice(self.header_mac.expose()).map_err(|_| VaultError::Internal)?;
        mac.update(unsigned);
        Ok(mac)
    }

    fn sign(&self, mut header: VaultHeader) -> Result<VaultHeader, VaultError> {
        header.check_slot_limits()?;
        header.mac = self.mac(&header.encode_unsigned())?.finalize().into_bytes().into();
        Ok(header)
    }

    /// Checks that `header` belongs to this vault and is unmodified (constant-time MAC compare).
    pub fn verify_header(&self, header: &VaultHeader) -> Result<(), VaultError> {
        if header.vault_id != self.vault_id || header.key_version != self.key_version {
            return Err(VaultError::HeaderTampered);
        }
        self.mac(&header.encode_unsigned())?.verify_slice(&header.mac).map_err(|_| VaultError::HeaderTampered)
    }

    /// Encrypts a record payload under a fresh random nonce.
    pub fn seal(&self, ctx: &RecordContext, payload: &[u8]) -> Result<SealedRecord, VaultError> {
        envelope::seal(&self.records, &self.vault_id, self.key_version, ctx, payload)
    }

    /// Authenticates and decrypts a record. The returned plaintext is zeroized on drop.
    pub fn open(&self, ctx: &RecordContext, sealed: &SealedRecord) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        envelope::open(&self.records, &self.vault_id, self.key_version, ctx, sealed)
    }

    /// Returns a header whose passphrase slot is replaced. Records are untouched (rewrap).
    /// Blocking (Argon2id). The caller persists the result atomically.
    pub fn change_passphrase(&self, header: &VaultHeader, new: &Passphrase) -> Result<VaultHeader, VaultError> {
        check_new_passphrase(new)?;
        self.verify_header(header)?;
        let slot = wrap_slot(&Credential::Passphrase(new), &self.root, &self.vault_id, self.key_version)?;
        let mut next = header.clone();
        next.slots.retain(|s| s.kind != SlotKind::Passphrase);
        next.slots.insert(0, slot);
        self.sign(next)
    }

    /// Replaces the recovery slot with a newly generated recovery key.
    pub fn rotate_recovery_key(&self, header: &VaultHeader) -> Result<(VaultHeader, RecoveryKey), VaultError> {
        self.verify_header(header)?;
        let recovery_key = RecoveryKey::generate()?;
        let slot = wrap_slot(&Credential::Recovery(&recovery_key), &self.root, &self.vault_id, self.key_version)?;
        let mut next = header.clone();
        next.slots.retain(|s| s.kind != SlotKind::Recovery);
        next.slots.push(slot);
        Ok((self.sign(next)?, recovery_key))
    }

    /// Adds a quick-unlock slot for a device secret that the caller stores in the OS secret store.
    pub fn add_device_slot(&self, header: &VaultHeader, secret: &SecretKey) -> Result<(VaultHeader, Id), VaultError> {
        self.verify_header(header)?;
        if header.slot_count(SlotKind::Device) >= MAX_DEVICE_SLOTS {
            return Err(VaultError::SlotLimit);
        }
        let slot = wrap_slot(&Credential::Device(secret), &self.root, &self.vault_id, self.key_version)?;
        let id = slot.id;
        let mut next = header.clone();
        next.slots.push(slot);
        Ok((self.sign(next)?, id))
    }

    /// Removes a device slot. Passphrase and recovery slots cannot be removed this way.
    pub fn remove_device_slot(&self, header: &VaultHeader, slot_id: &Id) -> Result<VaultHeader, VaultError> {
        self.verify_header(header)?;
        let mut next = header.clone();
        let before = next.slots.len();
        next.slots.retain(|s| !(s.kind == SlotKind::Device && &s.id == slot_id));
        if next.slots.len() == before {
            return Err(VaultError::NoSuchSlot);
        }
        self.sign(next)
    }
}

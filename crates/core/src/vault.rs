//! Vault lifecycle and the decrypted record index.
//!
//! State machine (BUILD_SPEC §4.4): `UNINITIALIZED → LOCKED → UNLOCKING → UNLOCKED → LOCKING →
//! LOCKED`. One async mutex owns the vault: at most one create/unlock/migration runs at a time,
//! and a second unlock attempt is refused as busy instead of queueing another Argon2id run.
//!
//! Lock generations (INV-07): `lock()` bumps the generation *before* it waits for the mutex.
//! Work that started earlier either completes atomically under the mutex or observes the new
//! generation and discards its result; nothing decrypted is published after a lock.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{Mutex, watch};
use tyrminal_contracts::limits::{
    MAX_BULK_HOSTS, MAX_IMPORT_HOSTS, MAX_LABEL_LEN, MAX_RECENT_HOSTS, MAX_RECORDS_PER_KIND, MAX_SEARCH_LEN,
};
use tyrminal_contracts::{
    BackupCredentialKind, BackupPreview, BulkHostChange, ErrorCode, GroupInput, GroupSummary, HostAuthInput, HostInput,
    HostSummary, ImportFormat, ImportHost, ImportPreview, IpcError, KeyImportInput, KeySummary, KnownHostSummary,
    RecoveryKeyIssued, SnippetInput, SnippetSummary, VaultState, VaultStatus,
};
use tyrminal_platform::{KeystoreError, SecretStore};
use tyrminal_ssh::{ClientKey, Endpoint, KnownHost, PresentedHostKey};
use tyrminal_storage::{Database, RecordRow, WriteCondition};
use tyrminal_vault::{
    BackupRecord, Credential, Id, MAX_BACKUP_LEN, ParsedBackup, Passphrase, RecordContext, RecoveryKey, SealedRecord,
    SecretKey, UnlockedVault, VaultHeader, create_vault, decode_backup, random_id,
};
use zeroize::Zeroizing;

use crate::error::{err, from_backup, from_key, from_storage, from_vault, internal, invalid, locked, not_found};
use crate::import;
use crate::inventory::{self, EffectiveAuth, GroupIndex, Query, TreeError};
use crate::records::{
    Decoded, GroupRecord, HostRecord, KIND_GROUP, KIND_HOST, KIND_KEY, KIND_KNOWN_HOST, KIND_SNIPPET, KIND_TRUST_EVENT,
    KeyRecord, KnownHostRecord, SnippetRecord, StoredAuth, TrustEventRecord, decode, encode, tombstone,
};
use crate::validate;

struct Stored<T> {
    revision: u64,
    record: T,
}

/// Everything that exists only while the vault is unlocked. Dropping it zeroizes the keys and
/// every decrypted secret (the record types hold secrets in `Zeroizing` buffers).
struct Open {
    keys: UnlockedVault,
    hosts: BTreeMap<Id, Stored<HostRecord>>,
    ssh_keys: BTreeMap<Id, Stored<KeyRecord>>,
    known_hosts: BTreeMap<Id, Stored<KnownHostRecord>>,
    snippets: BTreeMap<Id, Stored<SnippetRecord>>,
    groups: BTreeMap<Id, Stored<GroupRecord>>,
}

impl Open {
    fn new(keys: UnlockedVault) -> Self {
        Self {
            keys,
            hosts: BTreeMap::new(),
            ssh_keys: BTreeMap::new(),
            known_hosts: BTreeMap::new(),
            snippets: BTreeMap::new(),
            groups: BTreeMap::new(),
        }
    }
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    header: Option<VaultHeader>,
    open: Option<Open>,
}

/// What a session needs to connect, copied out of the vault at one generation.
pub(crate) struct ConnectionPlan {
    pub host_id: String,
    pub endpoint: Endpoint,
    pub username: String,
    pub auth: PlanAuth,
    /// Trusted keys with their display fingerprints.
    pub known_hosts: Vec<(KnownHost, String)>,
    pub generation: u32,
}

pub(crate) enum PlanAuth {
    Ask,
    Password(Zeroizing<String>),
    Key { private_key: Zeroizing<String>, passphrase: Option<Zeroizing<String>> },
}

pub struct VaultService {
    db: Database,
    /// OS secret store for quick unlock. Unavailable stores fail closed: there is no fallback.
    secret_store: std::sync::Arc<dyn SecretStore>,
    inner: Mutex<Inner>,
    status: watch::Sender<VaultStatus>,
    generation: AtomicU32,
    failed_unlocks: AtomicU32,
    last_activity: std::sync::Mutex<std::time::Instant>,
}

impl core::fmt::Debug for VaultService {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VaultService").field("status", &*self.status.borrow()).finish_non_exhaustive()
    }
}

const SUSPEND_CHECK_EVERY: Duration = Duration::from_secs(5);
/// More wall-clock time than monotonic time between two checks means the machine was asleep
/// (or the clock jumped forward); either way the vault locks.
const SUSPEND_GAP: Duration = Duration::from_secs(30);

pub(crate) fn slept_between(wall: Duration, monotonic: Duration) -> bool {
    wall.saturating_sub(monotonic) >= SUSPEND_GAP
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn busy() -> IpcError {
    err(ErrorCode::VaultBusy, "The vault is busy with another operation. Try again in a moment.")
}

fn group_index(open: &Open) -> GroupIndex<'_> {
    open.groups.iter().map(|(id, s)| (validate::id_text(id), &s.record)).collect()
}

fn host_summary(groups: &GroupIndex<'_>, id: &Id, record: &HostRecord) -> HostSummary {
    let effective = inventory::effective(groups, record);
    HostSummary {
        id: validate::id_text(id),
        label: record.label.clone(),
        address: record.address.clone(),
        port: effective.port,
        username: effective.username,
        auth: inventory::auth_summary(&effective.auth),
        inherited: effective.inherited,
        group_id: record.group.clone(),
        tags: record.tags.clone(),
        last_connected_at: record.last_connected_at,
    }
}

/// Host summaries for which `keep` holds, sorted by label.
fn sorted_hosts(open: &Open, mut keep: impl FnMut(&HostRecord) -> bool) -> Vec<HostSummary> {
    let groups = group_index(open);
    let mut hosts: Vec<_> = open
        .hosts
        .iter()
        .filter(|(_, s)| keep(&s.record))
        .map(|(id, s)| host_summary(&groups, id, &s.record))
        .collect();
    hosts.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    hosts
}

fn group_summary(id: &Id, record: &GroupRecord) -> GroupSummary {
    GroupSummary {
        id: validate::id_text(id),
        name: record.name.clone(),
        parent_id: record.parent.clone(),
        username: record.username.clone(),
        port: record.port,
        key_id: record.key_id.clone(),
    }
}

/// A field-by-field copy (the stored password is copied into a new zeroizing buffer).
fn copy_host(record: &HostRecord) -> HostRecord {
    let auth = match &record.auth {
        StoredAuth::Inherit => StoredAuth::Inherit,
        StoredAuth::AskPassword => StoredAuth::AskPassword,
        StoredAuth::Password { password } => {
            StoredAuth::Password { password: Zeroizing::new(password.as_str().to_owned()) }
        }
        StoredAuth::Key { key_id } => StoredAuth::Key { key_id: key_id.clone() },
    };
    HostRecord {
        label: record.label.clone(),
        address: record.address.clone(),
        port: record.port,
        username: record.username.clone(),
        auth,
        group: record.group.clone(),
        tags: record.tags.clone(),
        last_connected_at: record.last_connected_at,
    }
}

/// Total string bytes of a host record, which bounds its encoded size.
fn host_content_len(record: &HostRecord) -> usize {
    let secret_len = match &record.auth {
        StoredAuth::Password { password } => password.len(),
        StoredAuth::Key { key_id } => key_id.len(),
        StoredAuth::AskPassword | StoredAuth::Inherit => 0,
    };
    record.label.len()
        + record.address.len()
        + record.username.len()
        + secret_len
        + record.group.as_ref().map_or(0, String::len)
        + record.tags.iter().map(|t| t.len() + 4).sum::<usize>()
}

fn group_content_len(record: &GroupRecord) -> usize {
    record.name.len()
        + record.parent.as_ref().map_or(0, String::len)
        + record.username.as_ref().map_or(0, String::len)
        + record.key_id.as_ref().map_or(0, String::len)
}

fn snippet_summary(id: &Id, record: &SnippetRecord) -> SnippetSummary {
    SnippetSummary {
        id: validate::id_text(id),
        name: record.name.clone(),
        folder: record.folder.clone(),
        text: record.text.clone(),
        updated_at: record.updated_at,
    }
}

impl VaultService {
    pub(crate) fn new(db: Database, secret_store: std::sync::Arc<dyn SecretStore>) -> Self {
        let (status, _) = watch::channel(VaultStatus { state: VaultState::Locked, generation: 0 });
        Self {
            db,
            secret_store,
            inner: Mutex::new(Inner::default()),
            status,
            generation: AtomicU32::new(0),
            failed_unlocks: AtomicU32::new(0),
            last_activity: std::sync::Mutex::new(std::time::Instant::now()),
        }
    }

    pub(crate) fn generation(&self) -> u32 {
        self.generation.load(Ordering::Acquire)
    }

    /// Subscribes to state changes. Sessions use this to end themselves when the vault locks.
    pub fn subscribe(&self) -> watch::Receiver<VaultStatus> {
        self.status.subscribe()
    }

    /// Records user activity. The adapter calls this when the renderer reports input; it only
    /// postpones the idle lock and reveals nothing.
    pub fn note_activity(&self) {
        *self.last_activity.lock().unwrap_or_else(|p| p.into_inner()) = std::time::Instant::now();
    }

    /// Locks the vault after `timeout` without activity, for as long as the service lives.
    ///
    /// The timer runs here, not in the renderer: a hung or crashed renderer stops reporting
    /// activity and the vault still locks. (A compromised renderer can report fake activity;
    /// that is inside the stated limits of what an unlocked, compromised renderer can do.)
    pub async fn run_idle_lock(self: std::sync::Arc<Self>, timeout: Duration) {
        let mut status = self.subscribe();
        loop {
            if status.wait_for(|s| s.state == VaultState::Unlocked).await.is_err() {
                return;
            }
            self.note_activity();
            loop {
                let idle = self.last_activity.lock().unwrap_or_else(|p| p.into_inner()).elapsed();
                if idle >= timeout {
                    self.lock().await;
                    break;
                }
                // Wake at least every few seconds so a system sleep is noticed promptly: the
                // monotonic clock (and so `idle`) does not advance while macOS or Linux sleeps.
                let (wall, mono) = (SystemTime::now(), std::time::Instant::now());
                tokio::select! {
                    () = tokio::time::sleep((timeout - idle).min(SUSPEND_CHECK_EVERY)) => {}
                    changed = status.wait_for(|s| s.state != VaultState::Unlocked) => {
                        if changed.is_err() {
                            return;
                        }
                        break;
                    }
                }
                if slept_between(wall.elapsed().unwrap_or(Duration::ZERO), mono.elapsed()) {
                    self.lock().await;
                    break;
                }
            }
        }
    }

    fn set_state(&self, state: VaultState) {
        self.status.send_replace(VaultStatus { state, generation: self.generation() });
    }

    async fn ensure_loaded(&self, inner: &mut Inner) -> Result<(), IpcError> {
        if inner.loaded {
            return Ok(());
        }
        match self.db.read_header().await.map_err(from_storage)? {
            None => {
                inner.header = None;
                self.set_state(VaultState::Uninitialized);
            }
            Some(bytes) => {
                inner.header = Some(VaultHeader::decode(&bytes).map_err(from_vault)?);
                self.set_state(VaultState::Locked);
            }
        }
        inner.loaded = true;
        Ok(())
    }

    /// Current state. The first call reads the stored header to tell a missing vault from a
    /// locked one.
    pub async fn status(&self) -> Result<VaultStatus, IpcError> {
        if let Ok(mut inner) = self.inner.try_lock() {
            self.ensure_loaded(&mut inner).await?;
        }
        Ok(*self.status.borrow())
    }

    /// Creates the vault and leaves it unlocked. Returns the recovery key exactly once.
    pub async fn create(&self, passphrase: String) -> Result<RecoveryKeyIssued, IpcError> {
        let passphrase = Passphrase::new(passphrase);
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        self.ensure_loaded(&mut inner).await?;
        if inner.header.is_some() {
            return Err(err(ErrorCode::VaultAlreadyExists, "A vault already exists here. It was not overwritten."));
        }
        let generation = self.generation();
        // Argon2id: blocking and memory-hard, so it runs off the async reactor.
        let created = tokio::task::spawn_blocking(move || create_vault(&passphrase))
            .await
            .map_err(|_| internal())?
            .map_err(from_vault)?;
        self.db.init_header(created.header.encode()).await.map_err(from_storage)?;
        inner.header = Some(created.header);
        let issued = RecoveryKeyIssued { recovery_key: created.recovery_key.to_display_string().to_string() };
        if self.generation() != generation {
            // A lock was requested while creating: the vault exists but stays locked.
            self.set_state(VaultState::Locked);
            return Ok(issued);
        }
        inner.open = Some(Open::new(created.unlocked));
        self.set_state(VaultState::Unlocked);
        Ok(issued)
    }

    pub async fn unlock_with_passphrase(&self, passphrase: String) -> Result<(), IpcError> {
        let passphrase = Passphrase::new(passphrase);
        self.unlock(move |header| header.unlock(&Credential::Passphrase(&passphrase))).await
    }

    pub async fn unlock_with_recovery_key(&self, recovery_key: String) -> Result<(), IpcError> {
        let recovery_key = Zeroizing::new(recovery_key);
        let key = RecoveryKey::parse(&recovery_key).map_err(from_vault)?;
        self.unlock(move |header| header.unlock(&Credential::Recovery(&key))).await
    }

    async fn unlock<F>(&self, open_header: F) -> Result<(), IpcError>
    where
        F: FnOnce(&VaultHeader) -> Result<UnlockedVault, tyrminal_vault::VaultError> + Send + 'static,
    {
        // `try_lock`: a second concurrent attempt is refused, so unlock attempts never stack up
        // 64 MiB KDF runs (BUILD_SPEC §4.3 "serialize unlock attempts").
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        self.ensure_loaded(&mut inner).await?;
        if inner.open.is_some() {
            return Ok(());
        }
        let Some(header) = inner.header.clone() else {
            return Err(err(ErrorCode::VaultNotInitialized, "There is no vault yet. Create one first."));
        };
        let generation = self.generation();
        self.set_state(VaultState::Unlocking);

        // Slow down guessing in a running app. The real protection against offline guessing is
        // the KDF; this only limits an unattended, unlocked desktop session being brute-forced
        // through the UI.
        let failures = self.failed_unlocks.load(Ordering::Relaxed);
        if failures >= 3 {
            let delay = Duration::from_millis(250u64 << (failures - 3).min(5));
            tokio::time::sleep(delay.min(Duration::from_secs(8))).await;
        }

        let result = async {
            let header_for_kdf = header.clone();
            let keys = tokio::task::spawn_blocking(move || open_header(&header_for_kdf))
                .await
                .map_err(|_| internal())?
                .map_err(from_vault)?;
            let rows = self.db.list_records().await.map_err(from_storage)?;
            Self::load_records(keys, rows)
        }
        .await;

        match result {
            Ok(open) if self.generation() == generation => {
                self.failed_unlocks.store(0, Ordering::Relaxed);
                inner.open = Some(open);
                self.set_state(VaultState::Unlocked);
                Ok(())
            }
            Ok(_stale) => {
                // Locked while unlocking: the keys are dropped here, never published.
                self.set_state(VaultState::Locked);
                Err(err(ErrorCode::Cancelled, "The vault was locked while it was being unlocked."))
            }
            Err(e) => {
                if e.code == ErrorCode::WrongCredential {
                    self.failed_unlocks.fetch_add(1, Ordering::Relaxed);
                }
                self.set_state(VaultState::Locked);
                Err(e)
            }
        }
    }

    /// Decrypts every row. Any authentication failure fails the whole unlock: a vault is opened
    /// completely or not at all, never with a silently missing or substituted record (INV-11).
    fn load_records(keys: UnlockedVault, rows: Vec<RecordRow>) -> Result<Open, IpcError> {
        let mut open = Open::new(keys);
        let damaged = || {
            err(
                ErrorCode::VaultDamaged,
                "The vault failed an integrity check and was not opened. Restore it from a backup.",
            )
        };
        for row in rows {
            let ctx = RecordContext { record_id: row.record_id, kind: row.kind, revision: row.revision };
            let sealed = SealedRecord { key_version: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext };
            let payload = open.keys.open(&ctx, &sealed).map_err(from_vault)?;
            macro_rules! load {
                ($ty:ty, $map:expr) => {
                    match decode::<$ty>(&payload)? {
                        Decoded::Live(record) if !row.deleted => {
                            $map.insert(row.record_id, Stored { revision: row.revision, record });
                        }
                        Decoded::Tombstone if row.deleted => {}
                        // The cleartext hint disagrees with the authenticated marker.
                        _ => return Err(damaged()),
                    }
                };
            }
            match row.kind {
                KIND_HOST => load!(HostRecord, open.hosts),
                KIND_KEY => load!(KeyRecord, open.ssh_keys),
                KIND_KNOWN_HOST => load!(KnownHostRecord, open.known_hosts),
                KIND_SNIPPET => load!(SnippetRecord, open.snippets),
                KIND_GROUP => load!(GroupRecord, open.groups),
                KIND_TRUST_EVENT => {
                    // Authenticated above; not needed in memory.
                }
                // A record kind from a newer build: refuse rather than ignore data we would
                // then silently fail to preserve.
                _ => {
                    return Err(err(
                        ErrorCode::VaultUnsupportedVersion,
                        "This vault contains items from a newer version of Tyrminal. Update the application to open it.",
                    ));
                }
            }
        }
        Ok(open)
    }

    // ---------- quick unlock (device slot + OS secret store) ----------

    fn quick_account(vault_id: &Id) -> String {
        format!("quick-unlock-{}", validate::id_text(vault_id))
    }

    /// Runs a secret-store call off the async reactor (Secret Service and Keychain can block).
    async fn store_call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn SecretStore) -> Result<T, KeystoreError> + Send + 'static,
    ) -> Result<T, IpcError> {
        let store = std::sync::Arc::clone(&self.secret_store);
        tokio::task::spawn_blocking(move || f(store.as_ref())).await.map_err(|_| internal())?.map_err(|_| {
            err(
                ErrorCode::SecretStoreUnavailable,
                "The system keychain is not available, so quick unlock cannot be used. Use your passphrase.",
            )
        })
    }

    /// The stored entry: device slot id (16 bytes) then the device secret (32 bytes).
    fn parse_entry(bytes: &[u8]) -> Option<(Id, SecretKey)> {
        let id: Id = bytes.get(..16)?.try_into().ok()?;
        let secret: [u8; 32] = bytes.get(16..48)?.try_into().ok()?;
        (bytes.len() == 48).then(|| (id, SecretKey::from_bytes(secret)))
    }

    /// Whether this device can unlock without the passphrase: the vault has the device slot
    /// named by this device's keychain entry. Works while locked; never reveals the secret.
    pub async fn quick_unlock_enabled(&self) -> Result<bool, IpcError> {
        let header = {
            let mut inner = self.inner.lock().await;
            self.ensure_loaded(&mut inner).await?;
            match inner.header.clone() {
                Some(header) => header,
                None => return Ok(false),
            }
        };
        let account = Self::quick_account(&header.vault_id());
        let Ok(entry) = self.store_call(move |s| s.get(&account)).await else { return Ok(false) };
        Ok(entry.and_then(|e| Self::parse_entry(&e)).is_some_and(|(id, _)| header.device_slot_ids().contains(&id)))
    }

    /// Turns on quick unlock for this device after re-checking the passphrase with a real unlock.
    /// The keychain entry is written first; if the vault header then cannot be written, the
    /// entry is removed again. Any earlier slot of this device is replaced.
    pub async fn enable_quick_unlock(&self, passphrase: String) -> Result<(), IpcError> {
        let passphrase = Passphrase::new(passphrase);
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        if inner.open.is_none() {
            return Err(locked());
        }
        let header = inner.header.clone().ok_or_else(locked)?;
        let check = header.clone();
        tokio::task::spawn_blocking(move || check.unlock(&Credential::Passphrase(&passphrase)).map(drop))
            .await
            .map_err(|_| internal())?
            .map_err(from_vault)?;
        let account = Self::quick_account(&header.vault_id());
        let previous = {
            let account = account.clone();
            self.store_call(move |s| s.get(&account)).await?
        };
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut next = header.clone();
        if let Some((old_id, _)) = previous.as_deref().and_then(|e| Self::parse_entry(e))
            && next.device_slot_ids().contains(&old_id)
        {
            next = open.keys.remove_device_slot(&next, &old_id).map_err(from_vault)?;
        }
        let secret = SecretKey::generate().map_err(from_vault)?;
        let (next, slot_id) = open.keys.add_device_slot(&next, &secret).map_err(from_vault)?;
        let mut entry = Zeroizing::new(Vec::with_capacity(48));
        entry.extend_from_slice(&slot_id);
        entry.extend_from_slice(secret.expose());
        {
            let account = account.clone();
            self.store_call(move |s| s.set(&account, &entry)).await?;
        }
        if let Err(e) = self.db.replace_header(header.encode(), next.encode()).await.map_err(from_storage) {
            let _ = self.store_call(move |s| s.delete(&account)).await;
            return Err(e);
        }
        inner.header = Some(next);
        Ok(())
    }

    /// Turns quick unlock off: removes this device's slot from the vault, then its keychain entry.
    /// If the keychain cannot be read, every device slot is removed (the safe direction).
    pub async fn disable_quick_unlock(&self) -> Result<(), IpcError> {
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let header = inner.header.clone().ok_or_else(locked)?;
        let account = Self::quick_account(&header.vault_id());
        let entry = {
            let account = account.clone();
            self.store_call(move |s| s.get(&account)).await
        };
        let ids = match entry.ok().flatten().as_deref().and_then(|e| Self::parse_entry(e)) {
            Some((id, _)) if header.device_slot_ids().contains(&id) => vec![id],
            _ => header.device_slot_ids(),
        };
        let mut next = header.clone();
        for id in &ids {
            next = open.keys.remove_device_slot(&next, id).map_err(from_vault)?;
        }
        if !ids.is_empty() {
            self.db.replace_header(header.encode(), next.encode()).await.map_err(from_storage)?;
            inner.header = Some(next);
        }
        // The slot is gone, so a leftover entry could no longer open anything.
        let _ = self.store_call(move |s| s.delete(&account)).await;
        Ok(())
    }

    /// Unlocks with this device's keychain entry. A store that is unavailable, or an entry whose
    /// slot no longer exists, fails: the passphrase is the way in, never a weaker fallback.
    pub async fn unlock_with_device(&self) -> Result<(), IpcError> {
        let header = {
            let mut inner = self.inner.lock().await;
            self.ensure_loaded(&mut inner).await?;
            inner
                .header
                .clone()
                .ok_or_else(|| err(ErrorCode::VaultNotInitialized, "There is no vault yet. Create one first."))?
        };
        let account = Self::quick_account(&header.vault_id());
        let entry = {
            let account = account.clone();
            self.store_call(move |s| s.get(&account)).await?
        };
        let not_set_up =
            || err(ErrorCode::WrongCredential, "Quick unlock is not set up on this device. Use your passphrase.");
        let (slot_id, secret) = entry.as_deref().and_then(|e| Self::parse_entry(e)).ok_or_else(not_set_up)?;
        if !header.device_slot_ids().contains(&slot_id) {
            let _ = self.store_call(move |s| s.delete(&account)).await;
            return Err(not_set_up());
        }
        self.unlock(move |h| h.unlock(&Credential::Device(&secret))).await
    }

    // ---------- backup and restore (docs/crypto-format.md §10) ----------

    /// A portable backup of the unlocked vault: the header and every live record envelope as
    /// stored, authenticated under `K_backup`. Nothing is decrypted to write it.
    pub async fn export_backup(&self) -> Result<Vec<u8>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let header = inner.header.as_ref().ok_or_else(locked)?;
        let rows = self.db.list_records().await.map_err(from_storage)?;
        let records: Vec<BackupRecord> = rows
            .into_iter()
            .filter(|row| !row.deleted)
            .map(|row| BackupRecord {
                record_id: row.record_id,
                kind: row.kind,
                revision: row.revision,
                sealed: SealedRecord { key_version: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext },
            })
            .collect();
        open.keys.encode_backup(header, now_unix(), &records).map_err(from_vault)
    }

    /// Fully validates a backup with the secret it was made with: strict parse, unlock of its own
    /// header (Argon2id, off the reactor), header and backup MACs, then every record opened and
    /// decoded exactly as an unlock would. Nothing is written.
    async fn open_backup(
        bytes: Vec<u8>,
        kind: BackupCredentialKind,
        secret: String,
    ) -> Result<(ParsedBackup, BackupPreview), IpcError> {
        if bytes.len() > MAX_BACKUP_LEN {
            return Err(err(ErrorCode::LimitExceeded, "The file is too large to be a Tyrminal backup."));
        }
        let secret = Zeroizing::new(secret);
        let (parsed, keys) = tokio::task::spawn_blocking(move || {
            let parsed = decode_backup(&bytes)?;
            let keys = match kind {
                BackupCredentialKind::Passphrase => {
                    parsed.header.unlock(&Credential::Passphrase(&Passphrase::new(secret.to_string())))?
                }
                BackupCredentialKind::RecoveryKey => {
                    parsed.header.unlock(&Credential::Recovery(&RecoveryKey::parse(&secret)?))?
                }
            };
            keys.verify_backup(&parsed)?;
            Ok::<_, tyrminal_vault::VaultError>((parsed, keys))
        })
        .await
        .map_err(|_| internal())?
        .map_err(from_backup)?;
        let rows = parsed
            .records
            .iter()
            .map(|r| RecordRow {
                record_id: r.record_id,
                kind: r.kind,
                revision: r.revision,
                key_version: r.sealed.key_version,
                nonce: r.sealed.nonce,
                ciphertext: r.sealed.ciphertext.clone(),
                deleted: false,
            })
            .collect();
        // A record that fails here was inside an authenticated backup; still report it as a bad
        // backup, never as damage to this device's vault.
        let open = Self::load_records(keys, rows).map_err(|e| {
            if e.code == ErrorCode::VaultDamaged { from_vault(tyrminal_vault::VaultError::BackupTampered) } else { e }
        })?;
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        let preview = BackupPreview {
            created_at: parsed.created_at,
            hosts: count(open.hosts.len()),
            keys: count(open.ssh_keys.len()),
            known_hosts: count(open.known_hosts.len()),
            snippets: count(open.snippets.len()),
        };
        Ok((parsed, preview))
    }

    /// What a backup contains, after full validation. Changes nothing.
    pub async fn preview_backup(
        &self,
        bytes: Vec<u8>,
        kind: BackupCredentialKind,
        secret: String,
    ) -> Result<BackupPreview, IpcError> {
        // One KDF at a time, like unlock.
        let _serial = self.inner.try_lock().map_err(|_| busy())?;
        Self::open_backup(bytes, kind, secret).await.map(|(_, preview)| preview)
    }

    /// Replaces this device's vault with a validated backup, in one transaction, and leaves it
    /// locked: it then opens with the backup's passphrase or recovery key. Ends every session
    /// first. An existing vault is replaced only when `replace_existing` is set.
    pub async fn restore_backup(
        &self,
        bytes: Vec<u8>,
        kind: BackupCredentialKind,
        secret: String,
        replace_existing: bool,
    ) -> Result<BackupPreview, IpcError> {
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        self.ensure_loaded(&mut inner).await?;
        if inner.header.is_some() && !replace_existing {
            return Err(err(ErrorCode::VaultAlreadyExists, "A vault already exists here. It was not replaced."));
        }
        let (parsed, preview) = Self::open_backup(bytes, kind, secret).await?;
        // From here on the old vault's keys and sessions must not outlive the replacement.
        self.generation.fetch_add(1, Ordering::AcqRel);
        inner.open = None;
        let expected = inner.header.as_ref().map(VaultHeader::encode);
        let rows = parsed
            .records
            .into_iter()
            .map(|r| RecordRow {
                record_id: r.record_id,
                kind: r.kind,
                revision: r.revision,
                key_version: r.sealed.key_version,
                nonce: r.sealed.nonce,
                ciphertext: r.sealed.ciphertext,
                deleted: false,
            })
            .collect();
        let result = self.db.replace_vault(expected, parsed.header.encode(), rows).await.map_err(from_storage);
        // Whatever happened, the vault is locked now; on failure the old vault is untouched.
        if result.is_ok() {
            inner.header = Some(parsed.header);
        }
        let state = if inner.header.is_some() { VaultState::Locked } else { VaultState::Uninitialized };
        self.set_state(state);
        self.failed_unlocks.store(0, Ordering::Relaxed);
        result.map(|()| preview)
    }

    /// Locks the vault: bumps the generation (ending sessions and invalidating handles), then
    /// drops the keys and every decrypted record. Idempotent.
    pub async fn lock(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if self.status.borrow().state == VaultState::Uninitialized {
            return;
        }
        // Publishing the new generation first lets sessions start closing before the mutex is
        // available (an unlock in progress holds it for the duration of the KDF).
        self.set_state(VaultState::Locking);
        let mut inner = self.inner.lock().await;
        inner.open = None;
        let state = if inner.loaded && inner.header.is_none() { VaultState::Uninitialized } else { VaultState::Locked };
        self.set_state(state);
    }

    /// Replaces the passphrase slot (a rewrap; records are untouched). The current passphrase is
    /// verified by a real unlock of the stored header, not by trusting the unlocked state.
    pub async fn change_passphrase(&self, current: String, new: String) -> Result<(), IpcError> {
        let (current, new) = (Passphrase::new(current), Passphrase::new(new));
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        if inner.open.is_none() {
            return Err(locked());
        }
        let header = inner.header.clone().ok_or_else(internal)?;
        let old_bytes = header.encode();
        let new_header = tokio::task::spawn_blocking(move || {
            let verified = header.unlock(&Credential::Passphrase(&current))?;
            verified.change_passphrase(&header, &new)
        })
        .await
        .map_err(|_| internal())?
        .map_err(from_vault)?;
        // Atomic swap: after a crash either the old or the new header is on disk, never a mix.
        self.db.replace_header(old_bytes, new_header.encode()).await.map_err(from_storage)?;
        inner.header = Some(new_header);
        Ok(())
    }

    /// Issues a new recovery key and invalidates the old one. Requires the passphrase again.
    pub async fn rotate_recovery_key(&self, passphrase: String) -> Result<RecoveryKeyIssued, IpcError> {
        let passphrase = Passphrase::new(passphrase);
        let mut inner = self.inner.try_lock().map_err(|_| busy())?;
        if inner.open.is_none() {
            return Err(locked());
        }
        let header = inner.header.clone().ok_or_else(internal)?;
        let old_bytes = header.encode();
        let (new_header, key) = tokio::task::spawn_blocking(move || {
            let verified = header.unlock(&Credential::Passphrase(&passphrase))?;
            verified.rotate_recovery_key(&header)
        })
        .await
        .map_err(|_| internal())?
        .map_err(from_vault)?;
        self.db.replace_header(old_bytes, new_header.encode()).await.map_err(from_storage)?;
        inner.header = Some(new_header);
        Ok(RecoveryKeyIssued { recovery_key: key.to_display_string().to_string() })
    }

    /// Encrypts one record (or a tombstone for `None`) into a row with its write condition.
    fn seal_row<T: Serialize>(
        &self,
        open: &Open,
        id: Id,
        kind: u16,
        revision: u64,
        record: Option<(&T, usize)>,
    ) -> Result<(RecordRow, WriteCondition), IpcError> {
        let payload = match record {
            Some((record, content_len)) => encode(record, content_len)?,
            None => tombstone(),
        };
        let ctx = RecordContext { record_id: id, kind, revision };
        let sealed = open.keys.seal(&ctx, &payload).map_err(from_vault)?;
        let row = RecordRow {
            record_id: id,
            kind,
            revision,
            key_version: sealed.key_version,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            deleted: record.is_none(),
        };
        let condition = if revision == 1 {
            WriteCondition::Create
        } else {
            WriteCondition::Replace { expected_revision: revision - 1 }
        };
        Ok((row, condition))
    }

    async fn write<T: Serialize>(
        &self,
        open: &Open,
        id: Id,
        kind: u16,
        revision: u64,
        record: Option<(&T, usize)>,
    ) -> Result<(), IpcError> {
        let (row, condition) = self.seal_row(open, id, kind, revision, record)?;
        self.db.put_record(row, condition).await.map_err(from_storage)
    }

    // ---------- hosts ----------

    pub async fn list_hosts(&self) -> Result<Vec<HostSummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        Ok(sorted_hosts(open, |_| true))
    }

    /// Hosts matching every term of `query` (see `inventory::Query`); all hosts for an empty one.
    pub async fn search_hosts(&self, query: &str) -> Result<Vec<HostSummary>, IpcError> {
        if query.len() > MAX_SEARCH_LEN {
            return Err(invalid("The search is too long."));
        }
        let query = Query::parse(query);
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        if query.is_empty() {
            return Ok(sorted_hosts(open, |_| true));
        }
        let groups = group_index(open);
        let mut paths: HashMap<Option<String>, String> = HashMap::new();
        Ok(sorted_hosts(open, |record| {
            let path = paths
                .entry(record.group.clone())
                .or_insert_with(|| inventory::group_path(&groups, record.group.as_deref()).to_lowercase());
            query.matches([&record.label, &record.address, &record.username], &record.tags, path)
        }))
    }

    pub async fn save_host(&self, input: HostInput) -> Result<HostSummary, IpcError> {
        let label = validate::label(&input.label)?;
        let address = validate::address(&input.address)?;
        let port = match input.port {
            Some(port) => validate::port(port)?,
            None => 0,
        };
        let username = if input.username.is_empty() { String::new() } else { validate::username(&input.username)? };
        let tags = validate::tags(&input.tags)?;
        let existing_id = input.id.as_deref().map(validate::id).transpose()?;
        let group = input.group_id.as_deref().map(validate::id).transpose()?;

        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if let Some(group) = &group
            && !open.groups.contains_key(group)
        {
            return Err(not_found("That group no longer exists. Choose another group."));
        }

        let auth = match input.auth {
            HostAuthInput::Inherit => StoredAuth::Inherit,
            HostAuthInput::AskPassword => StoredAuth::AskPassword,
            HostAuthInput::Key { key_id } => {
                // No dangling references: the key must exist now.
                if !open.ssh_keys.contains_key(&validate::id(&key_id)?) {
                    return Err(not_found("That key no longer exists. Choose another key."));
                }
                StoredAuth::Key { key_id }
            }
            HostAuthInput::StoredPassword { password: Some(password) } => {
                let password = Zeroizing::new(password);
                validate::secret(&password)?;
                StoredAuth::Password { password }
            }
            HostAuthInput::StoredPassword { password: None } => {
                // Keep the password that is already stored; the UI never receives it to resend.
                match existing_id.and_then(|id| open.hosts.get(&id)).map(|s| &s.record.auth) {
                    Some(StoredAuth::Password { password }) => {
                        StoredAuth::Password { password: Zeroizing::new(password.as_str().to_owned()) }
                    }
                    _ => return Err(invalid("Enter the password to store.")),
                }
            }
        };

        let (id, revision, last_connected_at) = match existing_id {
            Some(id) => {
                let current = open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?;
                (id, current.revision + 1, current.record.last_connected_at)
            }
            None => {
                if open.hosts.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of hosts."));
                }
                (random_id().map_err(from_vault)?, 1, None)
            }
        };
        let record = HostRecord {
            label,
            address,
            port,
            username,
            auth,
            group: group.map(|g| validate::id_text(&g)),
            tags,
            last_connected_at,
        };
        self.write(open, id, KIND_HOST, revision, Some((&record, host_content_len(&record)))).await?;
        let summary = host_summary(&group_index(open), &id, &record);
        open.hosts.insert(id, Stored { revision, record });
        Ok(summary)
    }

    /// A copy of a host (credentials included, never connected), labelled as a copy.
    pub async fn duplicate_host(&self, id: &str) -> Result<HostSummary, IpcError> {
        let source_id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if open.hosts.len() >= MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of hosts."));
        }
        let source = &open.hosts.get(&source_id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        let mut label = format!("{} (copy)", source.label);
        if label.len() > MAX_LABEL_LEN {
            label = source.label.clone();
        }
        let record = HostRecord { label, last_connected_at: None, ..copy_host(source) };
        let id = random_id().map_err(from_vault)?;
        self.write(open, id, KIND_HOST, 1, Some((&record, host_content_len(&record)))).await?;
        let summary = host_summary(&group_index(open), &id, &record);
        open.hosts.insert(id, Stored { revision: 1, record });
        Ok(summary)
    }

    pub async fn delete_host(&self, id: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision = open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.revision + 1;
        self.write::<HostRecord>(open, id, KIND_HOST, revision, None).await?;
        open.hosts.remove(&id);
        Ok(())
    }

    /// Applies one change to several hosts in a single transaction: all of them change, or none
    /// do. Returns how many hosts changed.
    pub async fn bulk_update_hosts(&self, ids: &[String], change: BulkHostChange) -> Result<u32, IpcError> {
        if ids.is_empty() {
            return Ok(0);
        }
        if ids.len() > MAX_BULK_HOSTS {
            return Err(err(ErrorCode::LimitExceeded, "Too many hosts for one change."));
        }
        let ids: Vec<Id> = ids.iter().map(|id| validate::id(id)).collect::<Result<_, _>>()?;
        let tag = match &change {
            BulkHostChange::AddTag { tag } | BulkHostChange::RemoveTag { tag } => {
                let tags = validate::tags(std::slice::from_ref(tag))?;
                Some(tags.into_iter().next().ok_or_else(|| invalid("Enter a tag."))?)
            }
            _ => None,
        };
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let target_group = match &change {
            BulkHostChange::MoveToGroup { group_id: Some(group) } => {
                let group = validate::id(group)?;
                if !open.groups.contains_key(&group) {
                    return Err(not_found("That group no longer exists."));
                }
                Some(validate::id_text(&group))
            }
            _ => None,
        };
        let mut writes: Vec<(Id, u64, Option<HostRecord>)> = Vec::with_capacity(ids.len());
        for id in &ids {
            let stored = open.hosts.get(id).ok_or_else(|| not_found("A selected host no longer exists."))?;
            let next = match &change {
                BulkHostChange::Delete => None,
                BulkHostChange::MoveToGroup { .. } => {
                    Some(HostRecord { group: target_group.clone(), ..copy_host(&stored.record) })
                }
                BulkHostChange::AddTag { .. } => {
                    let mut tags = stored.record.tags.clone();
                    tags.extend(tag.clone());
                    Some(HostRecord { tags: validate::tags(&tags)?, ..copy_host(&stored.record) })
                }
                BulkHostChange::RemoveTag { .. } => {
                    let remove = tag.as_deref().unwrap_or_default().to_lowercase();
                    let tags = stored.record.tags.iter().filter(|t| t.to_lowercase() != remove).cloned().collect();
                    Some(HostRecord { tags, ..copy_host(&stored.record) })
                }
            };
            writes.push((*id, stored.revision + 1, next));
        }
        let rows = writes
            .iter()
            .map(|(id, revision, record)| {
                self.seal_row(open, *id, KIND_HOST, *revision, record.as_ref().map(|r| (r, host_content_len(r))))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.db.put_records(rows).await.map_err(from_storage)?;
        let changed = writes.len() as u32;
        for (id, revision, record) in writes {
            match record {
                Some(record) => {
                    open.hosts.insert(id, Stored { revision, record });
                }
                None => {
                    open.hosts.remove(&id);
                }
            }
        }
        Ok(changed)
    }

    /// Hosts with a recorded connection, most recent first, at most `MAX_RECENT_HOSTS`.
    pub async fn recent_hosts(&self) -> Result<Vec<HostSummary>, IpcError> {
        let mut hosts: Vec<_> =
            self.list_hosts().await?.into_iter().filter(|h| h.last_connected_at.is_some()).collect();
        hosts.sort_by(|a, b| b.last_connected_at.cmp(&a.last_connected_at).then_with(|| a.id.cmp(&b.id)));
        hosts.truncate(MAX_RECENT_HOSTS);
        Ok(hosts)
    }

    /// Records that a session to `host_id` reached its shell. Written under the generation the
    /// session was opened with, so a session that outlived a lock cannot write.
    pub(crate) async fn mark_connected(&self, generation: u32, host_id: &str) -> Result<(), IpcError> {
        let id = validate::id(host_id)?;
        let mut inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let Some(stored) = open.hosts.get(&id) else {
            // Deleted while connecting: nothing to record.
            return Ok(());
        };
        let revision = stored.revision + 1;
        let record = HostRecord { last_connected_at: Some(now_unix()), ..copy_host(&stored.record) };
        self.write(open, id, KIND_HOST, revision, Some((&record, host_content_len(&record)))).await?;
        open.hosts.insert(id, Stored { revision, record });
        Ok(())
    }

    // ---------- import ----------

    /// Parses an import source into a preview. Nothing is written.
    pub async fn import_preview(&self, format: ImportFormat, text: &str) -> Result<ImportPreview, IpcError> {
        let parsed = match format {
            ImportFormat::OpensshConfig => import::parse_openssh(text)?,
            ImportFormat::Csv => import::parse_csv(text)?,
        };
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let existing: std::collections::HashSet<String> =
            open.hosts.values().map(|h| h.record.label.to_lowercase()).collect();
        let duplicates = parsed
            .hosts
            .iter()
            .filter(|h| existing.contains(&h.label.to_lowercase()))
            .map(|h| h.label.clone())
            .collect();
        Ok(ImportPreview { hosts: parsed.hosts, skipped: parsed.skipped, duplicates })
    }

    /// Creates the previewed hosts (and any missing groups on their paths, under `into_group`)
    /// in one transaction: every host is created, or none is. Values are validated again here;
    /// the preview came back through the renderer. Imported hosts ask for a password until a key
    /// is chosen for them.
    pub async fn import_hosts(&self, hosts: Vec<ImportHost>, into_group: Option<String>) -> Result<u32, IpcError> {
        if hosts.len() > MAX_IMPORT_HOSTS {
            return Err(err(ErrorCode::LimitExceeded, "Too many hosts for one import."));
        }
        let hosts = hosts.into_iter().map(import::revalidate).collect::<Result<Vec<_>, _>>()?;
        let into_group = into_group.as_deref().map(validate::id).transpose()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if let Some(group) = &into_group
            && !open.groups.contains_key(group)
        {
            return Err(not_found("That group no longer exists."));
        }
        if open.hosts.len() + hosts.len() > MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault cannot hold that many hosts."));
        }

        // Resolve every group path, creating the missing groups in this same transaction.
        let base = into_group.map(|g| validate::id_text(&g));
        let mut new_groups: Vec<(Id, GroupRecord)> = Vec::new();
        let mut resolved: HashMap<String, Option<String>> = HashMap::new();
        for host in &hosts {
            if resolved.contains_key(&host.group) {
                continue;
            }
            let mut parent = base.clone();
            for name in host.group.split('/').filter(|s| !s.is_empty()) {
                let existing = open
                    .groups
                    .iter()
                    .map(|(id, s)| (validate::id_text(id), &s.record))
                    .chain(new_groups.iter().map(|(id, r)| (validate::id_text(id), r)))
                    .find(|(_, g)| g.parent == parent && g.name.eq_ignore_ascii_case(name))
                    .map(|(id, _)| id);
                parent = Some(match existing {
                    Some(id) => id,
                    None => {
                        let id = random_id().map_err(from_vault)?;
                        new_groups.push((
                            id,
                            GroupRecord {
                                name: name.to_owned(),
                                parent: parent.clone(),
                                username: None,
                                port: None,
                                key_id: None,
                            },
                        ));
                        validate::id_text(&id)
                    }
                });
            }
            resolved.insert(host.group.clone(), parent);
        }
        if open.groups.len() + new_groups.len() > MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault cannot hold that many groups."));
        }
        {
            // Depth check against the combined tree.
            let mut groups = group_index(open);
            let texts: Vec<(String, &GroupRecord)> =
                new_groups.iter().map(|(id, r)| (validate::id_text(id), r)).collect();
            for (id, record) in &texts {
                groups.insert(id.clone(), record);
            }
            if texts.iter().any(|(id, _)| inventory::depth(&groups, id) > tyrminal_contracts::limits::MAX_GROUP_DEPTH) {
                return Err(invalid("Groups can be nested 16 levels deep at most."));
            }
        }

        let mut new_hosts: Vec<(Id, HostRecord)> = Vec::with_capacity(hosts.len());
        for host in hosts {
            let group = resolved.get(&host.group).cloned().flatten();
            let record = HostRecord {
                label: host.label,
                address: host.address,
                port: host.port,
                username: host.username,
                auth: StoredAuth::AskPassword,
                group,
                tags: host.tags,
                last_connected_at: None,
            };
            new_hosts.push((random_id().map_err(from_vault)?, record));
        }
        let mut rows = Vec::with_capacity(new_groups.len() + new_hosts.len());
        for (id, record) in &new_groups {
            rows.push(self.seal_row(open, *id, KIND_GROUP, 1, Some((record, group_content_len(record))))?);
        }
        for (id, record) in &new_hosts {
            rows.push(self.seal_row(open, *id, KIND_HOST, 1, Some((record, host_content_len(record))))?);
        }
        self.db.put_records(rows).await.map_err(from_storage)?;
        let created = new_hosts.len() as u32;
        for (id, record) in new_groups {
            open.groups.insert(id, Stored { revision: 1, record });
        }
        for (id, record) in new_hosts {
            open.hosts.insert(id, Stored { revision: 1, record });
        }
        Ok(created)
    }

    // ---------- groups ----------

    pub async fn list_groups(&self) -> Result<Vec<GroupSummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let groups = group_index(open);
        let mut list: Vec<(String, GroupSummary)> = open
            .groups
            .iter()
            .map(|(id, s)| {
                let id_text = validate::id_text(id);
                let path = inventory::group_path(&groups, Some(&id_text)).to_lowercase();
                (path, group_summary(id, &s.record))
            })
            .collect();
        list.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
        Ok(list.into_iter().map(|(_, g)| g).collect())
    }

    pub async fn save_group(&self, input: GroupInput) -> Result<GroupSummary, IpcError> {
        let name = validate::label(&input.name)?;
        if name.contains('/') {
            return Err(invalid("Group names cannot contain \"/\"."));
        }
        let username = input.username.as_deref().filter(|u| !u.is_empty()).map(validate::username).transpose()?;
        let port = input.port.map(validate::port).transpose()?;
        let existing_id = input.id.as_deref().map(validate::id).transpose()?;
        let parent = input.parent_id.as_deref().map(validate::id).transpose()?;
        let key_id = input.key_id.as_deref().map(validate::id).transpose()?;

        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if let Some(key_id) = &key_id
            && !open.ssh_keys.contains_key(key_id)
        {
            return Err(not_found("That key no longer exists. Choose another key."));
        }
        let parent_text = parent.map(|p| validate::id_text(&p));
        let id_text = existing_id.map(|id| validate::id_text(&id));
        {
            let groups = group_index(open);
            inventory::check_placement(&groups, id_text.as_deref(), parent_text.as_deref()).map_err(|e| match e {
                TreeError::MissingParent => not_found("The parent group no longer exists."),
                TreeError::Cycle => invalid("A group cannot be placed inside itself or one of its subgroups."),
                TreeError::TooDeep => invalid("Groups can be nested 16 levels deep at most."),
            })?;
        }
        let (id, revision) = match existing_id {
            Some(id) => {
                let current = open.groups.get(&id).ok_or_else(|| not_found("That group no longer exists."))?;
                (id, current.revision + 1)
            }
            None => {
                if open.groups.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of groups."));
                }
                (random_id().map_err(from_vault)?, 1)
            }
        };
        let record =
            GroupRecord { name, parent: parent_text, username, port, key_id: key_id.map(|k| validate::id_text(&k)) };
        self.write(open, id, KIND_GROUP, revision, Some((&record, group_content_len(&record)))).await?;
        let summary = group_summary(&id, &record);
        open.groups.insert(id, Stored { revision, record });
        Ok(summary)
    }

    /// Deletes an empty group. Refused while hosts or subgroups are in it: nothing changes its
    /// effective settings or loses its place silently.
    pub async fn delete_group(&self, id: &str) -> Result<(), IpcError> {
        let group_id = validate::id(id)?;
        let id_text = validate::id_text(&group_id);
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision =
            open.groups.get(&group_id).ok_or_else(|| not_found("That group no longer exists."))?.revision + 1;
        if open.hosts.values().any(|h| h.record.group.as_deref() == Some(id_text.as_str()))
            || open.groups.values().any(|g| g.record.parent.as_deref() == Some(id_text.as_str()))
        {
            return Err(err(ErrorCode::InUse, "The group is not empty. Move its hosts and subgroups first."));
        }
        self.write::<GroupRecord>(open, group_id, KIND_GROUP, revision, None).await?;
        open.groups.remove(&group_id);
        Ok(())
    }

    // ---------- snippets ----------

    pub async fn list_snippets(&self) -> Result<Vec<SnippetSummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<_> = open.snippets.iter().map(|(id, s)| snippet_summary(id, &s.record)).collect();
        list.sort_by(|a, b| {
            (a.folder.to_lowercase(), a.name.to_lowercase(), &a.id).cmp(&(
                b.folder.to_lowercase(),
                b.name.to_lowercase(),
                &b.id,
            ))
        });
        Ok(list)
    }

    pub async fn save_snippet(&self, input: SnippetInput) -> Result<SnippetSummary, IpcError> {
        let name = validate::label(&input.name)?;
        let folder = validate::folder(&input.folder)?;
        let text = validate::snippet_text(&input.text)?;
        let existing_id = input.id.as_deref().map(validate::id).transpose()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let (id, revision) = match existing_id {
            Some(id) => {
                let current = open.snippets.get(&id).ok_or_else(|| not_found("That snippet no longer exists."))?;
                (id, current.revision + 1)
            }
            None => {
                if open.snippets.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of snippets."));
                }
                (random_id().map_err(from_vault)?, 1)
            }
        };
        let record = SnippetRecord { name, folder, text, updated_at: now_unix() };
        let content_len = record.name.len() + record.folder.len() + record.text.len();
        self.write(open, id, KIND_SNIPPET, revision, Some((&record, content_len))).await?;
        let summary = snippet_summary(&id, &record);
        open.snippets.insert(id, Stored { revision, record });
        Ok(summary)
    }

    pub async fn delete_snippet(&self, id: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision = open.snippets.get(&id).ok_or_else(|| not_found("That snippet no longer exists."))?.revision + 1;
        self.write::<SnippetRecord>(open, id, KIND_SNIPPET, revision, None).await?;
        open.snippets.remove(&id);
        Ok(())
    }

    /// The text of a snippet, read under `generation`: after a lock nothing is returned.
    pub(crate) async fn snippet_text(&self, generation: u32, id: &str) -> Result<Zeroizing<String>, IpcError> {
        let id = validate::id(id)?;
        let inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let stored = open.snippets.get(&id).ok_or_else(|| not_found("That snippet no longer exists."))?;
        Ok(Zeroizing::new(stored.record.text.clone()))
    }

    // ---------- keys ----------

    fn key_summary(open: &Open, id: &Id, record: &KeyRecord) -> KeySummary {
        let id_text = validate::id_text(id);
        let used_by = open
            .hosts
            .values()
            .filter(|h| matches!(&h.record.auth, StoredAuth::Key { key_id } if *key_id == id_text))
            .count() as u32;
        KeySummary {
            id: id_text,
            label: record.label.clone(),
            algorithm: record.algorithm.clone(),
            fingerprint: record.fingerprint.clone(),
            public_key: format!("{} {}", record.public_key, record.label.replace(char::is_whitespace, "-")),
            passphrase_protected: record.passphrase_protected,
            passphrase_stored: record.passphrase.is_some(),
            used_by,
        }
    }

    pub async fn list_keys(&self) -> Result<Vec<KeySummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut keys: Vec<_> = open.ssh_keys.iter().map(|(id, s)| Self::key_summary(open, id, &s.record)).collect();
        keys.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        Ok(keys)
    }

    /// The OpenSSH public-key line of a key, read under `generation` (nothing after a lock).
    pub(crate) async fn public_key_line(&self, generation: u32, key_id: &str) -> Result<String, IpcError> {
        let id = validate::id(key_id)?;
        let inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let key = open.ssh_keys.get(&id).ok_or_else(|| not_found("That key no longer exists."))?;
        // The same line the keychain shows: the label (spaces replaced) as the comment.
        Ok(format!("{} {}", key.record.public_key, key.record.label.replace(char::is_whitespace, "-")))
    }

    async fn store_key(&self, record: KeyRecord) -> Result<KeySummary, IpcError> {
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if open.ssh_keys.len() >= MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of keys."));
        }
        if open.ssh_keys.values().any(|k| k.record.fingerprint == record.fingerprint) {
            return Err(err(ErrorCode::Conflict, "This key is already in the keychain."));
        }
        let id = random_id().map_err(from_vault)?;
        let content_len = record.label.len()
            + record.private_key.len()
            + record.passphrase.as_ref().map_or(0, |p| p.len())
            + record.algorithm.len()
            + record.fingerprint.len()
            + record.public_key.len();
        self.write(open, id, KIND_KEY, 1, Some((&record, content_len))).await?;
        open.ssh_keys.insert(id, Stored { revision: 1, record });
        let stored = open.ssh_keys.get(&id).ok_or_else(internal)?;
        Ok(Self::key_summary(open, &id, &stored.record))
    }

    /// Imports a pasted private key. The key is parsed (and decrypted, if encrypted) to prove it
    /// is usable before anything is stored.
    pub async fn import_key(&self, input: KeyImportInput) -> Result<KeySummary, IpcError> {
        let label = validate::label(&input.label)?;
        let private_key = Zeroizing::new(input.private_key);
        let passphrase = input.passphrase.map(Zeroizing::new).filter(|p| !p.is_empty());
        if let Some(p) = &passphrase {
            validate::secret(p)?;
        }
        let protected = ClientKey::is_passphrase_protected(&private_key);
        let parsed =
            ClientKey::from_openssh(&private_key, passphrase.as_deref().map(String::as_str)).map_err(from_key)?;
        let record = KeyRecord {
            label,
            private_key,
            passphrase: passphrase.filter(|_| protected && input.remember_passphrase),
            passphrase_protected: protected,
            algorithm: parsed.algorithm(),
            fingerprint: parsed.fingerprint(),
            public_key: parsed.public_key_openssh().map_err(from_key)?,
        };
        self.store_key(record).await
    }

    /// Generates a new Ed25519 key inside the vault.
    pub async fn generate_key(&self, label: &str) -> Result<KeySummary, IpcError> {
        let label = validate::label(label)?;
        let key = ClientKey::generate_ed25519().map_err(from_key)?;
        let record = KeyRecord {
            label,
            private_key: key.to_openssh().map_err(from_key)?,
            passphrase: None,
            passphrase_protected: false,
            algorithm: key.algorithm(),
            fingerprint: key.fingerprint(),
            public_key: key.public_key_openssh().map_err(from_key)?,
        };
        self.store_key(record).await
    }

    /// Deletes a key. Refused while any host still uses it: a host never silently falls back to
    /// a different credential.
    pub async fn delete_key(&self, id: &str) -> Result<(), IpcError> {
        let key_id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision = open.ssh_keys.get(&key_id).ok_or_else(|| not_found("That key no longer exists."))?.revision + 1;
        let key_text = validate::id_text(&key_id);
        if open.hosts.values().any(|h| matches!(&h.record.auth, StoredAuth::Key { key_id } if *key_id == key_text)) {
            return Err(err(ErrorCode::InUse, "Hosts still use this key. Change their sign-in method first."));
        }
        if open.groups.values().any(|g| g.record.key_id.as_deref() == Some(key_text.as_str())) {
            return Err(err(ErrorCode::InUse, "Groups still use this key. Change their default key first."));
        }
        self.write::<KeyRecord>(open, key_id, KIND_KEY, revision, None).await?;
        open.ssh_keys.remove(&key_id);
        Ok(())
    }

    // ---------- known hosts ----------

    pub async fn list_known_hosts(&self) -> Result<Vec<KnownHostSummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<_> = open
            .known_hosts
            .iter()
            .map(|(id, s)| KnownHostSummary {
                id: validate::id_text(id),
                host: s.record.host.clone(),
                port: s.record.port,
                algorithm: s.record.algorithm.clone(),
                fingerprint: s.record.fingerprint.clone(),
                added_at: s.record.added_at,
            })
            .collect();
        list.sort_by(|a, b| (a.host.as_str(), a.port, a.id.as_str()).cmp(&(b.host.as_str(), b.port, b.id.as_str())));
        Ok(list)
    }

    /// Persists trust for a key the user accepted with "always". `generation` is the generation
    /// the asking session was created under: a session that outlived a lock cannot write.
    pub(crate) async fn add_known_host(
        &self,
        generation: u32,
        endpoint: &Endpoint,
        key: &PresentedHostKey,
    ) -> Result<(), IpcError> {
        let mut inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let (host, port) = endpoint.canonical();
        if open
            .known_hosts
            .values()
            .any(|k| k.record.host == host && k.record.port == port && k.record.public_key == key.public_key)
        {
            return Ok(());
        }
        if open.known_hosts.len() >= MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of known hosts."));
        }
        let record = KnownHostRecord {
            host,
            port,
            public_key: key.public_key.clone(),
            algorithm: key.algorithm.clone(),
            fingerprint: key.fingerprint.clone(),
            added_at: now_unix(),
        };
        let id = random_id().map_err(from_vault)?;
        let content_len =
            record.host.len() + record.public_key.len() + record.algorithm.len() + record.fingerprint.len();
        self.write(open, id, KIND_KNOWN_HOST, 1, Some((&record, content_len))).await?;
        open.known_hosts.insert(id, Stored { revision: 1, record });
        Ok(())
    }

    /// The explicit replace-trust step: removes a trusted key and records why. The next
    /// connection to that endpoint is a first-use prompt again; trust is never replaced silently.
    pub async fn remove_known_host(&self, id: &str, reason: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        let reason = validate::reason(reason)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let stored = open.known_hosts.get(&id).ok_or_else(|| not_found("That known host no longer exists."))?;
        let revision = stored.revision + 1;
        let event = TrustEventRecord {
            host: stored.record.host.clone(),
            port: stored.record.port,
            removed_fingerprint: stored.record.fingerprint.clone(),
            reason,
            at: now_unix(),
        };
        let event_id = random_id().map_err(from_vault)?;
        let content_len = event.host.len() + event.removed_fingerprint.len() + event.reason.len();
        // The note is written first: trust is never removed without its reason on record.
        self.write(open, event_id, KIND_TRUST_EVENT, 1, Some((&event, content_len))).await?;
        self.write::<KnownHostRecord>(open, id, KIND_KNOWN_HOST, revision, None).await?;
        open.known_hosts.remove(&id);
        Ok(())
    }

    // ---------- sessions ----------

    /// Snapshot of what a session needs, taken under the mutex at one generation. Later edits to
    /// the host do not retarget a session that is already connecting or connected.
    pub(crate) async fn connection_plan(&self, host_id: &str) -> Result<ConnectionPlan, IpcError> {
        let id = validate::id(host_id)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        let groups = group_index(open);
        let effective = inventory::effective(&groups, host);
        if effective.username.is_empty() {
            return Err(invalid("Set a user name on this host or one of its groups."));
        }
        let key_plan = |key_id: &str| -> Result<PlanAuth, IpcError> {
            let key = open.ssh_keys.get(&validate::id(key_id)?).ok_or_else(|| {
                not_found("The key this host uses no longer exists. Edit the host or its group to choose another.")
            })?;
            Ok(PlanAuth::Key {
                private_key: Zeroizing::new(key.record.private_key.as_str().to_owned()),
                passphrase: key.record.passphrase.as_ref().map(|p| Zeroizing::new(p.as_str().to_owned())),
            })
        };
        let auth = match &effective.auth {
            EffectiveAuth::Own(StoredAuth::Password { password }) => {
                PlanAuth::Password(Zeroizing::new(password.as_str().to_owned()))
            }
            EffectiveAuth::Own(StoredAuth::Key { key_id }) => key_plan(key_id)?,
            EffectiveAuth::GroupKey(key_id) => key_plan(key_id)?,
            EffectiveAuth::Own(StoredAuth::AskPassword | StoredAuth::Inherit) | EffectiveAuth::Ask => PlanAuth::Ask,
        };
        let known_hosts = open
            .known_hosts
            .values()
            .map(|k| {
                let known = KnownHost {
                    host: k.record.host.clone(),
                    port: k.record.port,
                    public_key: k.record.public_key.clone(),
                };
                (known, k.record.fingerprint.clone())
            })
            .collect();
        Ok(ConnectionPlan {
            host_id: validate::id_text(&id),
            endpoint: Endpoint::new(host.address.clone(), effective.port),
            username: effective.username.clone(),
            auth,
            known_hosts,
            generation: self.generation(),
        })
    }

    /// Fails unless the vault is unlocked; returns the generation for handle binding.
    pub(crate) async fn require_unlocked(&self) -> Result<u32, IpcError> {
        let inner = self.inner.lock().await;
        if inner.open.is_none() {
            return Err(locked());
        }
        Ok(self.generation())
    }
}

#[cfg(test)]
mod suspend_tests {
    use super::*;

    #[test]
    fn a_wall_clock_gap_means_the_machine_slept() {
        let s = Duration::from_secs;
        assert!(!slept_between(s(5), s(5)));
        assert!(!slept_between(s(34), s(5)), "small drift or NTP slew is not sleep");
        assert!(slept_between(s(35), s(5)));
        assert!(slept_between(s(7200), s(5)));
        assert!(!slept_between(Duration::ZERO, s(5)), "a clock set backwards is not sleep");
    }
}

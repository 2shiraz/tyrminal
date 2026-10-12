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
// agent B: tunnels and history
use crate::records::{KIND_TUNNEL, TunnelRecord};
use tyrminal_contracts::{ChainHop, HostConnection, HostConnectionInput, TunnelInput, TunnelSummary};
// agent D: inventory and snippets
use crate::records::{
    ExecutionTargetRecord, HostAppearanceRecord, IdentityRecord, KIND_EXECUTION_TARGET, KIND_HOST_APPEARANCE,
    KIND_IDENTITY, KIND_KEY_CERTIFICATE, KIND_WORKFLOW, KeyCertificateRecord, StoredEnv, WorkflowRecord,
};
use tyrminal_contracts::{
    EffectiveEnvVar, EnvVar, ExecutionTarget, ExecutionTargetInput, HostAppearance, HostOs, IdentityAssignment,
    IdentityInput, IdentitySummary, KeyCertificate, KeyKind, KnownHostImportEntry, KnownHostImportPreview,
    KnownHostImportStatus, SecretChange, SettingOrigin, SettingsTarget,
};

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
    // agent B: tunnels and history
    tunnels: BTreeMap<Id, Stored<TunnelRecord>>,
    // agent D: inventory and snippets
    appearances: BTreeMap<Id, Stored<HostAppearanceRecord>>,
    certificates: BTreeMap<Id, Stored<KeyCertificateRecord>>,
    targets: BTreeMap<Id, Stored<ExecutionTargetRecord>>,
    identities: BTreeMap<Id, Stored<IdentityRecord>>,
    workflows: BTreeMap<Id, Stored<WorkflowRecord>>,
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
            // agent B: tunnels and history
            tunnels: BTreeMap::new(),
            // agent D: inventory and snippets
            appearances: BTreeMap::new(),
            certificates: BTreeMap::new(),
            targets: BTreeMap::new(),
            identities: BTreeMap::new(),
            workflows: BTreeMap::new(),
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
    // agent B: tunnels and history
    /// Jump hosts to go through first, first hop first; empty for a direct connection.
    pub jumps: Vec<HopPlan>,
    /// The host's own proxy, used when it is reached directly (no jump host).
    pub proxy: Option<tyrminal_ssh::ProxySpec>,
    /// The host's saved label.
    pub label: String,
    /// Trusted keys with their display fingerprints.
    pub known_hosts: Vec<(KnownHost, String)>,
    /// Environment variables to request for the shell (the host's own, with inherited ones).
    pub env: Vec<(String, Zeroizing<String>)>,
    pub generation: u32,
}

// agent B: tunnels and history
/// One host of a connection chain.
pub(crate) struct HopPlan {
    /// The host's saved label, shown in prompts as the hop's name.
    pub label: String,
    pub endpoint: Endpoint,
    pub username: String,
    pub auth: PlanAuth,
    /// How to leave this computer when this host is the first hop.
    pub proxy: Option<tyrminal_ssh::ProxySpec>,
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
        protocol: record.protocol.clone(),
        terminal: record.terminal,
        forward_agent: record.forward_agent,
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

/// Where a host is reached (see `VaultService::host_endpoint`).
pub(crate) struct HostEndpoint {
    pub protocol: tyrminal_contracts::HostProtocol,
    pub terminal: tyrminal_contracts::HostTerminal,
    pub forward_agent: bool,
    pub address: String,
    pub port: u16,
    pub generation: u32,
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
        protocol: record.protocol.clone(),
        terminal: record.terminal,
        forward_agent: record.forward_agent,
        // agent B: tunnels and history
        connection: record.connection.clone(),
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
        + match &record.protocol {
            tyrminal_contracts::HostProtocol::Serial { settings } => settings.path.len() + 64,
            _ => 0,
        }
        // agent B: tunnels and history
        + record.connection.content_len()
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
                // agent B: tunnels and history
                KIND_TUNNEL => load!(TunnelRecord, open.tunnels),
                // agent D: inventory and snippets
                KIND_HOST_APPEARANCE => load!(HostAppearanceRecord, open.appearances),
                KIND_KEY_CERTIFICATE => load!(KeyCertificateRecord, open.certificates),
                KIND_EXECUTION_TARGET => load!(ExecutionTargetRecord, open.targets),
                KIND_IDENTITY => load!(IdentityRecord, open.identities),
                KIND_WORKFLOW => load!(WorkflowRecord, open.workflows),
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
        let protocol = validate::protocol(input.protocol)?;

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
        // agent B: tunnels and history: connection settings are saved on their own and kept here.
        let connection =
            existing_id.and_then(|id| open.hosts.get(&id)).map(|s| s.record.connection.clone()).unwrap_or_default();
        let record = HostRecord {
            label,
            address,
            port,
            username,
            auth,
            group: group.map(|g| validate::id_text(&g)),
            tags,
            last_connected_at,
            protocol,
            terminal: input.terminal,
            forward_agent: input.forward_agent,
            connection,
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
        // agent D: the copy keeps the source's appearance, written in the same transaction.
        let appearance = Self::appearance_of(open, &validate::id_text(&source_id))
            .map(|(_, s)| HostAppearanceRecord { host_id: validate::id_text(&id), os: s.record.os });
        let appearance_id = random_id().map_err(from_vault)?;
        let mut rows = vec![self.seal_row(open, id, KIND_HOST, 1, Some((&record, host_content_len(&record))))?];
        if let Some(a) = &appearance {
            rows.push(self.seal_row(open, appearance_id, KIND_HOST_APPEARANCE, 1, Some((a, a.host_id.len())))?);
        }
        // The copy also keeps the source's identity and other workflow settings.
        let workflow = Self::workflow_of_host(open, &validate::id_text(&source_id))
            .map(|(_, s)| WorkflowRecord { host_id: Some(validate::id_text(&id)), ..s.record.clone() });
        let workflow_id = random_id().map_err(from_vault)?;
        if let Some(w) = &workflow {
            rows.push(self.seal_row(open, workflow_id, KIND_WORKFLOW, 1, Some((w, w.content_len())))?);
        }
        self.db.put_records(rows).await.map_err(from_storage)?;
        if let Some(record) = appearance {
            open.appearances.insert(appearance_id, Stored { revision: 1, record });
        }
        if let Some(record) = workflow {
            open.workflows.insert(workflow_id, Stored { revision: 1, record });
        }
        let summary = host_summary(&group_index(open), &id, &record);
        open.hosts.insert(id, Stored { revision: 1, record });
        Ok(summary)
    }

    pub async fn delete_host(&self, id: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision = open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.revision + 1;
        // agent D: the host's appearance record goes in the same transaction.
        let (mut rows, appearance_ids) = self.appearance_tombstones(open, &[id])?;
        let (workflow_rows, workflow_ids) = self.workflow_tombstones(open, &[id], &[])?;
        rows.extend(workflow_rows);
        rows.push(self.seal_row::<HostRecord>(open, id, KIND_HOST, revision, None)?);
        self.db.put_records(rows).await.map_err(from_storage)?;
        for appearance in appearance_ids {
            open.appearances.remove(&appearance);
        }
        for workflow in workflow_ids {
            open.workflows.remove(&workflow);
        }
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
        let mut rows = writes
            .iter()
            .map(|(id, revision, record)| {
                self.seal_row(open, *id, KIND_HOST, *revision, record.as_ref().map(|r| (r, host_content_len(r))))
            })
            .collect::<Result<Vec<_>, _>>()?;
        // agent D: deleted hosts take their appearance records with them, in the same transaction.
        let (appearance_rows, appearance_ids) = if matches!(change, BulkHostChange::Delete) {
            self.appearance_tombstones(open, &ids)?
        } else {
            (Vec::new(), Vec::new())
        };
        rows.extend(appearance_rows);
        let (workflow_rows, workflow_ids) = if matches!(change, BulkHostChange::Delete) {
            self.workflow_tombstones(open, &ids, &[])?
        } else {
            (Vec::new(), Vec::new())
        };
        rows.extend(workflow_rows);
        self.db.put_records(rows).await.map_err(from_storage)?;
        for appearance in appearance_ids {
            open.appearances.remove(&appearance);
        }
        for workflow in workflow_ids {
            open.workflows.remove(&workflow);
        }
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
            // agent D: inventory and snippets
            ImportFormat::PuttyReg => crate::importers::parse_putty_reg(text)?,
            ImportFormat::Mobaxterm => crate::importers::parse_mobaxterm(text)?,
            ImportFormat::Securecrt => crate::importers::parse_securecrt(text)?,
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
                protocol: tyrminal_contracts::HostProtocol::Ssh,
                terminal: tyrminal_contracts::HostTerminal::default(),
                forward_agent: false,
                // agent B: tunnels and history
                connection: Default::default(),
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
        // The group's workflow settings (identity, ...) go in the same transaction.
        let (mut rows, workflow_ids) = self.workflow_tombstones(open, &[], &[group_id])?;
        rows.push(self.seal_row::<GroupRecord>(open, group_id, KIND_GROUP, revision, None)?);
        self.db.put_records(rows).await.map_err(from_storage)?;
        for workflow in workflow_ids {
            open.workflows.remove(&workflow);
        }
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
        if open.identities.values().any(|i| i.record.key_id.as_deref() == Some(key_text.as_str())) {
            return Err(err(ErrorCode::InUse, "Identities still use this key. Change their key first."));
        }
        // agent D: the key's certificate goes in the same transaction.
        let certificate =
            open.certificates.iter().find(|(_, c)| c.record.key_id == key_text).map(|(id, c)| (*id, c.revision));
        let mut rows = vec![self.seal_row::<KeyRecord>(open, key_id, KIND_KEY, revision, None)?];
        if let Some((cert_id, cert_revision)) = certificate {
            rows.push(self.seal_row::<KeyCertificateRecord>(
                open,
                cert_id,
                KIND_KEY_CERTIFICATE,
                cert_revision + 1,
                None,
            )?);
        }
        self.db.put_records(rows).await.map_err(from_storage)?;
        if let Some((cert_id, _)) = certificate {
            open.certificates.remove(&cert_id);
        }
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
        let target = Self::hop_plan(open, &id)?;
        // agent B: tunnels and history: the jump hosts, first hop first.
        let jumps = crate::tunnels::chain(&id, |hop| Self::jump_of(open, hop))?
            .iter()
            .map(|hop| Self::hop_plan(open, hop))
            .collect::<Result<Vec<_>, _>>()?;
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
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        let env = Self::effective_env(open, &id, host).into_iter().map(|(n, v, _)| (n, v)).collect();
        Ok(ConnectionPlan {
            env,
            host_id: validate::id_text(&id),
            endpoint: target.endpoint,
            username: target.username,
            auth: target.auth,
            proxy: target.proxy,
            label: target.label,
            jumps,
            known_hosts,
            generation: self.generation(),
        })
    }

    /// Where and as whom one host of a chain is reached, with its credentials.
    fn hop_plan(open: &Open, id: &Id) -> Result<HopPlan, IpcError> {
        let host = &open.hosts.get(id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        let groups = group_index(open);
        let effective = inventory::effective(&groups, host);
        // A host's identity, else its nearest group's when the host inherits its sign-in method,
        // supplies the user name (when it has one) and the credentials (KEY-15/16).
        let identity = Self::identity_for_host(open, id, host).map(|(_, record, _)| record);
        let username = identity
            .filter(|i| !i.username.is_empty())
            .map_or_else(|| effective.username.clone(), |i| i.username.clone());
        if username.is_empty() {
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
        let auth = match (identity, &effective.auth) {
            (Some(identity), _) => match (&identity.key_id, &identity.password) {
                (Some(key_id), _) => key_plan(key_id)?,
                (None, Some(password)) => PlanAuth::Password(Zeroizing::new(password.as_str().to_owned())),
                (None, None) => PlanAuth::Ask,
            },
            (None, auth) => match auth {
                EffectiveAuth::Own(StoredAuth::Password { password }) => {
                    PlanAuth::Password(Zeroizing::new(password.as_str().to_owned()))
                }
                EffectiveAuth::Own(StoredAuth::Key { key_id }) => key_plan(key_id)?,
                EffectiveAuth::GroupKey(key_id) => key_plan(key_id)?,
                EffectiveAuth::Own(StoredAuth::AskPassword | StoredAuth::Inherit) | EffectiveAuth::Ask => PlanAuth::Ask,
            },
        };
        Ok(HopPlan {
            label: host.label.clone(),
            endpoint: Endpoint::new(host.address.clone(), effective.port),
            username,
            auth,
            // agent B: tunnels and history
            proxy: host.connection.proxy.as_ref().map(crate::tunnels::proxy_spec),
        })
    }

    /// Fails unless the vault is unlocked; returns the generation for handle binding.
    /// How a host is reached: its protocol, address and port (Telnet's default port is 23),
    /// with the generation to open the session under. No credentials are read.
    pub(crate) async fn host_endpoint(&self, host_id: &str) -> Result<HostEndpoint, IpcError> {
        let id = validate::id(host_id)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        let port = match (&host.protocol, host.port) {
            (tyrminal_contracts::HostProtocol::Telnet, 0) => 23,
            (_, 0) => inventory::effective(&group_index(open), host).port,
            (_, port) => port,
        };
        Ok(HostEndpoint {
            protocol: host.protocol.clone(),
            terminal: host.terminal,
            forward_agent: host.forward_agent,
            address: host.address.clone(),
            port,
            generation: self.generation(),
        })
    }

    pub(crate) async fn require_unlocked(&self) -> Result<u32, IpcError> {
        let inner = self.inner.lock().await;
        if inner.open.is_none() {
            return Err(locked());
        }
        Ok(self.generation())
    }
}

// agent B: tunnels and history
impl VaultService {
    /// A host's advanced connection settings.
    pub async fn host_connection(&self, host_id: &str) -> Result<HostConnection, IpcError> {
        let id = validate::id(host_id)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        Ok(HostConnection {
            jump_host_id: host.connection.jump_host.clone(),
            proxy: host.connection.proxy.as_ref().map(crate::tunnels::proxy_summary),
        })
    }

    /// Replaces a host's advanced connection settings. The jump host must exist, and the chain it
    /// makes must end (no loops) within `MAX_CHAIN_HOPS` hosts.
    pub async fn set_host_connection(
        &self,
        host_id: &str,
        input: HostConnectionInput,
    ) -> Result<Vec<ChainHop>, IpcError> {
        let id = validate::id(host_id)?;
        let jump = input.jump_host_id.as_deref().map(validate::id).transpose()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let current = open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?;
        if let Some(jump) = &jump
            && !open.hosts.contains_key(jump)
        {
            return Err(not_found("That jump host no longer exists. Choose another."));
        }
        let proxy = match &input.proxy {
            Some(proxy) => Some(crate::tunnels::normalize_proxy(proxy, current.record.connection.proxy.as_ref())?),
            None => None,
        };
        let mut record = copy_host(&current.record);
        record.connection.jump_host = jump.map(|j| validate::id_text(&j));
        record.connection.proxy = proxy;
        let revision = current.revision + 1;
        // Check the chain this would make before anything is written.
        let proposed = jump;
        crate::tunnels::chain(&id, |hop| if *hop == id { Ok(proposed) } else { Self::jump_of(open, hop) })?;
        self.write(open, id, KIND_HOST, revision, Some((&record, host_content_len(&record)))).await?;
        open.hosts.insert(id, Stored { revision, record });
        Self::chain_view(open, &id)
    }

    /// The hosts a connection to `host_id` goes through, first hop first, the host itself last.
    pub async fn host_chain(&self, host_id: &str) -> Result<Vec<ChainHop>, IpcError> {
        let id = validate::id(host_id)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        Self::chain_view(open, &id)
    }

    /// The jump host recorded on `id`.
    fn jump_of(open: &Open, id: &Id) -> Result<Option<Id>, IpcError> {
        let host =
            &open.hosts.get(id).ok_or_else(|| not_found("A host in this connection chain no longer exists."))?.record;
        host.connection.jump_host.as_deref().map(validate::id).transpose()
    }

    fn chain_view(open: &Open, id: &Id) -> Result<Vec<ChainHop>, IpcError> {
        let groups = group_index(open);
        let mut hops = crate::tunnels::chain(id, |hop| Self::jump_of(open, hop))?;
        hops.push(*id);
        hops.iter()
            .map(|hop| {
                let record = &open.hosts.get(hop).ok_or_else(|| not_found("That host no longer exists."))?.record;
                Ok(ChainHop {
                    host_id: validate::id_text(hop),
                    label: record.label.clone(),
                    address: record.address.clone(),
                    port: inventory::effective(&groups, record).port,
                })
            })
            .collect()
    }

    fn tunnel_summary(open: &Open, id: &Id, record: &TunnelRecord) -> TunnelSummary {
        let host_label =
            validate::id(&record.host_id).ok().and_then(|host| open.hosts.get(&host)).map(|h| h.record.label.clone());
        crate::tunnels::summary(validate::id_text(id), record, host_label)
    }

    pub async fn list_tunnels(&self) -> Result<Vec<TunnelSummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<_> = open.tunnels.iter().map(|(id, t)| Self::tunnel_summary(open, id, &t.record)).collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        Ok(list)
    }

    /// Saves a rule after native validation; the host must exist.
    pub async fn save_tunnel(&self, input: TunnelInput) -> Result<TunnelSummary, IpcError> {
        let existing_id = input.id.as_deref().map(validate::id).transpose()?;
        let mut record = crate::tunnels::normalize(&input)?;
        record.updated_at = now_unix();
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if !open.hosts.contains_key(&validate::id(&record.host_id)?) {
            return Err(not_found("That host no longer exists."));
        }
        let (id, revision) = match existing_id {
            Some(id) => {
                let current = open.tunnels.get(&id).ok_or_else(|| not_found("That tunnel no longer exists."))?;
                (id, current.revision + 1)
            }
            None => {
                if open.tunnels.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of tunnels."));
                }
                (random_id().map_err(from_vault)?, 1)
            }
        };
        let content_len = record.name.len() + record.host_id.len() + record.bind_host.len() + record.dest_host.len();
        self.write(open, id, KIND_TUNNEL, revision, Some((&record, content_len))).await?;
        let summary = Self::tunnel_summary(open, &id, &record);
        open.tunnels.insert(id, Stored { revision, record });
        Ok(summary)
    }

    /// A copy of a rule under a new name, never set to start automatically.
    pub async fn duplicate_tunnel(&self, id: &str) -> Result<TunnelSummary, IpcError> {
        let source = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let mut record =
            open.tunnels.get(&source).ok_or_else(|| not_found("That tunnel no longer exists."))?.record.clone();
        if open.tunnels.len() >= MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of tunnels."));
        }
        record.name = crate::tunnels::copy_name(&record.name);
        record.auto_start = false;
        record.updated_at = now_unix();
        let id = random_id().map_err(from_vault)?;
        let content_len = record.name.len() + record.host_id.len() + record.bind_host.len() + record.dest_host.len();
        self.write(open, id, KIND_TUNNEL, 1, Some((&record, content_len))).await?;
        let summary = Self::tunnel_summary(open, &id, &record);
        open.tunnels.insert(id, Stored { revision: 1, record });
        Ok(summary)
    }

    pub async fn delete_tunnel(&self, id: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision = open.tunnels.get(&id).ok_or_else(|| not_found("That tunnel no longer exists."))?.revision + 1;
        self.write::<TunnelRecord>(open, id, KIND_TUNNEL, revision, None).await?;
        open.tunnels.remove(&id);
        Ok(())
    }

    /// One rule, read under `generation`: after a lock nothing is returned.
    pub(crate) async fn tunnel_rule(&self, generation: u32, id: &str) -> Result<TunnelRecord, IpcError> {
        let id = validate::id(id)?;
        let inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_ref().ok_or_else(locked)?;
        Ok(open.tunnels.get(&id).ok_or_else(|| not_found("That tunnel no longer exists."))?.record.clone())
    }

    /// The rules of `host_id` that start with every connection, read under `generation`.
    pub(crate) async fn auto_start_tunnels(
        &self,
        generation: u32,
        host_id: &str,
    ) -> Result<Vec<(String, TunnelRecord)>, IpcError> {
        let inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_ref().ok_or_else(locked)?;
        Ok(open
            .tunnels
            .iter()
            .filter(|(_, t)| t.record.auto_start && t.record.host_id == host_id)
            .map(|(id, t)| (validate::id_text(id), t.record.clone()))
            .collect())
    }
}

// agent D: inventory and snippets
/// Rows ready for one `put_records` transaction.
type SealedRows = Vec<(RecordRow, WriteCondition)>;

impl VaultService {
    /// The appearance record of a host, if it has one.
    fn appearance_of<'a>(open: &'a Open, host_id: &str) -> Option<(Id, &'a Stored<HostAppearanceRecord>)> {
        open.appearances.iter().find(|(_, s)| s.record.host_id == host_id).map(|(id, s)| (*id, s))
    }

    /// Tombstones for the appearance records of hosts that are being deleted, so a host and
    /// everything that belongs to it go in one transaction. Returns the rows and the record ids
    /// to drop from memory once they are written.
    fn appearance_tombstones(&self, open: &Open, host_ids: &[Id]) -> Result<(SealedRows, Vec<Id>), IpcError> {
        let texts: std::collections::HashSet<String> = host_ids.iter().map(validate::id_text).collect();
        let mut rows = Vec::new();
        let mut ids = Vec::new();
        for (id, stored) in open.appearances.iter().filter(|(_, s)| texts.contains(&s.record.host_id)) {
            rows.push(self.seal_row::<HostAppearanceRecord>(
                open,
                *id,
                KIND_HOST_APPEARANCE,
                stored.revision + 1,
                None,
            )?);
            ids.push(*id);
        }
        Ok((rows, ids))
    }

    /// Hosts for trusted known-host records that no host entry uses yet (same address and
    /// effective port), as an import preview. Only records the user already trusted are offered,
    /// and nothing is written until the preview is imported (`import_hosts`, one transaction).
    pub async fn known_host_import_preview(&self) -> Result<ImportPreview, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let groups = group_index(open);
        let used: std::collections::HashSet<(String, u16)> = open
            .hosts
            .values()
            .map(|h| (h.record.address.to_lowercase(), inventory::effective(&groups, &h.record).port))
            .collect();
        let labels: std::collections::HashSet<String> =
            open.hosts.values().map(|h| h.record.label.to_lowercase()).collect();
        let mut seen = std::collections::HashSet::new();
        let mut known: Vec<&KnownHostRecord> = open.known_hosts.values().map(|k| &k.record).collect();
        known.sort_by_key(|k| (k.host.to_lowercase(), k.port));
        let mut preview = ImportPreview { hosts: Vec::new(), skipped: Vec::new(), duplicates: Vec::new() };
        for record in known {
            let key = (record.host.to_lowercase(), record.port);
            if used.contains(&key) || !seen.insert(key) {
                continue;
            }
            let label = if record.port == inventory::DEFAULT_PORT {
                record.host.clone()
            } else if record.host.contains(':') {
                format!("[{}]:{}", record.host, record.port)
            } else {
                format!("{}:{}", record.host, record.port)
            };
            let candidate = ImportHost {
                label,
                address: record.host.clone(),
                port: record.port,
                username: String::new(),
                group: String::new(),
                tags: Vec::new(),
                notes: vec![format!("Trusted {} key {}", record.algorithm, record.fingerprint)],
            };
            match import::checked(candidate) {
                Ok(host) => {
                    if labels.contains(&host.label.to_lowercase()) {
                        preview.duplicates.push(host.label.clone());
                    }
                    preview.hosts.push(host);
                }
                Err(reason) => preview.skipped.push(tyrminal_contracts::ImportSkipped {
                    line: 0,
                    text: record.host.chars().filter(|c| !c.is_control()).take(120).collect(),
                    reason,
                }),
            }
        }
        Ok(preview)
    }

    /// Generates a key of `kind` inside the vault. RSA generation runs off the async runtime.
    pub async fn generate_key_of(&self, label: &str, kind: KeyKind) -> Result<KeySummary, IpcError> {
        let label = validate::label(label)?;
        let kind = match kind {
            KeyKind::Ed25519 => tyrminal_ssh::KeyKind::Ed25519,
            KeyKind::EcdsaP256 => tyrminal_ssh::KeyKind::EcdsaP256,
            KeyKind::EcdsaP384 => tyrminal_ssh::KeyKind::EcdsaP384,
            KeyKind::EcdsaP521 => tyrminal_ssh::KeyKind::EcdsaP521,
            KeyKind::Rsa3072 => tyrminal_ssh::KeyKind::Rsa3072,
            KeyKind::Rsa4096 => tyrminal_ssh::KeyKind::Rsa4096,
        };
        let key = tokio::task::spawn_blocking(move || ClientKey::generate(kind))
            .await
            .map_err(|_| internal())?
            .map_err(from_key)?;
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

    fn certificate_summary(record: &KeyCertificateRecord) -> KeyCertificate {
        KeyCertificate {
            key_id: record.key_id.clone(),
            algorithm: record.algorithm.clone(),
            cert_key_id: record.cert_key_id.clone(),
            principals: record.principals.clone(),
            valid_after: record.valid_after,
            valid_before: (record.valid_before != u64::MAX).then_some(record.valid_before),
            ca_fingerprint: record.ca_fingerprint.clone(),
        }
    }

    pub async fn list_key_certificates(&self) -> Result<Vec<KeyCertificate>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<_> = open.certificates.values().map(|c| Self::certificate_summary(&c.record)).collect();
        list.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        Ok(list)
    }

    /// Attaches (or replaces) the user certificate of a key after checking it against the key:
    /// valid CA signature, a user certificate, for exactly this public key, not expired. An
    /// encrypted key without its stored passphrase is checked against its stored public key.
    pub async fn attach_key_certificate(&self, key_id: &str, certificate: &str) -> Result<KeyCertificate, IpcError> {
        let id = validate::id(key_id)?;
        let key_text = validate::id_text(&id);
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let key = &open.ssh_keys.get(&id).ok_or_else(|| not_found("That key no longer exists."))?.record;
        let info = tyrminal_ssh::check_user_certificate(&key.public_key, certificate, now_unix()).map_err(from_key)?;
        let record = KeyCertificateRecord {
            key_id: key_text.clone(),
            certificate: info.text,
            algorithm: info.algorithm,
            cert_key_id: info.key_id,
            principals: info.principals,
            valid_after: info.valid_after,
            valid_before: info.valid_before,
            ca_fingerprint: info.ca_fingerprint,
        };
        let content_len = record.certificate.len()
            + record.algorithm.len()
            + record.cert_key_id.len()
            + record.principals.iter().map(String::len).sum::<usize>()
            + record.ca_fingerprint.len()
            + record.key_id.len();
        let (record_id, revision) = match open.certificates.iter().find(|(_, c)| c.record.key_id == key_text) {
            Some((id, c)) => (*id, c.revision + 1),
            None => {
                if open.certificates.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of certificates."));
                }
                (random_id().map_err(from_vault)?, 1)
            }
        };
        self.write(open, record_id, KIND_KEY_CERTIFICATE, revision, Some((&record, content_len))).await?;
        let summary = Self::certificate_summary(&record);
        open.certificates.insert(record_id, Stored { revision, record });
        Ok(summary)
    }

    pub async fn remove_key_certificate(&self, key_id: &str) -> Result<(), IpcError> {
        let key_text = validate::id_text(&validate::id(key_id)?);
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let (record_id, revision) = open
            .certificates
            .iter()
            .find(|(_, c)| c.record.key_id == key_text)
            .map(|(id, c)| (*id, c.revision + 1))
            .ok_or_else(|| not_found("That key has no certificate."))?;
        self.write::<KeyCertificateRecord>(open, record_id, KIND_KEY_CERTIFICATE, revision, None).await?;
        open.certificates.remove(&record_id);
        Ok(())
    }

    // ---------- saved execution targets (SNP-06) ----------

    fn target_summary(open: &Open, id: &Id, record: &ExecutionTargetRecord) -> ExecutionTarget {
        let (live, missing): (Vec<&String>, Vec<&String>) =
            record.host_ids.iter().partition(|h| validate::id(h).ok().is_some_and(|id| open.hosts.contains_key(&id)));
        ExecutionTarget {
            id: validate::id_text(id),
            name: record.name.clone(),
            host_ids: live.into_iter().cloned().collect(),
            missing: missing.len() as u32,
        }
    }

    pub async fn list_execution_targets(&self) -> Result<Vec<ExecutionTarget>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<_> = open.targets.iter().map(|(id, t)| Self::target_summary(open, id, &t.record)).collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        Ok(list)
    }

    /// Saves a host selection. Every host must exist now; duplicates are dropped.
    pub async fn save_execution_target(&self, input: ExecutionTargetInput) -> Result<ExecutionTarget, IpcError> {
        let name = validate::label(&input.name)?;
        if input.host_ids.is_empty() {
            return Err(invalid("Choose at least one host."));
        }
        if input.host_ids.len() > MAX_BULK_HOSTS {
            return Err(err(ErrorCode::LimitExceeded, "Too many hosts for one target."));
        }
        let ids: Vec<Id> = input.host_ids.iter().map(|h| validate::id(h)).collect::<Result<_, _>>()?;
        let existing = input.id.as_deref().map(validate::id).transpose()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let mut host_ids: Vec<String> = Vec::with_capacity(ids.len());
        for id in &ids {
            if !open.hosts.contains_key(id) {
                return Err(not_found("A selected host no longer exists."));
            }
            let text = validate::id_text(id);
            if !host_ids.contains(&text) {
                host_ids.push(text);
            }
        }
        let (id, revision) = match existing {
            Some(id) => {
                (id, open.targets.get(&id).ok_or_else(|| not_found("That target no longer exists."))?.revision + 1)
            }
            None => {
                if open.targets.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of targets."));
                }
                (random_id().map_err(from_vault)?, 1)
            }
        };
        let record = ExecutionTargetRecord { name, host_ids };
        let content_len = record.name.len() + record.host_ids.iter().map(String::len).sum::<usize>();
        self.write(open, id, KIND_EXECUTION_TARGET, revision, Some((&record, content_len))).await?;
        let summary = Self::target_summary(open, &id, &record);
        open.targets.insert(id, Stored { revision, record });
        Ok(summary)
    }

    pub async fn delete_execution_target(&self, id: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision = open.targets.get(&id).ok_or_else(|| not_found("That target no longer exists."))?.revision + 1;
        self.write::<ExecutionTargetRecord>(open, id, KIND_EXECUTION_TARGET, revision, None).await?;
        open.targets.remove(&id);
        Ok(())
    }

    // ---------- snippet organization (SNP-10) ----------

    /// Moves snippets into `folder` (or, with `copy`, adds copies there), all in one transaction.
    /// Returns the moved or created snippets.
    pub async fn move_snippets(
        &self,
        ids: &[String],
        folder: &str,
        copy: bool,
    ) -> Result<Vec<SnippetSummary>, IpcError> {
        if ids.len() > MAX_BULK_HOSTS {
            return Err(err(ErrorCode::LimitExceeded, "Too many snippets for one change."));
        }
        let folder = validate::folder(folder)?;
        let ids: Vec<Id> = ids.iter().map(|id| validate::id(id)).collect::<Result<_, _>>()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if copy && open.snippets.len() + ids.len() > MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault cannot hold that many snippets."));
        }
        let mut writes: Vec<(Id, u64, SnippetRecord)> = Vec::with_capacity(ids.len());
        for id in &ids {
            let stored = open.snippets.get(id).ok_or_else(|| not_found("A selected snippet no longer exists."))?;
            let record = SnippetRecord {
                name: stored.record.name.clone(),
                folder: folder.clone(),
                text: stored.record.text.clone(),
                updated_at: now_unix(),
            };
            if copy {
                writes.push((random_id().map_err(from_vault)?, 1, record));
            } else if !writes.iter().any(|(w, _, _)| w == id) {
                writes.push((*id, stored.revision + 1, record));
            }
        }
        self.write_snippets(open, writes).await
    }

    /// Renames a folder: every snippet in it or in its subfolders moves under the new path.
    pub async fn rename_snippet_folder(&self, from: &str, to: &str) -> Result<u32, IpcError> {
        let from = validate::folder(from)?;
        let to = validate::folder(to)?;
        if from.is_empty() {
            return Err(invalid("Choose a folder to rename."));
        }
        if to == from || to.starts_with(&format!("{from}/")) {
            return Err(invalid("A folder cannot be moved into itself."));
        }
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let mut writes = Vec::new();
        for (id, stored) in &open.snippets {
            let folder = &stored.record.folder;
            let rest = if *folder == from {
                Some("")
            } else {
                folder.strip_prefix(&format!("{from}/")).map(|_| &folder[from.len()..])
            };
            let Some(rest) = rest else { continue };
            let moved = validate::folder(&format!("{to}{rest}"))?;
            writes.push((
                *id,
                stored.revision + 1,
                SnippetRecord {
                    name: stored.record.name.clone(),
                    folder: moved,
                    text: stored.record.text.clone(),
                    updated_at: now_unix(),
                },
            ));
        }
        if writes.is_empty() {
            return Err(not_found("That folder is empty or no longer exists."));
        }
        Ok(self.write_snippets(open, writes).await?.len() as u32)
    }

    async fn write_snippets(
        &self,
        open: &mut Open,
        writes: Vec<(Id, u64, SnippetRecord)>,
    ) -> Result<Vec<SnippetSummary>, IpcError> {
        let rows = writes
            .iter()
            .map(|(id, revision, r)| {
                self.seal_row(
                    open,
                    *id,
                    KIND_SNIPPET,
                    *revision,
                    Some((r, r.name.len() + r.folder.len() + r.text.len())),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !rows.is_empty() {
            self.db.put_records(rows).await.map_err(from_storage)?;
        }
        let mut out = Vec::with_capacity(writes.len());
        for (id, revision, record) in writes {
            out.push(snippet_summary(&id, &record));
            open.snippets.insert(id, Stored { revision, record });
        }
        Ok(out)
    }

    // ---------- known_hosts file import (IMP-01) ----------

    fn known_host_status(
        open: &Open,
        host: &str,
        port: u16,
        key: &tyrminal_ssh::PresentedHostKey,
    ) -> KnownHostImportStatus {
        let same_endpoint = || open.known_hosts.values().filter(|k| k.record.host == host && k.record.port == port);
        if same_endpoint().any(|k| k.record.public_key == key.public_key) {
            KnownHostImportStatus::AlreadyTrusted
        } else if same_endpoint().any(|k| k.record.algorithm == key.algorithm) {
            KnownHostImportStatus::Conflict
        } else {
            KnownHostImportStatus::New
        }
    }

    /// Reads an OpenSSH `known_hosts` file into a preview: which keys would become trusted, which
    /// are trusted already, which conflict with a different trusted key, and what is skipped.
    pub async fn known_hosts_file_preview(&self, text: &str) -> Result<KnownHostImportPreview, IpcError> {
        let (lines, parsed) = crate::importers::parse_known_hosts(text)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut entries: Vec<KnownHostImportEntry> = Vec::new();
        for l in lines {
            if entries.iter().any(|e| e.host == l.host && e.port == l.port && e.public_key == l.key.public_key) {
                continue;
            }
            let status = Self::known_host_status(open, &l.host, l.port, &l.key);
            entries.push(KnownHostImportEntry {
                host: l.host,
                port: l.port,
                algorithm: l.key.algorithm,
                fingerprint: l.key.fingerprint,
                public_key: l.key.public_key,
                status,
            });
        }
        Ok(KnownHostImportPreview { entries, skipped: parsed.skipped })
    }

    /// Trusts the previewed keys in one transaction. Everything is checked again here (the preview
    /// came back through the renderer); a key that conflicts with a different trusted key of the
    /// same type refuses the whole import, since trust is only ever replaced explicitly. Keys that
    /// are trusted already are skipped. Returns how many keys became trusted.
    pub async fn import_known_hosts(&self, entries: Vec<KnownHostImportEntry>) -> Result<u32, IpcError> {
        if entries.len() > MAX_IMPORT_HOSTS {
            return Err(err(ErrorCode::LimitExceeded, "Too many keys for one import."));
        }
        let bad = || invalid("An imported key is not valid. Preview the file again.");
        let mut checked: Vec<(String, u16, tyrminal_ssh::PresentedHostKey)> = Vec::with_capacity(entries.len());
        for e in entries {
            let host = tyrminal_ssh::canonical_host(&validate::address(&e.host).map_err(|_| bad())?);
            let key = tyrminal_ssh::host_key_from_openssh(&e.public_key).ok_or_else(bad)?;
            if host != e.host || e.port == 0 || key.fingerprint != e.fingerprint {
                return Err(bad());
            }
            checked.push((host, e.port, key));
        }
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let mut new: Vec<(Id, KnownHostRecord)> = Vec::new();
        for (host, port, key) in checked {
            match Self::known_host_status(open, &host, port, &key) {
                KnownHostImportStatus::Conflict => {
                    return Err(err(
                        ErrorCode::Conflict,
                        "A different key is already trusted for one of these servers. Nothing was imported; remove that trust first if the server's key really changed.",
                    ));
                }
                KnownHostImportStatus::AlreadyTrusted => continue,
                KnownHostImportStatus::New => {}
            }
            if new.iter().any(|(_, r)| r.host == host && r.port == port && r.public_key == key.public_key) {
                continue;
            }
            if new.iter().any(|(_, r)| r.host == host && r.port == port && r.algorithm == key.algorithm) {
                return Err(invalid(
                    "The file lists two different keys of one type for the same server. Nothing was imported.",
                ));
            }
            let record = KnownHostRecord {
                host,
                port,
                public_key: key.public_key,
                algorithm: key.algorithm,
                fingerprint: key.fingerprint,
                added_at: now_unix(),
            };
            new.push((random_id().map_err(from_vault)?, record));
        }
        if open.known_hosts.len() + new.len() > MAX_RECORDS_PER_KIND {
            return Err(err(ErrorCode::LimitExceeded, "The vault cannot hold that many known hosts."));
        }
        let rows = new
            .iter()
            .map(|(id, r)| {
                let len = r.host.len() + r.public_key.len() + r.algorithm.len() + r.fingerprint.len();
                self.seal_row(open, *id, KIND_KNOWN_HOST, 1, Some((r, len)))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !rows.is_empty() {
            self.db.put_records(rows).await.map_err(from_storage)?;
        }
        let count = new.len() as u32;
        for (id, record) in new {
            open.known_hosts.insert(id, Stored { revision: 1, record });
        }
        Ok(count)
    }

    /// The OS recorded for each host that has one.
    pub async fn list_host_appearances(&self) -> Result<Vec<HostAppearance>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<HostAppearance> = open
            .appearances
            .values()
            .map(|s| HostAppearance { host_id: s.record.host_id.clone(), os: s.record.os })
            .collect();
        list.sort_by(|a, b| a.host_id.cmp(&b.host_id));
        Ok(list)
    }

    /// Sets (or with `None` clears) the OS of several hosts in one transaction. Every host must
    /// exist; returns how many hosts changed.
    pub async fn set_host_os(&self, host_ids: &[String], os: Option<HostOs>) -> Result<u32, IpcError> {
        if host_ids.is_empty() {
            return Ok(0);
        }
        if host_ids.len() > MAX_BULK_HOSTS {
            return Err(err(ErrorCode::LimitExceeded, "Too many hosts for one change."));
        }
        let ids: Vec<Id> = host_ids.iter().map(|id| validate::id(id)).collect::<Result<_, _>>()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let mut writes: Vec<(Id, u64, Option<HostAppearanceRecord>)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            if !open.hosts.contains_key(id) {
                return Err(not_found("A selected host no longer exists."));
            }
            let host_id = validate::id_text(id);
            if !seen.insert(host_id.clone()) {
                continue;
            }
            let current = Self::appearance_of(open, &host_id);
            match (current, os) {
                (Some((record_id, stored)), Some(os)) if stored.record.os != os => {
                    writes.push((record_id, stored.revision + 1, Some(HostAppearanceRecord { host_id, os })));
                }
                (Some((record_id, stored)), None) => writes.push((record_id, stored.revision + 1, None)),
                (None, Some(os)) => {
                    if open.appearances.len() + writes.len() >= MAX_RECORDS_PER_KIND {
                        return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of items."));
                    }
                    writes.push((random_id().map_err(from_vault)?, 1, Some(HostAppearanceRecord { host_id, os })));
                }
                _ => {}
            }
        }
        let rows = writes
            .iter()
            .map(|(id, revision, record)| {
                self.seal_row(open, *id, KIND_HOST_APPEARANCE, *revision, record.as_ref().map(|r| (r, r.host_id.len())))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !rows.is_empty() {
            self.db.put_records(rows).await.map_err(from_storage)?;
        }
        let changed = writes.len() as u32;
        for (id, revision, record) in writes {
            match record {
                Some(record) => {
                    open.appearances.insert(id, Stored { revision, record });
                }
                None => {
                    open.appearances.remove(&id);
                }
            }
        }
        Ok(changed)
    }
}

// Identities and per-host/group workflow settings (KEY-15..17).
impl VaultService {
    /// The target with its id in canonical form.
    fn settings_target(target: SettingsTarget) -> Result<SettingsTarget, IpcError> {
        Ok(match target {
            SettingsTarget::Host { host_id } => {
                SettingsTarget::Host { host_id: validate::id_text(&validate::id(&host_id)?) }
            }
            SettingsTarget::Group { group_id } => {
                SettingsTarget::Group { group_id: validate::id_text(&validate::id(&group_id)?) }
            }
        })
    }

    fn require_target(open: &Open, target: &SettingsTarget) -> Result<(), IpcError> {
        match target {
            SettingsTarget::Host { host_id } if !open.hosts.contains_key(&validate::id(host_id)?) => {
                Err(not_found("That host no longer exists."))
            }
            SettingsTarget::Group { group_id } if !open.groups.contains_key(&validate::id(group_id)?) => {
                Err(not_found("That group no longer exists."))
            }
            _ => Ok(()),
        }
    }

    /// Applies `change` to the target's workflow record, creating it when needed and deleting it
    /// when nothing is left in it.
    async fn update_workflow(
        &self,
        open: &mut Open,
        target: &SettingsTarget,
        change: impl FnOnce(WorkflowRecord) -> WorkflowRecord,
    ) -> Result<(), IpcError> {
        let current = Self::workflow_of(open, target).map(|(id, w)| (id, w.revision, w.record.clone()));
        let base = current.as_ref().map(|(_, _, r)| r.clone()).unwrap_or_else(|| match target {
            SettingsTarget::Host { host_id } => WorkflowRecord { host_id: Some(host_id.clone()), ..Default::default() },
            SettingsTarget::Group { group_id } => {
                WorkflowRecord { group_id: Some(group_id.clone()), ..Default::default() }
            }
        });
        let next = change(base);
        match (current, next.is_empty()) {
            (None, true) => {}
            (Some((wid, revision, _)), true) => {
                self.write::<WorkflowRecord>(open, wid, KIND_WORKFLOW, revision + 1, None).await?;
                open.workflows.remove(&wid);
            }
            (current, false) => {
                if current.is_none() && open.workflows.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of host settings."));
                }
                let (wid, revision) = match current {
                    Some((wid, revision, _)) => (wid, revision + 1),
                    None => (random_id().map_err(from_vault)?, 1),
                };
                self.write(open, wid, KIND_WORKFLOW, revision, Some((&next, next.content_len()))).await?;
                open.workflows.insert(wid, Stored { revision, record: next });
            }
        }
        Ok(())
    }

    // ---------- environment variables (SNP-11..14) ----------

    /// A host's environment: outermost group first, nearer groups and then the host override.
    fn effective_env(open: &Open, id: &Id, host: &HostRecord) -> Vec<(String, Zeroizing<String>, SettingOrigin)> {
        let mut out: Vec<(String, Zeroizing<String>, SettingOrigin)> = Vec::new();
        let mut set = |name: &str, value: &Zeroizing<String>, origin: SettingOrigin| {
            out.retain(|(n, _, _)| n != name);
            out.push((name.to_owned(), Zeroizing::new(value.as_str().to_owned()), origin));
        };
        for (group_id, group) in Self::group_chain(open, host).into_iter().rev() {
            if let Some((_, w)) = Self::workflow_of_group(open, &group_id) {
                for e in &w.record.env {
                    set(
                        &e.name,
                        &e.value,
                        SettingOrigin::Group { group_id: group_id.clone(), name: group.name.clone() },
                    );
                }
            }
        }
        if let Some((_, w)) = Self::workflow_of_host(open, &validate::id_text(id)) {
            for e in &w.record.env {
                set(&e.name, &e.value, SettingOrigin::Host);
            }
        }
        out
    }

    fn own_env(open: &Open, target: &SettingsTarget) -> Vec<EnvVar> {
        Self::workflow_of(open, target)
            .map(|(_, w)| {
                w.record
                    .env
                    .iter()
                    .map(|e| EnvVar { name: e.name.clone(), value: e.value.as_str().to_owned() })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The variables a host or group sets itself, in order.
    pub async fn env_vars(&self, target: SettingsTarget) -> Result<Vec<EnvVar>, IpcError> {
        let target = Self::settings_target(target)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        Self::require_target(open, &target)?;
        Ok(Self::own_env(open, &target))
    }

    /// Replaces the variables a host or group sets itself.
    pub async fn set_env_vars(&self, target: SettingsTarget, vars: Vec<EnvVar>) -> Result<Vec<EnvVar>, IpcError> {
        let target = Self::settings_target(target)?;
        let checked = validate::env_vars(&vars)?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        Self::require_target(open, &target)?;
        let env: Vec<StoredEnv> =
            checked.into_iter().map(|(name, value)| StoredEnv { name, value: Zeroizing::new(value) }).collect();
        self.update_workflow(open, &target, |w| WorkflowRecord { env, ..w }).await?;
        Ok(Self::own_env(open, &target))
    }

    /// What a host sends, with where each variable comes from (SNP-12).
    pub async fn effective_env_vars(&self, host_id: &str) -> Result<Vec<EffectiveEnvVar>, IpcError> {
        let id = validate::id(host_id)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        Ok(Self::effective_env(open, &id, host)
            .into_iter()
            .map(|(name, value, origin)| EffectiveEnvVar { name, value: value.as_str().to_owned(), origin })
            .collect())
    }

    /// The variables to request for a session to `host_id` (names and values, in order).
    pub(crate) async fn session_env(&self, host_id: &str) -> Result<Vec<(String, Zeroizing<String>)>, IpcError> {
        let id = validate::id(host_id)?;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        Ok(Self::effective_env(open, &id, host).into_iter().map(|(n, v, _)| (n, v)).collect())
    }

    fn workflow_of_host<'a>(open: &'a Open, host_id: &str) -> Option<(Id, &'a Stored<WorkflowRecord>)> {
        open.workflows.iter().find(|(_, s)| s.record.host_id.as_deref() == Some(host_id)).map(|(id, s)| (*id, s))
    }

    fn workflow_of_group<'a>(open: &'a Open, group_id: &str) -> Option<(Id, &'a Stored<WorkflowRecord>)> {
        open.workflows.iter().find(|(_, s)| s.record.group_id.as_deref() == Some(group_id)).map(|(id, s)| (*id, s))
    }

    fn workflow_of<'a>(open: &'a Open, target: &SettingsTarget) -> Option<(Id, &'a Stored<WorkflowRecord>)> {
        match target {
            SettingsTarget::Host { host_id } => Self::workflow_of_host(open, host_id),
            SettingsTarget::Group { group_id } => Self::workflow_of_group(open, group_id),
        }
    }

    /// Tombstones for the workflow records of hosts and groups being deleted, so they go in the
    /// same transaction.
    fn workflow_tombstones(
        &self,
        open: &Open,
        host_ids: &[Id],
        group_ids: &[Id],
    ) -> Result<(SealedRows, Vec<Id>), IpcError> {
        let hosts: Vec<String> = host_ids.iter().map(validate::id_text).collect();
        let groups: Vec<String> = group_ids.iter().map(validate::id_text).collect();
        let mut rows = Vec::new();
        let mut ids = Vec::new();
        for (id, stored) in open.workflows.iter().filter(|(_, s)| {
            s.record.host_id.as_ref().is_some_and(|h| hosts.contains(h))
                || s.record.group_id.as_ref().is_some_and(|g| groups.contains(g))
        }) {
            rows.push(self.seal_row::<WorkflowRecord>(open, *id, KIND_WORKFLOW, stored.revision + 1, None)?);
            ids.push(*id);
        }
        Ok((rows, ids))
    }

    /// The host's group and its ancestors, nearest first, with their ids.
    fn group_chain<'a>(open: &'a Open, host: &HostRecord) -> Vec<(String, &'a GroupRecord)> {
        let mut out = Vec::new();
        let mut next = host.group.clone();
        while let Some(text) = next {
            if out.len() >= tyrminal_contracts::limits::MAX_GROUP_DEPTH {
                break;
            }
            let Some(group) = validate::id(&text).ok().and_then(|id| open.groups.get(&id)) else { break };
            next = group.record.parent.clone();
            out.push((text, &group.record));
        }
        out
    }

    /// The identity a host signs in with, and where it comes from: the host's own, else the
    /// nearest group's when the host's sign-in method is "inherit from group".
    fn identity_for_host<'a>(
        open: &'a Open,
        id: &Id,
        host: &HostRecord,
    ) -> Option<(String, &'a IdentityRecord, SettingOrigin)> {
        Self::identity_for_host_without(open, id, host, None)
    }

    // identity deletion (BUILD_SPEC §10.2): the same resolution as if `excluded` were removed
    // from every host and group, to show what each host would use instead.
    fn identity_for_host_without<'a>(
        open: &'a Open,
        id: &Id,
        host: &HostRecord,
        excluded: Option<&str>,
    ) -> Option<(String, &'a IdentityRecord, SettingOrigin)> {
        let lookup = |identity: &str| {
            if Some(identity) == excluded {
                return None;
            }
            validate::id(identity).ok().and_then(|i| open.identities.get(&i)).map(|s| (identity.to_owned(), &s.record))
        };
        if let Some((_, own)) = Self::workflow_of_host(open, &validate::id_text(id))
            && let Some(identity) = own.record.identity_id.as_deref()
            && Some(identity) != excluded
        {
            return lookup(identity).map(|(i, r)| (i, r, SettingOrigin::Host));
        }
        if !matches!(host.auth, StoredAuth::Inherit) {
            return None;
        }
        Self::group_chain(open, host).into_iter().find_map(|(group_id, group)| {
            let identity = Self::workflow_of_group(open, &group_id)?.1.record.identity_id.clone()?;
            lookup(&identity).map(|(i, r)| (i, r, SettingOrigin::Group { group_id, name: group.name.clone() }))
        })
    }

    fn identity_summary(open: &Open, id: &Id, record: &IdentityRecord) -> IdentitySummary {
        let text = validate::id_text(id);
        let used_by =
            open.workflows.values().filter(|w| w.record.identity_id.as_deref() == Some(text.as_str())).count();
        IdentitySummary {
            id: text,
            label: record.label.clone(),
            username: record.username.clone(),
            has_password: record.password.is_some(),
            key_id: record.key_id.clone(),
            used_by: u32::try_from(used_by).unwrap_or(u32::MAX),
        }
    }

    pub async fn list_identities(&self) -> Result<Vec<IdentitySummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut list: Vec<_> =
            open.identities.iter().map(|(id, s)| Self::identity_summary(open, id, &s.record)).collect();
        list.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        Ok(list)
    }

    /// Creates or updates an identity. Hosts and groups that use it pick the change up on their
    /// next connection (KEY-16).
    pub async fn save_identity(&self, input: IdentityInput) -> Result<IdentitySummary, IpcError> {
        let label = validate::label(&input.label)?;
        let username =
            if input.username.trim().is_empty() { String::new() } else { validate::username(&input.username)? };
        let key = input.key_id.as_deref().map(validate::id).transpose()?;
        let existing = input.id.as_deref().map(validate::id).transpose()?;
        if let SecretChange::Set { value } = &input.password {
            validate::secret(value)?;
        }
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        if let Some(key) = &key
            && !open.ssh_keys.contains_key(key)
        {
            return Err(not_found("That key no longer exists."));
        }
        let (id, revision, current) = match existing {
            Some(id) => {
                let stored = open.identities.get(&id).ok_or_else(|| not_found("That identity no longer exists."))?;
                (
                    id,
                    stored.revision + 1,
                    stored.record.password.as_ref().map(|p| Zeroizing::new(p.as_str().to_owned())),
                )
            }
            None => {
                if open.identities.len() >= MAX_RECORDS_PER_KIND {
                    return Err(err(ErrorCode::LimitExceeded, "The vault holds the maximum number of identities."));
                }
                (random_id().map_err(from_vault)?, 1, None)
            }
        };
        let password = match input.password {
            SecretChange::Keep => current,
            SecretChange::Clear => None,
            SecretChange::Set { value } => Some(Zeroizing::new(value)),
        };
        if password.is_none() && key.is_none() && username.is_empty() {
            return Err(invalid("Give the identity a user name, a password or a key."));
        }
        let record = IdentityRecord { label, username, password, key_id: key.as_ref().map(validate::id_text) };
        let content_len = record.label.len()
            + record.username.len()
            + record.password.as_ref().map_or(0, |p| p.len())
            + record.key_id.as_ref().map_or(0, String::len);
        self.write(open, id, KIND_IDENTITY, revision, Some((&record, content_len))).await?;
        let summary = Self::identity_summary(open, &id, &record);
        open.identities.insert(id, Stored { revision, record });
        Ok(summary)
    }

    /// Deletes an identity. Hosts and groups that used it fall back to their own settings; their
    /// references are removed in the same transaction. Returns how many were using it.
    /// Deletes an identity. While hosts or groups name it, this is refused unless `references`
    /// says what happens to them: reassigned to another identity, or the identity removed from
    /// them (BUILD_SPEC §10.2: never a silent fallback to another secret). All in one
    /// transaction. Returns how many hosts and groups changed.
    pub async fn delete_identity(
        &self,
        id: &str,
        references: Option<tyrminal_contracts::IdentityReferences>,
    ) -> Result<u32, IpcError> {
        let id = validate::id(id)?;
        let text = validate::id_text(&id);
        let replacement = match &references {
            Some(tyrminal_contracts::IdentityReferences::Reassign { identity_id }) => {
                Some(validate::id_text(&validate::id(identity_id)?))
            }
            _ => None,
        };
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        let revision =
            open.identities.get(&id).ok_or_else(|| not_found("That identity no longer exists."))?.revision + 1;
        let users: Vec<(Id, &Stored<WorkflowRecord>)> = open
            .workflows
            .iter()
            .filter(|(_, w)| w.record.identity_id.as_deref() == Some(text.as_str()))
            .map(|(wid, w)| (*wid, w))
            .collect();
        if !users.is_empty() && references.is_none() {
            return Err(err(
                ErrorCode::InUse,
                "Hosts or groups use this identity. Choose another identity for them or remove it from them.",
            ));
        }
        if let Some(replacement) = &replacement {
            if *replacement == text {
                return Err(invalid("Choose a different identity to use instead."));
            }
            if !validate::id(replacement).is_ok_and(|r| open.identities.contains_key(&r)) {
                return Err(not_found("The identity to use instead no longer exists."));
            }
        }
        let mut writes: Vec<(Id, u64, Option<WorkflowRecord>)> = Vec::new();
        for (wid, stored) in users {
            let next = WorkflowRecord { identity_id: replacement.clone(), ..stored.record.clone() };
            writes.push((wid, stored.revision + 1, (!next.is_empty()).then_some(next)));
        }
        let mut rows = vec![self.seal_row::<IdentityRecord>(open, id, KIND_IDENTITY, revision, None)?];
        for (wid, revision, record) in &writes {
            rows.push(self.seal_row(
                open,
                *wid,
                KIND_WORKFLOW,
                *revision,
                record.as_ref().map(|r| (r, r.content_len())),
            )?);
        }
        self.db.put_records(rows).await.map_err(from_storage)?;
        let count = u32::try_from(writes.len()).unwrap_or(u32::MAX);
        for (wid, revision, record) in writes {
            match record {
                Some(record) => {
                    open.workflows.insert(wid, Stored { revision, record });
                }
                None => {
                    open.workflows.remove(&wid);
                }
            }
        }
        open.identities.remove(&id);
        Ok(count)
    }

    fn assignment(open: &Open, target: &SettingsTarget) -> IdentityAssignment {
        let identity_id = Self::workflow_of(open, target).and_then(|(_, w)| w.record.identity_id.clone());
        let (effective_identity_id, origin) = match target {
            SettingsTarget::Host { host_id } => validate::id(host_id)
                .ok()
                .and_then(|id| open.hosts.get(&id).map(|h| (id, h)))
                .and_then(|(id, h)| Self::identity_for_host(open, &id, &h.record))
                .map_or((None, None), |(i, _, origin)| (Some(i), Some(origin))),
            SettingsTarget::Group { .. } => (identity_id.clone(), identity_id.as_ref().map(|_| SettingOrigin::Host)),
        };
        IdentityAssignment { target: target.clone(), identity_id, effective_identity_id, origin }
    }

    /// Which identity every host and group uses (directly and, for hosts, in effect).
    pub async fn list_identity_assignments(&self) -> Result<Vec<IdentityAssignment>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let hosts = open.hosts.keys().map(|id| SettingsTarget::Host { host_id: validate::id_text(id) });
        let groups = open.groups.keys().map(|id| SettingsTarget::Group { group_id: validate::id_text(id) });
        Ok(hosts.chain(groups).map(|t| Self::assignment(open, &t)).collect())
    }

    /// Sets (or clears, with `None`) the identity a host or group uses.
    pub async fn set_identity(
        &self,
        target: SettingsTarget,
        identity_id: Option<String>,
    ) -> Result<IdentityAssignment, IpcError> {
        let target = Self::settings_target(target)?;
        let identity = identity_id.as_deref().map(validate::id).transpose()?;
        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;
        Self::require_target(open, &target)?;
        if let Some(identity) = &identity
            && !open.identities.contains_key(identity)
        {
            return Err(not_found("That identity no longer exists."));
        }
        let identity_id = identity.as_ref().map(validate::id_text);
        self.update_workflow(open, &target, |w| WorkflowRecord { identity_id, ..w }).await?;
        Ok(Self::assignment(open, &target))
    }
}

// privilege prompts (KEY-18)
/// Typing an identity's password into a session on an explicit request. Nothing here watches
/// terminal output: a server can print text that looks like a password prompt (BUILD_SPEC §4.5).
impl VaultService {
    /// The identity a host uses now (its own, else its nearest group's when it inherits).
    fn session_identity_of<'a>(
        open: &'a Open,
        host_id: &str,
    ) -> Result<Option<(String, &'a IdentityRecord)>, IpcError> {
        let id = validate::id(host_id)?;
        let host = &open.hosts.get(&id).ok_or_else(|| not_found("That host no longer exists."))?.record;
        Ok(Self::identity_for_host(open, &id, host).map(|(identity_id, record, _)| (identity_id, record)))
    }

    /// Which identity's password a session to `host_id` may insert, read under `generation`.
    pub(crate) async fn session_identity(
        &self,
        generation: u32,
        host_id: &str,
    ) -> Result<Option<tyrminal_contracts::SessionIdentity>, IpcError> {
        let inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_ref().ok_or_else(locked)?;
        Ok(Self::session_identity_of(open, host_id)?.map(|(identity_id, record)| tyrminal_contracts::SessionIdentity {
            identity_id,
            label: record.label.clone(),
            has_password: record.password.is_some(),
        }))
    }

    /// The password of the identity a session's host uses, for an explicit insert. Refused
    /// unless that is still `expected_identity` (the one the user was shown when they chose to
    /// insert it), so a change in between can never send a different identity's password.
    pub(crate) async fn identity_password(
        &self,
        generation: u32,
        host_id: &str,
        expected_identity: &str,
    ) -> Result<Zeroizing<String>, IpcError> {
        let expected = validate::id_text(&validate::id(expected_identity)?);
        let inner = self.inner.lock().await;
        if self.generation() != generation {
            return Err(locked());
        }
        let open = inner.open.as_ref().ok_or_else(locked)?;
        match Self::session_identity_of(open, host_id)? {
            Some((identity_id, record)) if identity_id == expected => match &record.password {
                // Typed into a terminal, a control character is a keystroke (Enter, Ctrl-C, an
                // escape sequence), not part of the password. Refused rather than stripped.
                Some(password) if password.chars().any(char::is_control) => {
                    Err(invalid("This password contains control characters, so it cannot be typed into a terminal."))
                }
                Some(password) => Ok(Zeroizing::new(password.as_str().to_owned())),
                None => Err(invalid("This identity has no stored password.")),
            },
            _ => Err(err(
                ErrorCode::Conflict,
                "The identity of this host changed. Check which identity it uses and try again.",
            )),
        }
    }
}

// identity deletion (BUILD_SPEC §10.2)
impl VaultService {
    /// How a host signs in without the identity `excluded`.
    fn sign_in_without(open: &Open, id: &Id, host: &HostRecord, excluded: &str) -> tyrminal_contracts::SignInAfter {
        use tyrminal_contracts::SignInAfter;
        if let Some((identity_id, record, _)) = Self::identity_for_host_without(open, id, host, Some(excluded)) {
            return SignInAfter::Identity { identity_id, label: record.label.clone() };
        }
        let key = |key_id: &str| SignInAfter::Key {
            key_id: key_id.to_owned(),
            label: validate::id(key_id)
                .ok()
                .and_then(|k| open.ssh_keys.get(&k))
                .map(|k| k.record.label.clone())
                .unwrap_or_default(),
        };
        match inventory::effective(&group_index(open), host).auth {
            EffectiveAuth::Own(StoredAuth::Password { .. }) => SignInAfter::StoredPassword,
            EffectiveAuth::Own(StoredAuth::Key { key_id }) => key(key_id),
            EffectiveAuth::GroupKey(key_id) => key(&key_id),
            EffectiveAuth::Own(StoredAuth::AskPassword | StoredAuth::Inherit) | EffectiveAuth::Ask => {
                SignInAfter::AskPassword
            }
        }
    }

    /// The hosts and groups an identity applies to, and how each host would sign in without it.
    /// Shown before a deletion so the user sees exactly what changes.
    pub async fn identity_usage(&self, id: &str) -> Result<Vec<tyrminal_contracts::IdentityUse>, IpcError> {
        let id = validate::id(id)?;
        let text = validate::id_text(&id);
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        if !open.identities.contains_key(&id) {
            return Err(not_found("That identity no longer exists."));
        }
        let mut uses = Vec::new();
        for (gid, group) in &open.groups {
            let group_text = validate::id_text(gid);
            if Self::workflow_of_group(open, &group_text).and_then(|(_, w)| w.record.identity_id.clone()).as_deref()
                == Some(text.as_str())
            {
                uses.push(tyrminal_contracts::IdentityUse {
                    target: SettingsTarget::Group { group_id: group_text },
                    label: group.record.name.clone(),
                    direct: true,
                    after_removal: None,
                });
            }
        }
        for (hid, host) in &open.hosts {
            let Some((identity_id, _, origin)) = Self::identity_for_host(open, hid, &host.record) else { continue };
            if identity_id != text {
                continue;
            }
            uses.push(tyrminal_contracts::IdentityUse {
                target: SettingsTarget::Host { host_id: validate::id_text(hid) },
                label: host.record.label.clone(),
                direct: matches!(origin, SettingOrigin::Host),
                after_removal: Some(Self::sign_in_without(open, hid, &host.record, &text)),
            });
        }
        uses.sort_by_key(|u| u.label.to_lowercase());
        Ok(uses)
    }
}

// compromised-password check (SEC-11)
impl VaultService {
    /// Every password the vault stores, with where it lives: host passwords, identity
    /// passwords, proxy passwords and remembered key passphrases. Copies in zeroizing buffers,
    /// for the check only.
    pub(crate) async fn stored_secrets(&self) -> Result<Vec<crate::password_check::StoredSecret>, IpcError> {
        use crate::password_check::StoredSecret;
        use tyrminal_contracts::StoredPasswordKind;
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let copy = |kind, label: &str, secret: &Zeroizing<String>| StoredSecret {
            kind,
            label: label.to_owned(),
            secret: Zeroizing::new(secret.as_str().to_owned()),
        };
        let mut out = Vec::new();
        for host in open.hosts.values() {
            if let StoredAuth::Password { password } = &host.record.auth {
                out.push(copy(StoredPasswordKind::Host, &host.record.label, password));
            }
            if let Some(password) = host.record.connection.proxy.as_ref().and_then(|p| p.password.as_ref()) {
                out.push(copy(StoredPasswordKind::Proxy, &host.record.label, password));
            }
        }
        for identity in open.identities.values() {
            if let Some(password) = &identity.record.password {
                out.push(copy(StoredPasswordKind::Identity, &identity.record.label, password));
            }
        }
        for key in open.ssh_keys.values() {
            if let Some(passphrase) = &key.record.passphrase {
                out.push(copy(StoredPasswordKind::KeyPassphrase, &key.record.label, passphrase));
            }
        }
        Ok(out)
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

// privilege prompts (KEY-18)
#[cfg(test)]
mod privilege_tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use tyrminal_contracts::{HostAuthInput, SecretChange, SettingsTarget};

    fn host(label: &str, auth: HostAuthInput, group_id: Option<String>) -> HostInput {
        HostInput {
            id: None,
            label: label.into(),
            address: format!("{label}.example"),
            port: None,
            username: "ops".into(),
            auth,
            group_id,
            tags: Vec::new(),
            protocol: tyrminal_contracts::HostProtocol::Ssh,
            terminal: Default::default(),
            forward_agent: false,
        }
    }

    fn identity(id: Option<String>, label: &str, password: SecretChange) -> IdentityInput {
        IdentityInput { id, label: label.into(), username: "ops".into(), password, key_id: None }
    }

    fn set(value: &str) -> SecretChange {
        SecretChange::Set { value: value.into() }
    }

    #[tokio::test]
    async fn inserted_passwords_belong_to_the_identity_the_user_was_shown() {
        let dir = tempfile::TempDir::new().unwrap();
        let core = crate::Core::open(&dir.path().join("vault.db")).unwrap();
        let v = &core.vault;
        v.create("correct horse battery staple".into()).await.unwrap();
        let generation = v.generation();
        let ops = v.save_identity(identity(None, "Ops", set("sudo-pass"))).await.unwrap();
        let other = v.save_identity(identity(None, "Other", set("other-pass"))).await.unwrap();
        let group = v
            .save_group(GroupInput {
                id: None,
                name: "G".into(),
                parent_id: None,
                username: None,
                port: None,
                key_id: None,
            })
            .await
            .unwrap();
        v.set_identity(SettingsTarget::Group { group_id: group.id.clone() }, Some(ops.id.clone())).await.unwrap();
        let inheriting = v.save_host(host("a", HostAuthInput::Inherit, Some(group.id.clone()))).await.unwrap();
        let plain = v.save_host(host("b", HostAuthInput::AskPassword, None)).await.unwrap();

        // The group's identity reaches the inheriting host.
        let shown = v.session_identity(generation, &inheriting.id).await.unwrap().unwrap();
        assert_eq!(
            (shown.identity_id.as_str(), shown.label.as_str(), shown.has_password),
            (ops.id.as_str(), "Ops", true)
        );
        let password = v.identity_password(generation, &inheriting.id, &ops.id).await.unwrap();
        assert_eq!(password.as_str(), "sudo-pass");

        // A different identity than the host uses now is refused, never substituted.
        let wrong = v.identity_password(generation, &inheriting.id, &other.id).await.unwrap_err();
        assert_eq!(wrong.code, ErrorCode::Conflict);
        assert!(v.session_identity(generation, &plain.id).await.unwrap().is_none());
        assert_eq!(v.identity_password(generation, &plain.id, &ops.id).await.unwrap_err().code, ErrorCode::Conflict);

        // The host's own identity wins once set; the group's is then refused for it.
        v.set_identity(SettingsTarget::Host { host_id: inheriting.id.clone() }, Some(other.id.clone())).await.unwrap();
        assert_eq!(
            v.identity_password(generation, &inheriting.id, &ops.id).await.unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(v.identity_password(generation, &inheriting.id, &other.id).await.unwrap().as_str(), "other-pass");
        v.set_identity(SettingsTarget::Host { host_id: inheriting.id.clone() }, None).await.unwrap();

        // A password with control characters would be keystrokes in a terminal: refused.
        v.save_identity(identity(Some(ops.id.clone()), "Ops", set("pw\rrm -rf ~\r"))).await.unwrap();
        let refused = v.identity_password(generation, &inheriting.id, &ops.id).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidInput);
        assert!(!refused.message.contains("rm -rf"), "the password never appears in an error");

        // No password stored: nothing to insert.
        v.save_identity(identity(Some(ops.id.clone()), "Ops", SecretChange::Clear)).await.unwrap();
        assert!(!v.session_identity(generation, &inheriting.id).await.unwrap().unwrap().has_password);
        assert_eq!(
            v.identity_password(generation, &inheriting.id, &ops.id).await.unwrap_err().code,
            ErrorCode::InvalidInput
        );

        // After a lock, the old generation reads nothing, even once unlocked again.
        v.lock().await;
        v.unlock_with_passphrase("correct horse battery staple".into()).await.unwrap();
        assert_eq!(v.session_identity(generation, &inheriting.id).await.unwrap_err().code, ErrorCode::VaultLocked);
        assert_eq!(
            v.identity_password(generation, &inheriting.id, &ops.id).await.unwrap_err().code,
            ErrorCode::VaultLocked
        );
    }
}

//! Vault lifecycle and the decrypted record index.
//!
//! State machine (BUILD_SPEC §4.4): `UNINITIALIZED → LOCKED → UNLOCKING → UNLOCKED → LOCKING →
//! LOCKED`. One async mutex owns the vault: at most one create/unlock/migration runs at a time,
//! and a second unlock attempt is refused as busy instead of queueing another Argon2id run.
//!
//! Lock generations (INV-07): `lock()` bumps the generation *before* it waits for the mutex.
//! Work that started earlier either completes atomically under the mutex or observes the new
//! generation and discards its result; nothing decrypted is published after a lock.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{Mutex, watch};
use tyrminal_contracts::limits::{MAX_RECENT_HOSTS, MAX_RECORDS_PER_KIND};
use tyrminal_contracts::{
    ErrorCode, HostAuth, HostAuthInput, HostInput, HostSummary, IpcError, KeyImportInput, KeySummary, KnownHostSummary,
    RecoveryKeyIssued, SnippetInput, SnippetSummary, VaultState, VaultStatus,
};
use tyrminal_ssh::{ClientKey, Endpoint, KnownHost, PresentedHostKey};
use tyrminal_storage::{Database, RecordRow, WriteCondition};
use tyrminal_vault::{
    Credential, Id, Passphrase, RecordContext, RecoveryKey, SealedRecord, UnlockedVault, VaultHeader, create_vault,
    random_id,
};
use zeroize::Zeroizing;

use crate::error::{err, from_key, from_storage, from_vault, internal, invalid, locked, not_found};
use crate::records::{
    Decoded, HostRecord, KIND_HOST, KIND_KEY, KIND_KNOWN_HOST, KIND_SNIPPET, KIND_TRUST_EVENT, KeyRecord,
    KnownHostRecord, SnippetRecord, StoredAuth, TrustEventRecord, decode, encode, tombstone,
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
}

impl Open {
    fn new(keys: UnlockedVault) -> Self {
        Self {
            keys,
            hosts: BTreeMap::new(),
            ssh_keys: BTreeMap::new(),
            known_hosts: BTreeMap::new(),
            snippets: BTreeMap::new(),
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

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn busy() -> IpcError {
    err(ErrorCode::VaultBusy, "The vault is busy with another operation. Try again in a moment.")
}

fn host_summary(id: &Id, record: &HostRecord) -> HostSummary {
    HostSummary {
        id: validate::id_text(id),
        label: record.label.clone(),
        address: record.address.clone(),
        port: record.port,
        username: record.username.clone(),
        auth: match &record.auth {
            StoredAuth::AskPassword => HostAuth::AskPassword,
            StoredAuth::Password { .. } => HostAuth::StoredPassword,
            StoredAuth::Key { key_id } => HostAuth::Key { key_id: key_id.clone() },
        },
        last_connected_at: record.last_connected_at,
    }
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
    pub(crate) fn new(db: Database) -> Self {
        let (status, _) = watch::channel(VaultStatus { state: VaultState::Locked, generation: 0 });
        Self {
            db,
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
                tokio::select! {
                    () = tokio::time::sleep(timeout - idle) => {}
                    changed = status.wait_for(|s| s.state != VaultState::Unlocked) => {
                        if changed.is_err() {
                            return;
                        }
                        break;
                    }
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

    async fn write<T: Serialize>(
        &self,
        open: &Open,
        id: Id,
        kind: u16,
        revision: u64,
        record: Option<(&T, usize)>,
    ) -> Result<(), IpcError> {
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
        self.db.put_record(row, condition).await.map_err(from_storage)
    }

    // ---------- hosts ----------

    pub async fn list_hosts(&self) -> Result<Vec<HostSummary>, IpcError> {
        let inner = self.inner.lock().await;
        let open = inner.open.as_ref().ok_or_else(locked)?;
        let mut hosts: Vec<_> = open.hosts.iter().map(|(id, s)| host_summary(id, &s.record)).collect();
        hosts.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        Ok(hosts)
    }

    pub async fn save_host(&self, input: HostInput) -> Result<HostSummary, IpcError> {
        let label = validate::label(&input.label)?;
        let address = validate::address(&input.address)?;
        let port = validate::port(input.port)?;
        let username = validate::username(&input.username)?;
        let existing_id = input.id.as_deref().map(validate::id).transpose()?;

        let mut inner = self.inner.lock().await;
        let open = inner.open.as_mut().ok_or_else(locked)?;

        let auth = match input.auth {
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
        let record = HostRecord { label, address, port, username, auth, last_connected_at };
        let secret_len = match &record.auth {
            StoredAuth::Password { password } => password.len(),
            StoredAuth::Key { key_id } => key_id.len(),
            StoredAuth::AskPassword => 0,
        };
        let content_len = record.label.len() + record.address.len() + record.username.len() + secret_len;
        self.write(open, id, KIND_HOST, revision, Some((&record, content_len))).await?;
        let summary = host_summary(&id, &record);
        open.hosts.insert(id, Stored { revision, record });
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
        let previous = &stored.record;
        let auth = match &previous.auth {
            StoredAuth::AskPassword => StoredAuth::AskPassword,
            StoredAuth::Password { password } => {
                StoredAuth::Password { password: Zeroizing::new(password.as_str().to_owned()) }
            }
            StoredAuth::Key { key_id } => StoredAuth::Key { key_id: key_id.clone() },
        };
        let record = HostRecord {
            label: previous.label.clone(),
            address: previous.address.clone(),
            port: previous.port,
            username: previous.username.clone(),
            auth,
            last_connected_at: Some(now_unix()),
        };
        let secret_len = match &record.auth {
            StoredAuth::Password { password } => password.len(),
            StoredAuth::Key { key_id } => key_id.len(),
            StoredAuth::AskPassword => 0,
        };
        let content_len = record.label.len() + record.address.len() + record.username.len() + secret_len;
        self.write(open, id, KIND_HOST, revision, Some((&record, content_len))).await?;
        open.hosts.insert(id, Stored { revision, record });
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
        if open.hosts.values().any(|h| matches!(&h.record.auth, StoredAuth::Key { key_id } if key_id == id)) {
            return Err(err(ErrorCode::InUse, "Hosts still use this key. Change their sign-in method first."));
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
        let auth = match &host.auth {
            StoredAuth::AskPassword => PlanAuth::Ask,
            StoredAuth::Password { password } => PlanAuth::Password(Zeroizing::new(password.as_str().to_owned())),
            StoredAuth::Key { key_id } => {
                let key = open.ssh_keys.get(&validate::id(key_id)?).ok_or_else(|| {
                    not_found("The key this host uses no longer exists. Edit the host to choose another.")
                })?;
                PlanAuth::Key {
                    private_key: Zeroizing::new(key.record.private_key.as_str().to_owned()),
                    passphrase: key.record.passphrase.as_ref().map(|p| Zeroizing::new(p.as_str().to_owned())),
                }
            }
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
            endpoint: Endpoint::new(host.address.clone(), host.port),
            username: host.username.clone(),
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

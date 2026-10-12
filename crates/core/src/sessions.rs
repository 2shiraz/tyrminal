//! Session registry and the per-session task.
//!
//! A session is an SSH shell or a local terminal. Each has one task that owns the transport and
//! is the only thing that touches it. The renderer holds an opaque session id; every call is
//! checked against the window that opened the session and the vault generation it was opened
//! under (INV-06, INV-07). Prompts (host trust, password) are answered through the same checks.
//!
//! Output flow control (INV-12): the task counts bytes handed to the renderer and stops reading
//! the transport once `MAX_UNACKED_OUTPUT` is outstanding. The renderer acknowledges bytes after
//! its terminal has processed them. A stalled renderer therefore pauses the remote producer
//! through SSH flow control (or the local PTY buffer); nothing is dropped and memory is bounded.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Semaphore, mpsc, oneshot, watch};
use tyrminal_contracts::limits::{
    AUTH_PROMPT_TIMEOUT_SECS, MAX_AUTH_ATTEMPTS, MAX_CONCURRENT_CONNECTS, MAX_DIR_ENTRIES, MAX_SECRET_LEN,
    MAX_SESSIONS, MAX_TERMINAL_DIMENSION, MAX_TERMINAL_INPUT_CHUNK, MAX_TRANSFERS, MAX_UNACKED_OUTPUT,
    TERMINAL_OUTPUT_BATCH, TRUST_PROMPT_TIMEOUT_SECS,
};
use tyrminal_contracts::{
    AuthPromptKind, ConflictChoice, ErrorCode, IpcError, KeyDeployPreview, RemoteEntryKind, RemoteListing,
    SessionEvent, SessionOpened, SessionState, SnippetSendMode, TransferDirection, TransferStarted, TrustDecision,
    VaultStatus,
};
use tyrminal_pty::{PtyEvent, PtyHandle, PtyReader, ShellSpec};
use tyrminal_ssh::{
    AuthOutcome, ClientKey, ConnectOptions, HostKeyRequest, HostKeyVerifier, KeyError, KnownHost, PtyRequest,
    RejectReason, Sftp, ShellEvent, ShellReader, ShellWriter, SshError, TrustStatus, TrustVerdict, VerifiedConnection,
    evaluate,
};
use zeroize::Zeroizing;

use crate::deploy;
use crate::edits;
use crate::error::{err, from_ssh, internal, invalid, not_found};
use crate::files::{self, Download, TransferSink, Upload, from_file};
use crate::folders;
use crate::validate;
use crate::vault::{ConnectionPlan, PlanAuth, VaultService};

/// Where a session's output and events go. Implemented by the adapter over a per-session IPC
/// channel; `false` means the receiver is gone and the session should end.
pub trait SessionSink: Send + Sync + 'static {
    fn output(&self, data: Vec<u8>) -> bool;
    fn event(&self, event: SessionEvent) -> bool;
}

enum Input {
    Data(Vec<u8>),
    Resize(u16, u16),
    Ack(usize),
}

#[derive(Default)]
struct Prompts {
    trust: Option<(String, oneshot::Sender<TrustDecision>)>,
    auth: Option<(String, oneshot::Sender<Option<Zeroizing<String>>>)>,
}

struct Entry {
    owner: String,
    generation: u32,
    input: mpsc::Sender<Input>,
    close: watch::Sender<bool>,
    prompts: Mutex<Prompts>,
    /// The authenticated SSH connection while the session is connected (SSH sessions only),
    /// for side operations on their own channels such as installing a public key.
    connection: Mutex<Option<Arc<VerifiedConnection>>>,
    /// The session's SFTP channel, opened on first use.
    sftp: Mutex<Option<Arc<Sftp>>>,
}

impl Entry {
    fn prompts(&self) -> std::sync::MutexGuard<'_, Prompts> {
        self.prompts.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A running transfer: the window that started it and its cancel switch.
type Transfer = (String, watch::Sender<bool>);

pub struct Sessions {
    vault: Arc<VaultService>,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    connect_slots: Arc<Semaphore>,
    /// Running file transfers: owner window and cancel switch.
    transfers: Arc<Mutex<HashMap<String, Transfer>>>,
    /// Remote files open in local applications.
    edits: edits::Edits,
}

impl core::fmt::Debug for Sessions {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Sessions")
    }
}

pub(crate) fn random_token() -> Result<String, IpcError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| internal())?;
    Ok(validate::id_text(&bytes))
}

fn denied() -> IpcError {
    // One answer for "no such session", "not your session" and "stale generation": a caller
    // probing ids learns nothing about which sessions exist.
    err(ErrorCode::AccessDenied, "That session is not available to this window.")
}

fn closed_event(error: Option<IpcError>, exit_status: Option<u32>) -> SessionEvent {
    SessionEvent::Closed { error, exit_status }
}

impl Sessions {
    pub(crate) fn new(vault: Arc<VaultService>) -> Arc<Self> {
        Arc::new(Self {
            vault,
            entries: Mutex::new(HashMap::new()),
            connect_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTS)),
            transfers: Arc::new(Mutex::new(HashMap::new())),
            edits: edits::Edits::default(),
        })
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Entry>>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Looks up a session for a caller. Ownership and generation are checked on every call.
    fn authorize(&self, owner: &str, session_id: &str) -> Result<Arc<Entry>, IpcError> {
        let entry = self.entries().get(session_id).cloned().ok_or_else(denied)?;
        if entry.owner != owner || entry.generation != self.vault.generation() {
            return Err(denied());
        }
        Ok(entry)
    }

    fn register(&self, owner: &str, generation: u32) -> Result<(String, Arc<Entry>, mpsc::Receiver<Input>), IpcError> {
        let id = random_token()?;
        let (input, input_rx) = mpsc::channel(64);
        let (close, _) = watch::channel(false);
        let entry = Arc::new(Entry {
            owner: owner.to_owned(),
            generation,
            input,
            close,
            prompts: Mutex::new(Prompts::default()),
            connection: Mutex::new(None),
            sftp: Mutex::new(None),
        });
        let mut entries = self.entries();
        if entries.len() >= MAX_SESSIONS {
            return Err(err(ErrorCode::LimitExceeded, "Too many sessions are open. Close one and try again."));
        }
        entries.insert(id.clone(), Arc::clone(&entry));
        Ok((id, entry, input_rx))
    }

    /// Number of live sessions (for diagnostics and tests).
    pub fn count(&self) -> usize {
        self.entries().len()
    }

    /// Opens an SSH session to a saved host. Returns immediately; progress, prompts and the
    /// final result arrive as events on `sink`.
    pub async fn open_ssh(
        self: &Arc<Self>,
        owner: &str,
        host_id: &str,
        cols: u16,
        rows: u16,
        sink: Arc<dyn SessionSink>,
    ) -> Result<SessionOpened, IpcError> {
        let plan = self.vault.connection_plan(host_id).await?;
        let (id, entry, input_rx) = self.register(owner, plan.generation)?;
        let this = Arc::clone(self);
        let session_id = id.clone();
        tokio::spawn(async move {
            let ctx = TaskContext::new(&this, &entry, &sink);
            let body = run_ssh(&ctx, plan, cols, rows, input_rx);
            this.supervise(&session_id, &entry, &sink, body).await;
        });
        Ok(SessionOpened { session_id: id })
    }

    /// Opens a local terminal running the user's login shell.
    pub async fn open_local(
        self: &Arc<Self>,
        owner: &str,
        cols: u16,
        rows: u16,
        sink: Arc<dyn SessionSink>,
    ) -> Result<SessionOpened, IpcError> {
        self.open_local_with(owner, cols, rows, None, sink).await
    }

    /// Opens a local terminal running `shell` when it is one of the installed shells, otherwise
    /// the login shell (a preference may name a shell that has since been removed).
    pub async fn open_local_with(
        self: &Arc<Self>,
        owner: &str,
        cols: u16,
        rows: u16,
        shell: Option<String>,
        sink: Arc<dyn SessionSink>,
    ) -> Result<SessionOpened, IpcError> {
        let generation = self.vault.require_unlocked().await?;
        let shell = shell
            .map(std::path::PathBuf::from)
            .filter(|chosen| tyrminal_pty::available_shells().iter().any(|p| p == chosen));
        let (id, entry, input_rx) = self.register(owner, generation)?;
        let this = Arc::clone(self);
        let session_id = id.clone();
        tokio::spawn(async move {
            let body = run_local(&sink, cols, rows, shell, input_rx);
            this.supervise(&session_id, &entry, &sink, body).await;
        });
        Ok(SessionOpened { session_id: id })
    }

    /// Runs a session body until it finishes, the user closes it, or the vault locks; then
    /// reports the outcome and forgets the session. Dropping the body drops the transport.
    async fn supervise(
        &self,
        session_id: &str,
        entry: &Arc<Entry>,
        sink: &Arc<dyn SessionSink>,
        body: impl Future<Output = Outcome>,
    ) {
        let mut close = entry.close.subscribe();
        let mut vault = self.vault.subscribe();
        let generation = entry.generation;
        let outcome = tokio::select! {
            outcome = body => outcome,
            _ = close.wait_for(|closed| *closed) => Outcome::ended(None),
            () = locked_since(&mut vault, generation) => Outcome::failed(err(
                ErrorCode::VaultLocked,
                "The vault was locked, so this session was closed.",
            )),
        };
        self.entries().remove(session_id);
        *entry.prompts() = Prompts::default();
        // Local copies of files opened for editing in this session are removed with it.
        for folder in self.edits.take_session(session_id) {
            let _ = tokio::fs::remove_dir_all(folder).await;
        }
        sink.event(SessionEvent::State {
            state: if outcome.error.is_some() { SessionState::Failed } else { SessionState::Closed },
        });
        sink.event(closed_event(outcome.error, outcome.exit_status));
    }

    /// The connected SSH link of a session the caller owns.
    fn connection(&self, owner: &str, session_id: &str) -> Result<(Arc<Entry>, Arc<VerifiedConnection>), IpcError> {
        let entry = self.authorize(owner, session_id)?;
        let conn = entry
            .connection
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| err(ErrorCode::InvalidInput, "This works in a connected SSH session only."))?;
        Ok((entry, conn))
    }

    /// Reads the server's authorized keys over the session's verified connection and reports
    /// what installing `key_id` would change. Nothing is written.
    pub async fn deploy_key_preview(
        &self,
        owner: &str,
        session_id: &str,
        key_id: &str,
    ) -> Result<KeyDeployPreview, IpcError> {
        let (entry, conn) = self.connection(owner, session_id)?;
        let line = self.vault.public_key_line(entry.generation, key_id).await?;
        deploy::preview(&conn, &line).await
    }

    /// Appends the key's public line to the server's authorized keys (unless it is already
    /// there), keeping every other line, then reads the file again to confirm.
    pub async fn deploy_key(&self, owner: &str, session_id: &str, key_id: &str) -> Result<KeyDeployPreview, IpcError> {
        let (entry, conn) = self.connection(owner, session_id)?;
        let line = self.vault.public_key_line(entry.generation, key_id).await?;
        deploy::install(&conn, &line).await
    }

    // ---------- files (SFTP) ----------

    /// The session's SFTP channel, opened on first use over its verified connection.
    async fn sftp(&self, owner: &str, session_id: &str) -> Result<(Arc<Entry>, Arc<Sftp>), IpcError> {
        let (entry, conn) = self.connection(owner, session_id)?;
        let cached = entry.sftp.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(sftp) = cached {
            return Ok((entry, sftp));
        }
        let sftp = Arc::new(conn.open_sftp().await.map_err(|e| match e {
            SshError::ChannelDenied | SshError::RequestDenied => {
                err(ErrorCode::ChannelDenied, "This server does not offer file access (SFTP).")
            }
            other => from_ssh(&other),
        })?);
        *entry.sftp.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::clone(&sftp));
        Ok((entry, sftp))
    }

    /// Runs one file operation; a lost SFTP channel is dropped so the next call opens a new one.
    async fn file_op<T, F, Fut>(&self, owner: &str, session_id: &str, op: F) -> Result<T, IpcError>
    where
        F: FnOnce(Arc<Sftp>) -> Fut,
        Fut: std::future::Future<Output = Result<T, tyrminal_ssh::FileError>>,
    {
        let (entry, sftp) = self.sftp(owner, session_id).await?;
        let result = op(sftp).await;
        if matches!(result, Err(tyrminal_ssh::FileError::Lost | tyrminal_ssh::FileError::Protocol)) {
            entry.sftp.lock().unwrap_or_else(|p| p.into_inner()).take();
        }
        result.map_err(from_file)
    }

    /// Lists a remote folder (`None`: the login folder). Folders first, then by name.
    pub async fn list_files(
        &self,
        owner: &str,
        session_id: &str,
        path: Option<&str>,
    ) -> Result<RemoteListing, IpcError> {
        let path = match path {
            Some(p) => files::remote_dir(p)?.to_owned(),
            None => ".".to_owned(),
        };
        let (path, (list, truncated)) = self
            .file_op(owner, session_id, |sftp| async move {
                let path = sftp.canonicalize(&path).await?;
                let list = sftp.read_dir(&path, MAX_DIR_ENTRIES).await?;
                Ok((path, list))
            })
            .await?;
        let mut entries: Vec<_> = list.into_iter().map(|e| files::entry(e.name, &e.attrs)).collect();
        entries.sort_by(|a, b| {
            (a.kind != RemoteEntryKind::Dir).cmp(&(b.kind != RemoteEntryKind::Dir)).then_with(|| a.name.cmp(&b.name))
        });
        Ok(RemoteListing { parent: files::parent(&path), path, entries, truncated })
    }

    pub async fn make_dir(&self, owner: &str, session_id: &str, dir: &str, name: &str) -> Result<(), IpcError> {
        let path = files::join(files::remote_dir(dir)?, name)?;
        self.file_op(owner, session_id, |sftp| async move { sftp.create_dir(&path).await }).await
    }

    /// Renames within one folder. Refuses to replace an existing name.
    pub async fn rename_file(
        &self,
        owner: &str,
        session_id: &str,
        dir: &str,
        from: &str,
        to: &str,
    ) -> Result<(), IpcError> {
        let dir = files::remote_dir(dir)?;
        let (from, to) = (files::join(dir, from)?, files::join(dir, to)?);
        let exists = self.file_op(owner, session_id, |sftp| async move { sftp.exists(&to).await.map(|e| (e, to)) });
        let (exists, to) = exists.await?;
        if exists {
            return Err(err(ErrorCode::Conflict, "Something with that name is already there."));
        }
        self.file_op(owner, session_id, |sftp| async move { sftp.rename(&from, &to).await }).await
    }

    /// Removes a file, a link (not its target) or an empty folder.
    pub async fn remove_file(&self, owner: &str, session_id: &str, dir: &str, name: &str) -> Result<(), IpcError> {
        let path = files::join(files::remote_dir(dir)?, name)?;
        self.file_op(owner, session_id, |sftp| async move {
            if sftp.lstat(&path).await?.kind == tyrminal_ssh::RemoteKind::Dir {
                sftp.remove_dir(&path).await
            } else {
                sftp.remove_file(&path).await
            }
        })
        .await
    }

    pub async fn set_file_mode(
        &self,
        owner: &str,
        session_id: &str,
        dir: &str,
        name: &str,
        mode: u32,
    ) -> Result<(), IpcError> {
        if mode > 0o7777 {
            return Err(invalid("Permissions must be between 0000 and 7777."));
        }
        let path = files::join(files::remote_dir(dir)?, name)?;
        self.file_op(owner, session_id, |sftp| async move { sftp.set_permissions(&path, mode).await }).await
    }

    fn start_transfer(&self, owner: &str) -> Result<(String, watch::Receiver<bool>), IpcError> {
        let id = random_token()?;
        let (cancel, cancelled) = watch::channel(false);
        let mut transfers = self.transfers.lock().unwrap_or_else(|p| p.into_inner());
        if transfers.len() >= MAX_TRANSFERS {
            return Err(err(ErrorCode::LimitExceeded, "Too many transfers are running. Wait for one to finish."));
        }
        transfers.insert(id.clone(), (owner.to_owned(), cancel));
        Ok((id, cancelled))
    }

    /// Downloads `dir/name` (a file, or a folder with everything in it) into `local_dir` (a
    /// folder the user chose natively). A taken name is resolved by `choice`; folders are never
    /// merged or replaced. Checks run before the transfer starts; progress and the result
    /// arrive on `sink`, and the result's name is the one actually used.
    #[allow(clippy::too_many_arguments)]
    pub async fn download(
        &self,
        owner: &str,
        session_id: &str,
        dir: &str,
        name: &str,
        local_dir: PathBuf,
        choice: ConflictChoice,
        sink: Arc<dyn TransferSink>,
    ) -> Result<TransferStarted, IpcError> {
        let remote = files::join(files::remote_dir(dir)?, name)?;
        let (_, sftp) = self.sftp(owner, session_id).await?;
        let token = random_token()?;
        let overwrite = choice == ConflictChoice::Replace;
        let local_name = if choice == ConflictChoice::KeepBoth {
            files::free_local_name(&local_dir, name).await?
        } else {
            name.to_owned()
        };
        let name = local_name.as_str();
        // A folder is copied as a whole tree; anything else must be a regular file.
        if sftp.stat(&remote).await.map_err(from_file)?.kind == tyrminal_ssh::RemoteKind::Dir {
            let job = folders::prepare_download(sftp, remote, local_dir, name, token).await?;
            let total = job.tree.bytes();
            let (id, cancel) = self.start_transfer(owner)?;
            let transfers = Arc::clone(&self.transfers);
            let done_id = id.clone();
            tokio::spawn(async move {
                folders::run_download(job, sink.as_ref(), cancel).await;
                transfers.lock().unwrap_or_else(|p| p.into_inner()).remove(&done_id);
            });
            return Ok(files::started(id, name.to_owned(), TransferDirection::Download, Some(total)));
        }
        let job = Download { sftp, remote, local_dir, name: name.to_owned(), overwrite, token };
        let total = files::prepare_download(&job).await?;
        let (id, cancel) = self.start_transfer(owner)?;
        let transfers = Arc::clone(&self.transfers);
        let done_id = id.clone();
        tokio::spawn(async move {
            files::run_download(job, sink.as_ref(), cancel).await;
            transfers.lock().unwrap_or_else(|p| p.into_inner()).remove(&done_id);
        });
        Ok(files::started(id, name.to_owned(), TransferDirection::Download, total))
    }

    /// Uploads a local file or folder (chosen natively) into the remote folder `dir` under
    /// `name`; a taken name is resolved by `choice` (folders are never merged or replaced).
    #[allow(clippy::too_many_arguments)]
    pub async fn upload(
        &self,
        owner: &str,
        session_id: &str,
        local: PathBuf,
        dir: &str,
        name: &str,
        choice: ConflictChoice,
        sink: Arc<dyn TransferSink>,
    ) -> Result<TransferStarted, IpcError> {
        let dir = files::remote_dir(dir)?.to_owned();
        files::remote_name(name)?;
        let (_, sftp) = self.sftp(owner, session_id).await?;
        let token = random_token()?;
        let overwrite = choice == ConflictChoice::Replace;
        let remote_name = if choice == ConflictChoice::KeepBoth {
            files::free_remote_name(&sftp, &dir, name).await?
        } else {
            name.to_owned()
        };
        let name = remote_name.as_str();
        let is_dir = tokio::fs::metadata(&local).await.is_ok_and(|m| m.is_dir());
        if is_dir {
            files::remote_name(name)?;
            let job = folders::prepare_upload(sftp, local, dir, name, token).await?;
            let total = job.tree.bytes();
            let (id, cancel) = self.start_transfer(owner)?;
            let transfers = Arc::clone(&self.transfers);
            let done_id = id.clone();
            tokio::spawn(async move {
                folders::run_upload(job, sink.as_ref(), cancel).await;
                transfers.lock().unwrap_or_else(|p| p.into_inner()).remove(&done_id);
            });
            return Ok(files::started(id, name.to_owned(), TransferDirection::Upload, Some(total)));
        }
        let job = Upload { sftp, local, dir, name: name.to_owned(), overwrite, token };
        let (total, mode) = files::prepare_upload(&job).await?;
        let (id, cancel) = self.start_transfer(owner)?;
        let transfers = Arc::clone(&self.transfers);
        let done_id = id.clone();
        tokio::spawn(async move {
            files::run_upload(job, mode, sink.as_ref(), cancel).await;
            transfers.lock().unwrap_or_else(|p| p.into_inner()).remove(&done_id);
        });
        Ok(files::started(id, name.to_owned(), TransferDirection::Upload, Some(total)))
    }

    /// Opens a remote file for editing: downloads it into its own owner-only folder under
    /// `edit_root` and returns the local path for the adapter to hand to the OS, plus its status.
    pub async fn edit_open(
        &self,
        owner: &str,
        session_id: &str,
        dir: &str,
        name: &str,
        edit_root: &std::path::Path,
    ) -> Result<(PathBuf, tyrminal_contracts::EditStatus), IpcError> {
        let remote = files::join(files::remote_dir(dir)?, name)?;
        if !files::local_name_ok(name) {
            return Err(invalid("That name cannot be used for a file on this computer."));
        }
        let (_, sftp) = self.sftp(owner, session_id).await?;
        let attrs = sftp.stat(&remote).await.map_err(from_file)?;
        if attrs.kind != tyrminal_ssh::RemoteKind::File {
            return Err(invalid("Only files can be opened for editing."));
        }
        if attrs.size.is_some_and(|n| n > edits::MAX_EDIT_SIZE) {
            return Err(edits::too_large());
        }
        let id = random_token()?;
        let folder = edit_root.join(&id);
        edits::create_private_dir_all(&folder).await.map_err(|e| files::local_io(&e))?;
        let file = folder.join(name);
        let downloaded = async {
            let mut out = files::create_private(&file).await.map_err(|e| files::local_io(&e))?;
            let sink = files::NullSink;
            let mut progress = files::Progress::new(&sink);
            let (_never, mut cancel) = tokio::sync::watch::channel(false);
            files::pull(&sftp, &remote, &mut out, &mut progress, &mut cancel).await.map_err(files::Stop::into_error)?;
            drop(out);
            edits::hash_file(&file).await
        }
        .await;
        let saved_hash = match downloaded {
            Ok(hash) => hash,
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&folder).await;
                return Err(e);
            }
        };
        self.edits.insert(
            id.clone(),
            edits::Edit {
                owner: owner.to_owned(),
                session_id: session_id.to_owned(),
                remote,
                name: name.to_owned(),
                folder,
                file: file.clone(),
                remote_size: attrs.size,
                remote_modified: attrs.modified,
                permissions: attrs.permissions,
                saved_hash,
            },
        );
        let status = tyrminal_contracts::EditStatus { edit_id: id, name: name.to_owned(), changed: false };
        Ok((file, status))
    }

    /// Whether the local copy of an open edit has changed since it was opened or last saved.
    pub async fn edit_status(&self, owner: &str, edit_id: &str) -> Result<tyrminal_contracts::EditStatus, IpcError> {
        let (name, file, saved) =
            self.edits.with(owner, edit_id, |e| (e.name.clone(), e.file.clone(), e.saved_hash))?;
        edits::status(edit_id, &name, &file, saved).await
    }

    /// Uploads the local copy over the remote file. Refused with a conflict when the server's
    /// copy changed since it was opened, unless `overwrite`.
    pub async fn edit_save(
        &self,
        owner: &str,
        edit_id: &str,
        overwrite: bool,
    ) -> Result<tyrminal_contracts::EditStatus, IpcError> {
        let (session_id, remote, name, file) = self
            .edits
            .with(owner, edit_id, |e| (e.session_id.clone(), e.remote.clone(), e.name.clone(), e.file.clone()))?;
        let (_, sftp) = self.sftp(owner, &session_id).await?;
        let now = sftp.stat(&remote).await.map_err(from_file)?;
        if !overwrite {
            let (same_attrs, saved) = self.edits.with(owner, edit_id, |e| (e.remote_unchanged(&now), e.saved_hash))?;
            // Modification times are whole seconds: compare the content too.
            if !same_attrs || edits::hash_remote(&sftp, &remote).await? != saved {
                return Err(edits::changed_on_server());
            }
        }
        let hash = edits::hash_file(&file).await?;
        let dir = files::parent(&remote).unwrap_or_else(|| "/".to_owned());
        let temp = files::join(&dir, &files::temp_name(&name, &random_token()?))?;
        let sink = files::NullSink;
        let mut progress = files::Progress::new(&sink);
        let (_never, mut cancel) = tokio::sync::watch::channel(false);
        files::push(&sftp, &file, &temp, &mut progress, &mut cancel).await.map_err(files::Stop::into_error)?;
        let replaced = async {
            sftp.set_permissions(&temp, edits::sftp_mode(&now)).await?;
            sftp.remove_file(&remote).await?;
            sftp.rename(&temp, &remote).await
        }
        .await;
        if let Err(e) = replaced {
            let _ = sftp.remove_file(&temp).await;
            return Err(from_file(e));
        }
        let after = sftp.stat(&remote).await.map_err(from_file)?;
        self.edits.with(owner, edit_id, |e| {
            e.remote_size = after.size;
            e.remote_modified = after.modified;
            e.permissions = after.permissions;
            e.saved_hash = hash;
        })?;
        Ok(tyrminal_contracts::EditStatus { edit_id: edit_id.to_owned(), name, changed: false })
    }

    /// Stops editing: forgets the edit and removes its local copy (unsaved changes are lost).
    pub async fn edit_close(&self, owner: &str, edit_id: &str) -> Result<(), IpcError> {
        let folder = self.edits.take(owner, edit_id)?;
        tokio::fs::remove_dir_all(folder)
            .await
            .or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(files::local_io(&e)) })
    }

    /// Stops a running transfer; its temporary data is removed and nothing replaces the target.
    pub fn cancel_transfer(&self, owner: &str, transfer_id: &str) -> Result<(), IpcError> {
        let transfers = self.transfers.lock().unwrap_or_else(|p| p.into_inner());
        match transfers.get(transfer_id) {
            Some((who, cancel)) if who == owner => {
                let _ = cancel.send(true);
                Ok(())
            }
            _ => Err(denied()),
        }
    }

    pub async fn write(&self, owner: &str, session_id: &str, data: Vec<u8>) -> Result<(), IpcError> {
        if data.len() > MAX_TERMINAL_INPUT_CHUNK {
            return Err(err(ErrorCode::LimitExceeded, "That input is too large to send at once."));
        }
        let entry = self.authorize(owner, session_id)?;
        if data.is_empty() {
            return Ok(());
        }
        entry.input.send(Input::Data(data)).await.map_err(|_| denied())
    }

    /// Sends a saved snippet to a session the caller owns. The text is read from the vault here,
    /// at the session's generation, so it never has to round-trip through the renderer and
    /// nothing is sent after a lock. Nothing in the core runs a snippet on its own: this is only
    /// reached from an explicit Paste or Run.
    pub async fn send_snippet(
        &self,
        owner: &str,
        session_id: &str,
        snippet_id: &str,
        mode: SnippetSendMode,
        bracketed: bool,
    ) -> Result<(), IpcError> {
        // Ownership first: a wrong window learns nothing about which snippets exist.
        let entry = self.authorize(owner, session_id)?;
        let text = self.vault.snippet_text(entry.generation, snippet_id).await?;
        let bytes = snippet_bytes(&text, mode, bracketed);
        for chunk in bytes.chunks(MAX_TERMINAL_INPUT_CHUNK) {
            entry.input.send(Input::Data(chunk.to_vec())).await.map_err(|_| denied())?;
        }
        Ok(())
    }

    pub async fn resize(&self, owner: &str, session_id: &str, cols: u16, rows: u16) -> Result<(), IpcError> {
        if cols == 0 || rows == 0 || cols > MAX_TERMINAL_DIMENSION || rows > MAX_TERMINAL_DIMENSION {
            return Err(invalid("The terminal size is out of range."));
        }
        let entry = self.authorize(owner, session_id)?;
        entry.input.send(Input::Resize(cols, rows)).await.map_err(|_| denied())
    }

    /// The renderer reports that its terminal has processed `bytes` of output.
    pub async fn ack(&self, owner: &str, session_id: &str, bytes: u32) -> Result<(), IpcError> {
        let entry = self.authorize(owner, session_id)?;
        entry.input.send(Input::Ack(bytes as usize)).await.map_err(|_| denied())
    }

    pub fn close(&self, owner: &str, session_id: &str) -> Result<(), IpcError> {
        let entry = self.authorize(owner, session_id)?;
        entry.close.send_replace(true);
        Ok(())
    }

    /// Closes every session a window owns (the window was closed or destroyed).
    pub fn close_all_for_owner(&self, owner: &str) {
        for entry in self.entries().values().filter(|e| e.owner == owner) {
            entry.close.send_replace(true);
        }
    }

    pub fn answer_trust(
        &self,
        owner: &str,
        session_id: &str,
        prompt_id: &str,
        decision: TrustDecision,
    ) -> Result<(), IpcError> {
        let entry = self.authorize(owner, session_id)?;
        let mut prompts = entry.prompts();
        match prompts.trust.take() {
            Some((id, reply)) if id == prompt_id => {
                let _ = reply.send(decision);
                Ok(())
            }
            other => {
                // A stale or guessed prompt id answers nothing and leaves the real prompt pending.
                prompts.trust = other;
                Err(not_found("That prompt is no longer waiting for an answer."))
            }
        }
    }

    /// Supplies (or, with `None`, cancels) a password or key passphrase the session asked for.
    pub fn answer_auth(
        &self,
        owner: &str,
        session_id: &str,
        prompt_id: &str,
        secret: Option<String>,
    ) -> Result<(), IpcError> {
        let secret = secret.map(Zeroizing::new);
        if secret.as_ref().is_some_and(|s| s.is_empty() || s.len() > MAX_SECRET_LEN) {
            return Err(invalid("Enter a password of at most 1024 bytes."));
        }
        let entry = self.authorize(owner, session_id)?;
        let mut prompts = entry.prompts();
        match prompts.auth.take() {
            Some((id, reply)) if id == prompt_id => {
                let _ = reply.send(secret);
                Ok(())
            }
            other => {
                prompts.auth = other;
                Err(not_found("That prompt is no longer waiting for an answer."))
            }
        }
    }
}

/// The bytes a snippet sends. Lines end in carriage returns, as typed. `Paste` wraps the text in
/// bracketed-paste markers when the terminal enabled that mode, so a shell inserts it without
/// executing; snippet text is validated to contain no ESC, so it cannot close the bracket early.
/// `Run` sends the lines and a final Enter.
pub(crate) fn snippet_bytes(text: &str, mode: SnippetSendMode, bracketed: bool) -> Zeroizing<Vec<u8>> {
    let body = text.trim_end_matches('\n').replace('\n', "\r");
    let mut out = Zeroizing::new(Vec::with_capacity(body.len() + 12));
    match mode {
        SnippetSendMode::Paste if bracketed => {
            out.extend_from_slice(b"\x1b[200~");
            out.extend_from_slice(body.as_bytes());
            out.extend_from_slice(b"\x1b[201~");
        }
        SnippetSendMode::Paste => out.extend_from_slice(body.as_bytes()),
        SnippetSendMode::Run => {
            out.extend_from_slice(body.as_bytes());
            out.push(b'\r');
        }
    }
    out
}

/// Resolves once the vault generation differs from the one a session was created under.
async fn locked_since(vault: &mut watch::Receiver<VaultStatus>, generation: u32) {
    if vault.wait_for(|status| status.generation != generation).await.is_err() {
        // The vault service is gone: treat as locked.
    }
}

struct Outcome {
    error: Option<IpcError>,
    exit_status: Option<u32>,
}

impl Outcome {
    fn ended(exit_status: Option<u32>) -> Self {
        Self { error: None, exit_status }
    }
    fn failed(error: IpcError) -> Self {
        Self { error: Some(error), exit_status: None }
    }
}

/// What the session task shares with its helpers.
struct TaskContext {
    vault: Arc<VaultService>,
    connect_slots: Arc<Semaphore>,
    entry: Arc<Entry>,
    sink: Arc<dyn SessionSink>,
}

impl TaskContext {
    fn new(sessions: &Arc<Sessions>, entry: &Arc<Entry>, sink: &Arc<dyn SessionSink>) -> Self {
        Self {
            vault: Arc::clone(&sessions.vault),
            connect_slots: Arc::clone(&sessions.connect_slots),
            entry: Arc::clone(entry),
            sink: Arc::clone(sink),
        }
    }

    fn state(&self, state: SessionState) {
        self.sink.event(SessionEvent::State { state });
    }

    /// Asks the user for a secret and waits, bounded. `None` means cancelled or timed out.
    async fn ask_secret(&self, kind: AuthPromptKind, username: &str, attempt: u32) -> Option<Zeroizing<String>> {
        self.ask(kind, username, attempt, None, false).await
    }

    /// `message` is sanitized server text for keyboard-interactive prompts.
    async fn ask(
        &self,
        kind: AuthPromptKind,
        username: &str,
        attempt: u32,
        message: Option<String>,
        echo: bool,
    ) -> Option<Zeroizing<String>> {
        let prompt_id = random_token().ok()?;
        let (reply, answer) = oneshot::channel();
        self.entry.prompts().auth = Some((prompt_id.clone(), reply));
        self.sink.event(SessionEvent::AuthPrompt {
            prompt_id,
            kind,
            username: username.to_owned(),
            attempt,
            max_attempts: MAX_AUTH_ATTEMPTS,
            message,
            echo,
        });
        let result = tokio::time::timeout(Duration::from_secs(AUTH_PROMPT_TIMEOUT_SECS), answer).await;
        self.entry.prompts().auth = None;
        result.ok()?.ok()?
    }
}

/// The application's host-key policy: known keys pass, changed keys are refused outright, and an
/// unknown key waits for an explicit decision. Pressing "connect" is never implicit trust.
struct PromptingVerifier {
    known: Vec<(KnownHost, String)>,
    generation: u32,
    vault: Arc<VaultService>,
    entry: Arc<Entry>,
    sink: Arc<dyn SessionSink>,
}

impl HostKeyVerifier for PromptingVerifier {
    async fn verify(&mut self, request: &HostKeyRequest) -> TrustVerdict {
        self.sink.event(SessionEvent::State { state: SessionState::VerifyingHost });
        let known: Vec<KnownHost> = self.known.iter().map(|(k, _)| k.clone()).collect();
        match evaluate(&known, &request.endpoint, &request.key) {
            TrustStatus::Trusted => TrustVerdict::Accept,
            TrustStatus::Changed { known_keys } => {
                let trusted_fingerprints = self
                    .known
                    .iter()
                    .filter(|(k, _)| known_keys.contains(&k.public_key))
                    .map(|(_, fingerprint)| fingerprint.clone())
                    .collect();
                self.sink.event(SessionEvent::HostKeyChanged {
                    host: request.endpoint.host.clone(),
                    port: request.endpoint.port,
                    algorithm: request.key.algorithm.clone(),
                    presented_fingerprint: request.key.fingerprint.clone(),
                    trusted_fingerprints,
                });
                TrustVerdict::Reject(RejectReason::Changed)
            }
            TrustStatus::Unknown => {
                let Ok(prompt_id) = random_token() else {
                    return TrustVerdict::Reject(RejectReason::Cancelled);
                };
                let (reply, answer) = oneshot::channel();
                self.entry.prompts().trust = Some((prompt_id.clone(), reply));
                self.sink.event(SessionEvent::TrustPrompt {
                    prompt_id,
                    host: request.endpoint.host.clone(),
                    port: request.endpoint.port,
                    resolved_address: request.resolved.map(|a| a.ip().to_string()),
                    algorithm: request.key.algorithm.clone(),
                    fingerprint: request.key.fingerprint.clone(),
                });
                let decision = tokio::time::timeout(Duration::from_secs(TRUST_PROMPT_TIMEOUT_SECS), answer).await;
                self.entry.prompts().trust = None;
                match decision {
                    Ok(Ok(TrustDecision::Once)) => TrustVerdict::Accept,
                    Ok(Ok(TrustDecision::Always)) => {
                        // If trust cannot be recorded (the vault locked meanwhile), do not connect.
                        match self.vault.add_known_host(self.generation, &request.endpoint, &request.key).await {
                            Ok(()) => TrustVerdict::Accept,
                            Err(_) => TrustVerdict::Reject(RejectReason::Cancelled),
                        }
                    }
                    _ => TrustVerdict::Reject(RejectReason::Cancelled),
                }
            }
        }
    }
}

fn auth_failed() -> IpcError {
    err(ErrorCode::AuthFailed, "The server did not accept the sign-in. Check the user name and credentials.")
}

fn cancelled() -> IpcError {
    err(ErrorCode::Cancelled, "The connection was cancelled.")
}

/// Authenticates according to the plan. Stored secrets are tried once; the user is then asked,
/// at most `MAX_AUTH_ATTEMPTS` times. Nothing is ever typed into the terminal on the user's
/// behalf, and no prompt text from the server triggers a stored password.
async fn authenticate(
    ctx: &TaskContext,
    conn: &mut VerifiedConnection,
    username: &str,
    auth: PlanAuth,
) -> Result<(), IpcError> {
    match auth {
        PlanAuth::Key { private_key, passphrase } => {
            let mut passphrase = passphrase;
            let mut attempt = 0;
            let key = loop {
                match ClientKey::from_openssh(&private_key, passphrase.as_deref().map(String::as_str)) {
                    Ok(key) => break key,
                    Err(KeyError::PassphraseRequired | KeyError::WrongPassphrase) if attempt < MAX_AUTH_ATTEMPTS => {
                        attempt += 1;
                        passphrase = Some(
                            ctx.ask_secret(AuthPromptKind::KeyPassphrase, username, attempt)
                                .await
                                .ok_or_else(cancelled)?,
                        );
                    }
                    Err(KeyError::PassphraseRequired | KeyError::WrongPassphrase) => {
                        return Err(err(ErrorCode::WrongCredential, "The key's passphrase was not correct."));
                    }
                    Err(_) => return Err(err(ErrorCode::KeyInvalid, "The stored key could not be read.")),
                }
            };
            match conn.authenticate_key(username, &key).await.map_err(|e| from_ssh(&e))? {
                AuthOutcome::Success => Ok(()),
                AuthOutcome::Failure { .. } => Err(auth_failed()),
            }
        }
        PlanAuth::Password(stored) => {
            if conn.authenticate_password(username, stored).await.map_err(|e| from_ssh(&e))?.is_success() {
                return Ok(());
            }
            // The stored password was refused: fall through to asking, never silently loop.
            ask_password(ctx, conn, username).await
        }
        PlanAuth::Ask => ask_password(ctx, conn, username).await,
    }
}

async fn ask_password(ctx: &TaskContext, conn: &mut VerifiedConnection, username: &str) -> Result<(), IpcError> {
    // Servers that take only keyboard-interactive (PAM, one-time codes) get its prompts instead.
    let methods = match conn.auth_methods(username).await.map_err(|e| from_ssh(&e))? {
        AuthOutcome::Success => return Ok(()),
        AuthOutcome::Failure { remaining_methods, .. } => remaining_methods,
    };
    let offers = |m: &str| methods.iter().any(|x| x == m);
    if !offers("password") && offers("keyboard-interactive") {
        return ask_keyboard_interactive(ctx, conn, username).await;
    }
    for attempt in 1..=MAX_AUTH_ATTEMPTS {
        let password = ctx.ask_secret(AuthPromptKind::Password, username, attempt).await.ok_or_else(cancelled)?;
        if conn.authenticate_password(username, password).await.map_err(|e| from_ssh(&e))?.is_success() {
            return Ok(());
        }
    }
    Err(auth_failed())
}

/// Keyboard-interactive: each server prompt is shown to the user on its own, with the server's
/// sanitized text. Nothing is answered automatically, and no stored secret is ever sent here.
async fn ask_keyboard_interactive(
    ctx: &TaskContext,
    conn: &mut VerifiedConnection,
    username: &str,
) -> Result<(), IpcError> {
    for attempt in 1..=MAX_AUTH_ATTEMPTS {
        let outcome = conn
            .authenticate_keyboard_interactive(username, |round| async move {
                let mut answers = Vec::with_capacity(round.prompts.len());
                for prompt in &round.prompts {
                    let message = [round.name.as_str(), round.instructions.as_str(), prompt.text.as_str()]
                        .iter()
                        .filter(|t| !t.is_empty())
                        .copied()
                        .collect::<Vec<_>>()
                        .join("\n");
                    let answer = ctx
                        .ask(AuthPromptKind::KeyboardInteractive, username, attempt, Some(message), prompt.echo)
                        .await?;
                    answers.push(answer);
                }
                Some(answers)
            })
            .await
            .map_err(|e| from_ssh(&e))?;
        if outcome.is_success() {
            return Ok(());
        }
    }
    Err(auth_failed())
}

async fn run_ssh(
    ctx: &TaskContext,
    plan: ConnectionPlan,
    cols: u16,
    rows: u16,
    input: mpsc::Receiver<Input>,
) -> Outcome {
    let (host_id, generation) = (plan.host_id.clone(), plan.generation);
    match connect_ssh(ctx, plan, cols, rows).await {
        Ok((conn, reader, writer)) => {
            if let Some(n) = conn.negotiated() {
                ctx.sink.event(SessionEvent::Negotiated {
                    kex: n.kex,
                    host_key: n.host_key,
                    cipher: n.cipher,
                    mac: n.mac,
                    strict_kex: n.strict_kex,
                });
            }
            // Shared before `Connected` is reported, so side operations (files, key install) work
            // as soon as the renderer sees the session connected. `conn` stays alive for the whole
            // pump; dropping it closes the transport. It is taken back when the shell ends.
            let conn = Arc::new(conn);
            *ctx.entry.connection.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::clone(&conn));
            ctx.state(SessionState::Connected);
            // Recent connections. Best effort: failing to record must not end a working session.
            // Its own task, because closing the session drops this future: cancelled between the
            // database commit and the in-memory revision update, the next edit of the host would
            // see a false conflict.
            let vault = Arc::clone(&ctx.vault);
            tokio::spawn(async move {
                let _ = vault.mark_connected(generation, &host_id).await;
            });
            let outcome = pump(Transport::Ssh { reader, writer }, &ctx.sink, input).await;
            ctx.entry.connection.lock().unwrap_or_else(|p| p.into_inner()).take();
            ctx.entry.sftp.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Ok(conn) = Arc::try_unwrap(conn) {
                conn.disconnect().await;
            }
            outcome
        }
        Err(error) => Outcome::failed(error),
    }
}

async fn connect_ssh(
    ctx: &TaskContext,
    plan: ConnectionPlan,
    cols: u16,
    rows: u16,
) -> Result<(VerifiedConnection, ShellReader, ShellWriter), IpcError> {
    ctx.state(SessionState::Connecting);
    // Bounds simultaneous connection attempts; released when this function returns.
    let _slot = ctx.connect_slots.acquire().await.map_err(|_| internal())?;

    let verifier = PromptingVerifier {
        known: plan.known_hosts,
        generation: plan.generation,
        vault: Arc::clone(&ctx.vault),
        entry: Arc::clone(&ctx.entry),
        sink: Arc::clone(&ctx.sink),
    };
    let options = ConnectOptions::new(plan.endpoint);
    let mut conn = tyrminal_ssh::connect(&options, verifier).await.map_err(|e: SshError| from_ssh(&e))?;

    if let Some(text) = conn.banner() {
        ctx.sink.event(SessionEvent::Banner { text });
    }
    ctx.state(SessionState::Authenticating);
    authenticate(ctx, &mut conn, &plan.username, plan.auth).await?;

    ctx.state(SessionState::OpeningChannel);
    let pty = PtyRequest { term: "xterm-256color".into(), cols: u32::from(cols), rows: u32::from(rows) };
    let (reader, writer) = conn.open_shell(&pty).await.map_err(|e| from_ssh(&e))?;
    Ok((conn, reader, writer))
}

async fn run_local(
    sink: &Arc<dyn SessionSink>,
    cols: u16,
    rows: u16,
    shell: Option<std::path::PathBuf>,
    input: mpsc::Receiver<Input>,
) -> Outcome {
    let program = shell.unwrap_or_else(tyrminal_pty::default_shell);
    let mut spec = ShellSpec::new(&program);
    spec.cols = cols;
    spec.rows = rows;
    // Start in the user's home directory when it is known and valid.
    spec.cwd = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(Into::into)
        .filter(|p: &std::path::PathBuf| p.is_absolute() && p.is_dir());
    // A login shell, as terminal applications conventionally start (where the shell has one).
    spec.args = tyrminal_pty::login_args(&program);
    match tyrminal_pty::spawn(&spec) {
        Ok((reader, handle)) => {
            sink.event(SessionEvent::State { state: SessionState::Connected });
            pump(Transport::Local { reader, handle, recheck_size: None }, sink, input).await
        }
        Err(_) => Outcome::failed(err(ErrorCode::IoError, "The local shell could not be started.")),
    }
}

enum Transport {
    Ssh { reader: ShellReader, writer: ShellWriter },
    Local { reader: PtyReader, handle: PtyHandle, recheck_size: Option<tokio::time::Instant> },
}

enum TransportEvent {
    Output(Vec<u8>),
    Exit(Option<u32>),
    /// The link dropped without the remote side ending the session.
    Lost,
}

impl Transport {
    /// Next transport event; `None` when the transport has ended. Cancel-safe.
    async fn next(&mut self) -> Option<TransportEvent> {
        match self {
            Self::Ssh { reader, .. } => loop {
                match reader.next().await? {
                    ShellEvent::Output(data) | ShellEvent::ExtendedOutput(data) => {
                        return Some(TransportEvent::Output(data.to_vec()));
                    }
                    ShellEvent::ExitStatus(code) => return Some(TransportEvent::Exit(Some(code))),
                    ShellEvent::ExitSignal(_) => return Some(TransportEvent::Exit(None)),
                    ShellEvent::Eof => {}
                    ShellEvent::ConnectionLost => return Some(TransportEvent::Lost),
                }
            },
            Self::Local { reader, .. } => match reader.next().await? {
                PtyEvent::Output(data) => Some(TransportEvent::Output(data)),
                PtyEvent::Exit(code) => Some(TransportEvent::Exit(code)),
            },
        }
    }

    async fn write(&self, data: &[u8]) -> bool {
        match self {
            Self::Ssh { writer, .. } => writer.write(data).await.is_ok(),
            Self::Local { handle, .. } => handle.write(data).await.is_ok(),
        }
    }

    async fn resize(&mut self, cols: u16, rows: u16) {
        match self {
            Self::Ssh { writer, .. } => {
                let _ = writer.resize(u32::from(cols), u32::from(rows)).await;
            }
            Self::Local { handle, recheck_size, .. } => {
                let _ = handle.resize(cols, rows);
                // Some shells overwrite a resize that races their own terminal setup; verify
                // shortly afterwards (see `PtyHandle::ensure_size`).
                *recheck_size = Some(tokio::time::Instant::now() + Duration::from_millis(150));
            }
        }
    }

    fn recheck_deadline(&self) -> Option<tokio::time::Instant> {
        match self {
            Self::Local { recheck_size, .. } => *recheck_size,
            Self::Ssh { .. } => None,
        }
    }

    fn recheck(&mut self) {
        if let Self::Local { handle, recheck_size, .. } = self {
            *recheck_size = match handle.ensure_size() {
                // It had been overwritten: check once more in case the race repeats.
                Ok(true) => Some(tokio::time::Instant::now() + Duration::from_millis(150)),
                _ => None,
            };
        }
    }
}

fn lost() -> Outcome {
    Outcome::failed(err(ErrorCode::Disconnected, "The connection was lost."))
}

/// Moves bytes between the transport and the renderer until either side ends.
async fn pump(mut transport: Transport, sink: &Arc<dyn SessionSink>, mut input: mpsc::Receiver<Input>) -> Outcome {
    let mut unacked = 0usize;
    let mut exit_status = None;
    loop {
        let recheck = transport.recheck_deadline();
        tokio::select! {
            biased;
            message = input.recv() => match message {
                // The registry entry (and with it the sender) is gone.
                None => return Outcome::ended(exit_status),
                Some(Input::Data(data)) => {
                    if !transport.write(&data).await {
                        return lost();
                    }
                }
                Some(Input::Resize(cols, rows)) => transport.resize(cols, rows).await,
                Some(Input::Ack(bytes)) => unacked = unacked.saturating_sub(bytes),
            },
            () = async { tokio::time::sleep_until(recheck.unwrap_or_else(tokio::time::Instant::now)).await }, if recheck.is_some() => {
                transport.recheck();
            }
            // Not polled while the renderer is behind: this is what applies backpressure.
            event = transport.next(), if unacked < MAX_UNACKED_OUTPUT => match event {
                None => return Outcome::ended(exit_status),
                Some(TransportEvent::Exit(code)) => exit_status = code,
                Some(TransportEvent::Lost) => return lost(),
                Some(TransportEvent::Output(mut batch)) => {
                    // Coalesce what is immediately available into one message, bounded in size
                    // and by a 1 ms wait, to keep IPC message counts down during bulk output.
                    let mut ended = false;
                    let mut dropped = false;
                    while batch.len() < TERMINAL_OUTPUT_BATCH {
                        match tokio::time::timeout(Duration::from_millis(1), transport.next()).await {
                            Ok(Some(TransportEvent::Output(more))) => batch.extend_from_slice(&more),
                            Ok(Some(TransportEvent::Exit(code))) => exit_status = code,
                            Ok(Some(TransportEvent::Lost)) => { dropped = true; break; }
                            Ok(None) => { ended = true; break; }
                            Err(_) => break,
                        }
                    }
                    unacked += batch.len();
                    // The output that arrived before a drop is still shown.
                    if !sink.output(batch) {
                        return Outcome::ended(exit_status);
                    }
                    if dropped {
                        return lost();
                    }
                    if ended {
                        return Outcome::ended(exit_status);
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod snippet_tests {
    use super::*;

    #[test]
    fn snippets_are_typed_lines_and_paste_is_bracketed_only_when_asked() {
        let text = "uname -a\ndf -h\n";
        assert_eq!(&*snippet_bytes(text, SnippetSendMode::Run, false), b"uname -a\rdf -h\r");
        assert_eq!(&*snippet_bytes(text, SnippetSendMode::Run, true), b"uname -a\rdf -h\r");
        assert_eq!(&*snippet_bytes(text, SnippetSendMode::Paste, false), b"uname -a\rdf -h");
        assert_eq!(&*snippet_bytes(text, SnippetSendMode::Paste, true), b"\x1b[200~uname -a\rdf -h\x1b[201~");
    }
}

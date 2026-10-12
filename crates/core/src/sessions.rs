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
    AuthPromptKind, ConflictChoice, ErrorCode, HostProtocol, IpcError, KeyDeployPreview, RemoteEntryKind,
    RemoteListing, SessionEvent, SessionOpened, SessionState, SnippetSendMode, TransferDirection, TransferStarted,
    TrustDecision, VaultStatus,
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
use crate::handoff::{HANDOFF_TTL, Relay};
use crate::streams::Streams;
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
    /// Bytes the owning window processed, with the handoff epoch it was authorized in.
    Ack(usize, u64),
    /// Re-evaluate flow control (a handoff changed the outstanding count).
    Wake,
}

#[derive(Default)]
struct Prompts {
    trust: Option<(String, oneshot::Sender<TrustDecision>)>,
    auth: Option<(String, oneshot::Sender<Option<Zeroizing<String>>>)>,
}

pub(crate) struct Entry {
    /// The window that may use the session; changes only by an accepted handoff.
    owner: Mutex<String>,
    pub(crate) generation: u32,
    /// Where output and events go, with the flow-control count (see `handoff`).
    relay: Arc<Relay>,
    /// What happened while connecting (CON-15; no secrets, see `connlog`).
    log: crate::connlog::ConnLog,
    input: mpsc::Sender<Input>,
    close: watch::Sender<bool>,
    prompts: Mutex<Prompts>,
    /// The authenticated SSH connection while the session is connected (SSH sessions only),
    /// for side operations on their own channels such as installing a public key.
    connection: Mutex<Option<Arc<VerifiedConnection>>>,
    /// The session's SFTP channel, opened on first use.
    sftp: Mutex<Option<Arc<Sftp>>>,
    // agent B: tunnels and history
    /// The saved host an SSH session was opened for (`None` for local terminals).
    pub(crate) host_id: Option<String>,
}

impl Entry {
    fn prompts(&self) -> std::sync::MutexGuard<'_, Prompts> {
        self.prompts.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn owner(&self) -> std::sync::MutexGuard<'_, String> {
        self.owner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A pending offer to move a session to another window.
struct Offer {
    session_id: String,
    to: String,
    expires: tokio::time::Instant,
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
    /// Pending window handoffs by single-use token.
    offers: Mutex<HashMap<String, Offer>>,
    /// Uploads whose content the window sends (dropped files).
    streams: Arc<Streams>,
    /// Connection logs of recently ended sessions (session id, owner, lines), so a failed
    /// connection can still be explained.
    ended_logs: Mutex<std::collections::VecDeque<(String, String, Vec<String>)>>,
    // agent B: tunnels and history
    pub(crate) tunnel_runs: crate::tunnels::TunnelRuns,
    // agent D: inventory and snippets
    /// Snippet runs on exec channels, with their cancel switches.
    snippet_runs: crate::snippet_runs::Runs,
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
            offers: Mutex::new(HashMap::new()),
            streams: Arc::new(Streams::default()),
            ended_logs: Mutex::new(std::collections::VecDeque::new()),
            // agent B: tunnels and history
            tunnel_runs: crate::tunnels::TunnelRuns::default(),
            // agent D: inventory and snippets
            snippet_runs: crate::snippet_runs::Runs::default(),
        })
    }

    // agent B: tunnels and history
    pub(crate) fn vault(&self) -> &Arc<VaultService> {
        &self.vault
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Entry>>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Looks up a session for a caller. Ownership and generation are checked on every call.
    fn authorize(&self, owner: &str, session_id: &str) -> Result<Arc<Entry>, IpcError> {
        self.authorize_epoch(owner, session_id).map(|(entry, _)| entry)
    }

    /// As `authorize`, also returning the handoff epoch read under the same ownership check, so
    /// a request from a window that has just handed the session on can never count for the next.
    fn authorize_epoch(&self, owner: &str, session_id: &str) -> Result<(Arc<Entry>, u64), IpcError> {
        let entry = self.entries().get(session_id).cloned().ok_or_else(denied)?;
        let current = entry.owner();
        if *current != owner || entry.generation != self.vault.generation() {
            return Err(denied());
        }
        let epoch = entry.relay.epoch();
        drop(current);
        Ok((entry, epoch))
    }

    fn offers(&self) -> std::sync::MutexGuard<'_, HashMap<String, Offer>> {
        self.offers.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[allow(clippy::type_complexity)]
    fn register(
        &self,
        owner: &str,
        generation: u32,
        sink: Arc<dyn SessionSink>,
        host_id: Option<String>,
    ) -> Result<(String, Arc<Entry>, mpsc::Receiver<Input>), IpcError> {
        let id = random_token()?;
        let (input, input_rx) = mpsc::channel(64);
        let (close, _) = watch::channel(false);
        let entry = Arc::new(Entry {
            owner: Mutex::new(owner.to_owned()),
            generation,
            relay: Relay::new(sink),
            log: crate::connlog::ConnLog::new(),
            input,
            close,
            prompts: Mutex::new(Prompts::default()),
            connection: Mutex::new(None),
            sftp: Mutex::new(None),
            host_id,
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
        // Hosts reached over Telnet or a serial line open through their own transport.
        let endpoint = self.vault.host_endpoint(host_id).await?;
        let terminal = endpoint.terminal;
        let forward_agent = endpoint.forward_agent;
        match endpoint.protocol {
            HostProtocol::Ssh => {}
            HostProtocol::Telnet => return self.open_telnet(owner, endpoint, cols, rows, sink),
            HostProtocol::Serial { settings } => {
                return self.open_serial(owner, endpoint.generation, settings, terminal.encoding, sink);
            }
        }
        let plan = self.vault.connection_plan(host_id).await?;
        let (id, entry, input_rx) = self.register(owner, plan.generation, sink, Some(plan.host_id.clone()))?;
        let sink: Arc<dyn SessionSink> = entry.relay.clone();
        let this = Arc::clone(self);
        let session_id = id.clone();
        tokio::spawn(async move {
            let ctx = TaskContext { terminal, forward_agent, ..TaskContext::new(&this, &session_id, &entry, &sink) };
            let body = run_ssh(&ctx, plan, cols, rows, input_rx);
            this.supervise(&session_id, &entry, &sink, body).await;
        });
        Ok(SessionOpened { session_id: id })
    }

    /// A Telnet session: says first that nothing is encrypted, then connects (no host-key check
    /// exists in Telnet, and no credential is sent by Tyrminal; the server's own prompts ask).
    fn open_telnet(
        self: &Arc<Self>,
        owner: &str,
        endpoint: crate::vault::HostEndpoint,
        cols: u16,
        rows: u16,
        sink: Arc<dyn SessionSink>,
    ) -> Result<SessionOpened, IpcError> {
        let (id, entry, input_rx) = self.register(owner, endpoint.generation, sink, None)?;
        let relay = Arc::clone(&entry.relay);
        let sink: Arc<dyn SessionSink> = relay.clone();
        let this = Arc::clone(self);
        let session_id = id.clone();
        tokio::spawn(async move {
            entry
                .log
                .note(&format!("connecting to {}:{} with Telnet (not encrypted)", endpoint.address, endpoint.port));
            let body = run_telnet(&sink, &relay, endpoint, cols, rows, input_rx);
            this.supervise(&session_id, &entry, &sink, body).await;
        });
        Ok(SessionOpened { session_id: id })
    }

    /// A terminal on a serial device of this computer.
    fn open_serial(
        self: &Arc<Self>,
        owner: &str,
        generation: u32,
        settings: tyrminal_contracts::SerialSettings,
        encoding: tyrminal_contracts::TerminalEncoding,
        sink: Arc<dyn SessionSink>,
    ) -> Result<SessionOpened, IpcError> {
        let (id, entry, input_rx) = self.register(owner, generation, sink, None)?;
        let relay = Arc::clone(&entry.relay);
        let sink: Arc<dyn SessionSink> = relay.clone();
        let this = Arc::clone(self);
        let session_id = id.clone();
        tokio::spawn(async move {
            let transcoder = crate::transcode::Transcoder::new(encoding);
            let body = async {
                sink.event(SessionEvent::State { state: SessionState::Connecting });
                entry.log.note(&format!(
                    "opening serial port {} at {} baud, {} data bits, parity {:?}, {} stop bits, flow control {:?}",
                    settings.path,
                    settings.baud,
                    settings.data_bits,
                    settings.parity,
                    settings.stop_bits,
                    settings.flow_control
                ));
                match crate::serial::open(&settings) {
                    Ok(link) => {
                        sink.event(SessionEvent::State { state: SessionState::Connected });
                        pump(Transport::Serial(link), &relay, input_rx, transcoder).await
                    }
                    Err(error) => Outcome::failed(error),
                }
            };
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
        let (id, entry, input_rx) = self.register(owner, generation, sink, None)?;
        let relay = Arc::clone(&entry.relay);
        let sink: Arc<dyn SessionSink> = relay.clone();
        let this = Arc::clone(self);
        let session_id = id.clone();
        tokio::spawn(async move {
            let body = run_local(&sink, &relay, cols, rows, shell, input_rx);
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
        if let Some(error) = &outcome.error {
            entry.log.note(&format!("ended: {}", error.message));
        }
        {
            let mut ended = self.ended_logs.lock().unwrap_or_else(|p| p.into_inner());
            if ended.len() >= MAX_ENDED_LOGS {
                ended.pop_front();
            }
            ended.push_back((session_id.to_owned(), entry.owner().clone(), entry.log.lines()));
        }
        // agent B: tunnels and history
        self.tunnel_runs.session_ended(session_id).await;
        *entry.prompts() = Prompts::default();
        self.streams.abort_where(None, Some(session_id)).await;
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
    pub(crate) fn connection(
        &self,
        owner: &str,
        session_id: &str,
    ) -> Result<(Arc<Entry>, Arc<VerifiedConnection>), IpcError> {
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

    /// Starts an upload of `size` bytes whose content the window sends with `upload_chunk`
    /// (files dropped from the desktop, whose paths the window never learns).
    #[allow(clippy::too_many_arguments)]
    pub async fn upload_begin(
        &self,
        owner: &str,
        session_id: &str,
        dir: &str,
        name: &str,
        size: u64,
        choice: ConflictChoice,
    ) -> Result<tyrminal_contracts::StreamUpload, IpcError> {
        let (_, sftp) = self.sftp(owner, session_id).await?;
        let id = random_token()?;
        self.streams.begin(owner, session_id, sftp, dir, name, size, choice, id).await
    }

    /// The next piece of a started upload; `offset` is where the previous piece ended.
    pub async fn upload_chunk(&self, owner: &str, upload_id: &str, offset: u64, data: &[u8]) -> Result<(), IpcError> {
        self.streams.chunk(owner, upload_id, offset, data).await
    }

    /// Completes an upload once every declared byte arrived; returns the name used.
    pub async fn upload_finish(&self, owner: &str, upload_id: &str) -> Result<String, IpcError> {
        self.streams.finish(owner, upload_id).await
    }

    /// Stops an upload and removes its partial file.
    pub async fn upload_abort(&self, owner: &str, upload_id: &str) {
        self.streams.abort(owner, upload_id).await;
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

    /// Copies `src_dir/name` (a file or a folder) from one session's server to the folder
    /// `dst_dir` on another session's server, streaming through this process. A taken name is
    /// resolved by `choice`; folders are never merged or replaced.
    #[allow(clippy::too_many_arguments)]
    pub async fn copy_between(
        &self,
        owner: &str,
        src_session: &str,
        src_dir: &str,
        name: &str,
        dst_session: &str,
        dst_dir: &str,
        choice: ConflictChoice,
        sink: Arc<dyn TransferSink>,
    ) -> Result<TransferStarted, IpcError> {
        let src_path = files::join(files::remote_dir(src_dir)?, name)?;
        let dst_dir = files::remote_dir(dst_dir)?.to_owned();
        let (_, src) = self.sftp(owner, src_session).await?;
        let (_, dst) = self.sftp(owner, dst_session).await?;
        let final_name = if choice == ConflictChoice::KeepBoth {
            files::free_remote_name(&dst, &dst_dir, name).await?
        } else {
            name.to_owned()
        };
        let (job, total) = crate::remote_copy::prepare(
            src,
            src_path,
            dst,
            dst_dir,
            final_name.clone(),
            choice == ConflictChoice::Replace,
            random_token()?,
        )
        .await?;
        let (id, cancel) = self.start_transfer(owner)?;
        let transfers = Arc::clone(&self.transfers);
        let done_id = id.clone();
        tokio::spawn(async move {
            crate::remote_copy::run(job, sink.as_ref(), cancel).await;
            transfers.lock().unwrap_or_else(|p| p.into_inner()).remove(&done_id);
        });
        Ok(files::started(id, final_name, TransferDirection::Copy, Some(total)))
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
    /// The connection log of a session the caller owns (CON-15), also for a while after it ended.
    pub fn diagnostics(&self, owner: &str, session_id: &str) -> Result<Vec<String>, IpcError> {
        if let Ok(entry) = self.authorize(owner, session_id) {
            return Ok(entry.log.lines());
        }
        let ended = self.ended_logs.lock().unwrap_or_else(|p| p.into_inner());
        ended
            .iter()
            .find(|(id, o, _)| id == session_id && o == owner)
            .map(|(_, _, lines)| lines.clone())
            .ok_or_else(denied)
    }

    pub async fn ack(&self, owner: &str, session_id: &str, bytes: u32) -> Result<(), IpcError> {
        let (entry, epoch) = self.authorize_epoch(owner, session_id)?;
        entry.input.send(Input::Ack(bytes as usize, epoch)).await.map_err(|_| denied())
    }

    pub fn close(&self, owner: &str, session_id: &str) -> Result<(), IpcError> {
        let entry = self.authorize(owner, session_id)?;
        entry.close.send_replace(true);
        Ok(())
    }

    /// Closes every session a window owns (the window was closed or destroyed).
    pub fn close_all_for_owner(&self, owner: &str) {
        for entry in self.entries().values().filter(|e| *e.owner() == owner) {
            entry.close.send_replace(true);
        }
        let streams = Arc::clone(&self.streams);
        let window = owner.to_owned();
        tokio::spawn(async move { streams.abort_where(Some(&window), None).await });
        // Offers to this window lapse now; their sessions stay with the windows that own them.
        let lapsed: Vec<String> = self.offers().iter().filter(|(_, o)| o.to == owner).map(|(t, _)| t.clone()).collect();
        for token in lapsed {
            self.lapse_offer(&token);
        }
    }

    /// Offers a session the caller owns to the window labelled `to`. Returns a single-use token
    /// for that window to accept within `HANDOFF_TTL`; until then output is held for it and the
    /// caller keeps the session (and its input) as before.
    pub fn offer_handoff(self: &Arc<Self>, owner: &str, session_id: &str, to: &str) -> Result<String, IpcError> {
        self.offer_handoff_within(owner, session_id, to, HANDOFF_TTL)
    }

    /// As `offer_handoff` with a shorter expiry (never longer than `HANDOFF_TTL`).
    pub fn offer_handoff_within(
        self: &Arc<Self>,
        owner: &str,
        session_id: &str,
        to: &str,
        ttl: Duration,
    ) -> Result<String, IpcError> {
        let ttl = ttl.min(HANDOFF_TTL);
        if to.is_empty() || to.len() > 64 || to == owner {
            return Err(invalid("A session can only be moved to another window."));
        }
        let entry = self.authorize(owner, session_id)?;
        let token = random_token()?;
        {
            let mut offers = self.offers();
            if offers.values().any(|o| o.session_id == session_id) {
                return Err(err(ErrorCode::InUse, "This session is already being moved to another window."));
            }
            let expires = tokio::time::Instant::now() + ttl;
            offers.insert(token.clone(), Offer { session_id: session_id.to_owned(), to: to.to_owned(), expires });
            entry.relay.hold();
        }
        let this = Arc::clone(self);
        let lapse = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ttl).await;
            this.lapse_offer(&lapse);
        });
        Ok(token)
    }

    /// Withdraws a pending offer (if still pending): held output goes back to the owner.
    fn lapse_offer(&self, token: &str) {
        let Some(offer) = self.offers().remove(token) else { return };
        if let Some(entry) = self.entries().get(&offer.session_id).cloned() {
            entry.relay.release();
        }
    }

    /// Takes over a session offered to the calling window: from now on only the caller may use
    /// it, and its output (starting with whatever was held) goes to `sink`. The token is
    /// single-use and refused for any other window, after it expires, or once the session ended.
    pub fn accept_handoff(&self, caller: &str, token: &str, sink: Arc<dyn SessionSink>) -> Result<String, IpcError> {
        let refused = || err(ErrorCode::AccessDenied, "That session is no longer waiting to move to this window.");
        let offer = {
            let mut offers = self.offers();
            match offers.get(token) {
                // A token presented by the wrong window stays valid for the right one.
                Some(o) if o.to == caller => offers.remove(token).ok_or_else(refused)?,
                _ => return Err(refused()),
            }
        };
        let entry = self.entries().get(&offer.session_id).cloned();
        let Some(entry) = entry.filter(|e| e.generation == self.vault.generation()) else {
            return Err(refused());
        };
        if tokio::time::Instant::now() >= offer.expires {
            entry.relay.release();
            return Err(refused());
        }
        {
            let mut owner = entry.owner();
            *owner = caller.to_owned();
            entry.relay.switch(sink);
        }
        // Flow control changed; if the queue is full, queued input wakes the task anyway.
        let _ = entry.input.try_send(Input::Wake);
        Ok(offer.session_id)
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
    /// Encoding and terminal type of the host (UTF-8 and xterm-256color by default).
    terminal: tyrminal_contracts::HostTerminal,
    /// Offer the host's key to the destination server's agent requests (CON-11; off by default).
    forward_agent: bool,
    sessions: Arc<Sessions>,
    session_id: String,
    /// The jump-chain hop being connected, for prompts (`None` for a direct connection).
    hop: Mutex<Option<tyrminal_contracts::ChainPosition>>,
}

impl TaskContext {
    fn new(sessions: &Arc<Sessions>, session_id: &str, entry: &Arc<Entry>, sink: &Arc<dyn SessionSink>) -> Self {
        Self {
            vault: Arc::clone(&sessions.vault),
            connect_slots: Arc::clone(&sessions.connect_slots),
            entry: Arc::clone(entry),
            sink: Arc::clone(sink),
            terminal: tyrminal_contracts::HostTerminal::default(),
            forward_agent: false,
            sessions: Arc::clone(sessions),
            session_id: session_id.to_owned(),
            hop: Mutex::new(None),
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
            hop: self.hop.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        });
        let result = tokio::time::timeout(Duration::from_secs(AUTH_PROMPT_TIMEOUT_SECS), answer).await;
        self.entry.prompts().auth = None;
        result.ok()?.ok()?
    }
}

/// The application's host-key policy: known keys pass, changed keys are refused outright, and an
/// unknown key waits for an explicit decision. Pressing "connect" is never implicit trust.
struct PromptingVerifier {
    /// Which hop of a jump-host chain this verifier decides for, if any.
    hop: Option<tyrminal_contracts::ChainPosition>,
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
                    hop: self.hop.clone(),
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
                    hop: self.hop.clone(),
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
) -> Result<Option<ClientKey>, IpcError> {
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
                // The key is kept only for agent forwarding, if the host has it on.
                AuthOutcome::Success => Ok(Some(key)),
                AuthOutcome::Failure { .. } => Err(auth_failed()),
            }
        }
        PlanAuth::Password(stored) => {
            if conn.authenticate_password(username, stored).await.map_err(|e| from_ssh(&e))?.is_success() {
                return Ok(None);
            }
            // The stored password was refused: fall through to asking, never silently loop.
            ctx.entry.log.note("the server refused the stored password; asking instead");
            ask_password(ctx, conn, username).await.map(|()| None)
        }
        PlanAuth::Ask => ask_password(ctx, conn, username).await.map(|()| None),
    }
}

async fn ask_password(ctx: &TaskContext, conn: &mut VerifiedConnection, username: &str) -> Result<(), IpcError> {
    // Servers that take only keyboard-interactive (PAM, one-time codes) get its prompts instead.
    let methods = match conn.auth_methods(username).await.map_err(|e| from_ssh(&e))? {
        AuthOutcome::Success => return Ok(()),
        AuthOutcome::Failure { remaining_methods, .. } => {
            ctx.entry.log.note(&format!("server offers: {}", remaining_methods.join(", ")));
            remaining_methods
        }
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
    let plan_host = plan.host_id.clone();
    match connect_ssh(ctx, plan, cols, rows).await {
        Ok((Linked { conn, hops }, reader, writer)) => {
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
            // Saved tunnels that start with every connection to this host. Their own task, so
            // the shell is usable at once; it holds the connection only while starting them.
            let (sessions, owner, session_id) =
                (Arc::clone(&ctx.sessions), ctx.entry.owner().clone(), ctx.session_id.clone());
            let (tunnel_conn, tunnel_host) = (Arc::clone(&conn), plan_host.clone());
            tokio::spawn(async move {
                sessions.start_auto_tunnels(&owner, &session_id, &tunnel_host, generation, &tunnel_conn).await;
            });
            let transcoder = crate::transcode::Transcoder::new(ctx.terminal.encoding);
            let outcome = pump(Transport::Ssh { reader, writer }, &ctx.entry.relay, input, transcoder).await;
            ctx.entry.connection.lock().unwrap_or_else(|p| p.into_inner()).take();
            ctx.entry.sftp.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Ok(conn) = Arc::try_unwrap(conn) {
                conn.disconnect().await;
            }
            // Then the jump hosts, innermost first.
            for hop in hops.into_iter().rev() {
                hop.disconnect().await;
            }
            outcome
        }
        Err(error) => Outcome::failed(error),
    }
}

/// A session's transport: the connection to the host and, for a jump-host chain, the hops it
/// runs through (first hop first). The hops must stay alive as long as the connection.
struct Linked {
    conn: VerifiedConnection,
    hops: Vec<VerifiedConnection>,
}

fn hop_error(e: &SshError) -> IpcError {
    match e {
        SshError::ChannelDenied => {
            err(ErrorCode::ChannelDenied, "A jump host refused to connect to the next host in the chain.")
        }
        SshError::Unreachable => err(ErrorCode::Unreachable, "A jump host could not reach the next host in the chain."),
        other => from_ssh(other),
    }
}

async fn connect_ssh(
    ctx: &TaskContext,
    plan: ConnectionPlan,
    cols: u16,
    rows: u16,
) -> Result<(Linked, ShellReader, ShellWriter), IpcError> {
    ctx.state(SessionState::Connecting);
    // Bounds simultaneous connection attempts; released when this function returns.
    let _slot = ctx.connect_slots.acquire().await.map_err(|_| internal())?;

    // Jump hosts first, then the host. Every hop gets its own key exchange, host-key decision and
    // authentication, in order: nothing is sent to a hop before its key is trusted, and nothing
    // is sent to the next hop before the previous one is (INV-02 for every hop).
    // A proxy applies to the connection that leaves this computer: the first hop's own setting.
    let env = plan.env;
    let first = (plan.label, plan.endpoint, plan.username, plan.auth, plan.proxy);
    let total = u32::try_from(plan.jumps.len() + 1).unwrap_or(u32::MAX);
    let hops = plan.jumps.into_iter().map(|hop| (hop.label, hop.endpoint, hop.username, hop.auth, hop.proxy));
    let mut chain: Vec<VerifiedConnection> = Vec::new();
    for (index, (label, endpoint, username, auth, proxy)) in hops.chain(std::iter::once(first)).enumerate() {
        // Prompts name the hop when there is more than one, so a jump host's trust or password
        // prompt cannot be mistaken for the destination's.
        let hop = (total > 1).then(|| tyrminal_contracts::ChainPosition {
            index: u32::try_from(index + 1).unwrap_or(u32::MAX),
            total,
            label,
        });
        *ctx.hop.lock().unwrap_or_else(|p| p.into_inner()) = hop.clone();
        if !chain.is_empty() {
            ctx.state(SessionState::Connecting);
        }
        let log = &ctx.entry.log;
        let step = hop.as_ref().map(|h| format!("hop {}/{} ({}): ", h.index, h.total, h.label)).unwrap_or_default();
        let route = match (chain.last(), &proxy) {
            (None, None) => "directly".to_owned(),
            (None, Some(p)) => format!("through a {:?} proxy at {}:{}", p.kind, p.host, p.port),
            (Some(_), _) => "through the previous hop".to_owned(),
        };
        log.note(&format!("{step}connecting to {}:{} {route}", endpoint.host, endpoint.port));
        let verifier = PromptingVerifier {
            hop,
            known: plan.known_hosts.clone(),
            generation: plan.generation,
            vault: Arc::clone(&ctx.vault),
            entry: Arc::clone(&ctx.entry),
            sink: Arc::clone(&ctx.sink),
        };
        let options = ConnectOptions::new(endpoint.clone());
        let mut conn = match (chain.last(), proxy) {
            (None, None) => tyrminal_ssh::connect(&options, verifier).await.map_err(|e: SshError| from_ssh(&e))?,
            (None, Some(proxy)) => {
                let stream = tyrminal_ssh::connect_via_proxy(&proxy, &endpoint.host, endpoint.port)
                    .await
                    .map_err(crate::tunnels::proxy_error)?;
                tyrminal_ssh::connect_stream(&options, stream, None, verifier).await.map_err(|e| from_ssh(&e))?
            }
            (Some(via), _) => {
                let stream = via.open_hop(&endpoint.host, endpoint.port).await.map_err(|e| hop_error(&e))?;
                tyrminal_ssh::connect_stream(&options, stream, None, verifier).await.map_err(|e| from_ssh(&e))?
            }
        };
        if let Some(n) = conn.negotiated() {
            log.note(&format!(
                "{step}key exchange {}, host key {}, cipher {}{}, strict kex {}",
                n.kex,
                n.host_key,
                n.cipher,
                if n.mac.is_empty() { String::new() } else { format!(", mac {}", n.mac) },
                if n.strict_kex { "on" } else { "off" }
            ));
        }
        log.note(&format!("{step}host key {} trusted", conn.host_key().fingerprint));
        if let Some(text) = conn.banner() {
            ctx.sink.event(SessionEvent::Banner { text });
        }
        ctx.state(SessionState::Authenticating);
        let method = match &auth {
            PlanAuth::Key { .. } => "a key",
            PlanAuth::Password(_) => "the stored password",
            PlanAuth::Ask => "a password or one-time code you enter",
        };
        log.note(&format!("{step}signing in as {} with {method}", username));
        let is_destination = chain.len() + 1 == total as usize;
        match authenticate(ctx, &mut conn, &username, auth).await {
            Ok(key) => {
                log.note(&format!("{step}signed in"));
                // Agent forwarding (CON-11): only to the destination, only when the host has it
                // on, and only with the key the host signs in with.
                if is_destination && ctx.forward_agent {
                    match key {
                        Some(key) => {
                            let sink = Arc::clone(&ctx.sink);
                            let entry = Arc::clone(&ctx.entry);
                            conn.forward_agent(tyrminal_ssh::ForwardedAgent::new(
                                &key,
                                Arc::new(move || {
                                    entry.log.note("the server used your forwarded key to sign");
                                    sink.event(SessionEvent::Banner {
                                        text: "The server used your forwarded key to sign in somewhere.\n".into(),
                                    });
                                }),
                            ));
                            log.note("agent forwarding is on for this session (only this host's key)");
                        }
                        None => log
                            .note("agent forwarding is on but this host signs in without a key; nothing is forwarded"),
                    }
                }
            }
            Err(e) => {
                log.note(&format!("{step}sign-in failed: {}", e.message));
                return Err(e);
            }
        }
        chain.push(conn);
    }
    let conn = chain.pop().ok_or_else(internal)?;

    ctx.state(SessionState::OpeningChannel);
    let pty = PtyRequest { term: ctx.terminal.term.term().into(), cols: u32::from(cols), rows: u32::from(rows) };
    // Environment variables (SNP-11..13): requested before the shell; every refusal is reported.
    let (reader, writer, rejected) = conn.open_shell_with_env(&pty, &env).await.map_err(|e| from_ssh(&e))?;
    ctx.entry.log.note(&format!("shell opened ({}, {cols}x{rows})", pty.term));
    if !env.is_empty() {
        ctx.sink.event(SessionEvent::Environment { sent: env.iter().map(|(n, _)| n.clone()).collect(), rejected });
    }
    Ok((Linked { conn, hops: chain }, reader, writer))
}

async fn run_local(
    sink: &Arc<dyn SessionSink>,
    relay: &Relay,
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
            pump(Transport::Local { reader, handle, recheck_size: None }, relay, input, None).await
        }
        Err(_) => Outcome::failed(err(ErrorCode::IoError, "The local shell could not be started.")),
    }
}

/// Ended sessions whose connection logs are kept.
const MAX_ENDED_LOGS: usize = 16;

/// Telnet connections that take longer than this to answer are given up.
const TELNET_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

async fn run_telnet(
    sink: &Arc<dyn SessionSink>,
    relay: &Relay,
    endpoint: crate::vault::HostEndpoint,
    cols: u16,
    rows: u16,
    input: mpsc::Receiver<Input>,
) -> Outcome {
    sink.event(SessionEvent::Banner {
        text: "Telnet is not encrypted: anything you type here, including passwords, can be read by others on the network.\n".into(),
    });
    sink.event(SessionEvent::State { state: SessionState::Connecting });
    let host = endpoint.address.trim_start_matches('[').trim_end_matches(']').to_owned();
    let stream = match tokio::time::timeout(
        TELNET_CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect((host.as_str(), endpoint.port)),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(_)) => return Outcome::failed(err(ErrorCode::Disconnected, "The Telnet server could not be reached.")),
        Err(_) => return Outcome::failed(err(ErrorCode::Timeout, "The Telnet server did not answer in time.")),
    };
    let _ = stream.set_nodelay(true);
    let (reader, writer) = stream.into_split();
    sink.event(SessionEvent::State { state: SessionState::Connected });
    let terminal = endpoint.terminal;
    let codec = crate::telnet::Codec::new(cols, rows, terminal.term.term());
    let link = TelnetLink { reader, writer, codec, replies: Vec::new() };
    pump(Transport::Telnet(Box::new(link)), relay, input, crate::transcode::Transcoder::new(terminal.encoding)).await
}

enum Transport {
    Ssh { reader: ShellReader, writer: ShellWriter },
    Local { reader: PtyReader, handle: PtyHandle, recheck_size: Option<tokio::time::Instant> },
    Telnet(Box<TelnetLink>),
    Serial(crate::serial::SerialLink),
}

/// A Telnet connection: the socket halves, the protocol state and replies not yet sent.
struct TelnetLink {
    reader: tokio::net::tcp::OwnedReadHalf,
    writer: tokio::net::tcp::OwnedWriteHalf,
    codec: crate::telnet::Codec,
    replies: Vec<u8>,
}

impl TelnetLink {
    /// Sends what can be sent of the pending negotiation replies without waiting (they are a
    /// few bytes; whatever does not fit now goes with the next read or keystroke).
    fn flush_replies(&mut self) -> bool {
        while !self.replies.is_empty() {
            match self.writer.try_write(&self.replies) {
                Ok(n) => {
                    self.replies.drain(..n);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return true,
                Err(_) => return false,
            }
        }
        true
    }
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
            Self::Serial(link) => match link.events.recv().await? {
                crate::serial::SerialEvent::Data(data) => Some(TransportEvent::Output(data)),
                crate::serial::SerialEvent::Lost => Some(TransportEvent::Lost),
            },
            Self::Telnet(link) => loop {
                if !link.flush_replies() {
                    return Some(TransportEvent::Lost);
                }
                let mut buf = vec![0u8; 16 * 1024];
                // `read` is cancel-safe; decoding happens only after it completed.
                let n = match tokio::io::AsyncReadExt::read(&mut link.reader, &mut buf).await {
                    Ok(0) => return None,
                    Ok(n) => n,
                    Err(_) => return Some(TransportEvent::Lost),
                };
                let mut output = Vec::with_capacity(n);
                let link = &mut **link;
                link.codec.receive(&buf[..n], &mut output, &mut link.replies);
                if !link.flush_replies() {
                    return Some(TransportEvent::Lost);
                }
                if !output.is_empty() {
                    return Some(TransportEvent::Output(output));
                }
            },
        }
    }

    async fn write(&mut self, data: &[u8]) -> bool {
        match self {
            Self::Ssh { writer, .. } => writer.write(data).await.is_ok(),
            Self::Local { handle, .. } => handle.write(data).await.is_ok(),
            Self::Serial(link) => link.write(data).await,
            Self::Telnet(link) => {
                let encoded = crate::telnet::encode_input(data);
                link.flush_replies() && tokio::io::AsyncWriteExt::write_all(&mut link.writer, &encoded).await.is_ok()
            }
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
            // A serial line has no window size.
            Self::Serial(_) => {}
            Self::Telnet(link) => {
                let size = link.codec.resize(cols, rows);
                link.replies.extend_from_slice(&size);
                let _ = link.flush_replies();
            }
        }
    }

    fn recheck_deadline(&self) -> Option<tokio::time::Instant> {
        match self {
            Self::Local { recheck_size, .. } => *recheck_size,
            Self::Ssh { .. } | Self::Telnet(_) | Self::Serial(_) => None,
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
async fn pump(
    mut transport: Transport,
    sink: &Relay,
    mut input: mpsc::Receiver<Input>,
    mut transcoder: Option<crate::transcode::Transcoder>,
) -> Outcome {
    let mut exit_status = None;
    loop {
        let recheck = transport.recheck_deadline();
        tokio::select! {
            biased;
            message = input.recv() => match message {
                // The registry entry (and with it the sender) is gone.
                None => return Outcome::ended(exit_status),
                Some(Input::Data(data)) => {
                    let data = match transcoder.as_mut() {
                        Some(t) => t.encode(&data),
                        None => data,
                    };
                    if !transport.write(&data).await {
                        return lost();
                    }
                }
                Some(Input::Resize(cols, rows)) => transport.resize(cols, rows).await,
                Some(Input::Ack(bytes, epoch)) => sink.ack(epoch, bytes),
                Some(Input::Wake) => {}
            },
            () = async { tokio::time::sleep_until(recheck.unwrap_or_else(tokio::time::Instant::now)).await }, if recheck.is_some() => {
                transport.recheck();
            }
            // Not polled while the renderer is behind: this is what applies backpressure.
            event = transport.next(), if sink.unacked() < MAX_UNACKED_OUTPUT => match event {
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
                    if let Some(t) = transcoder.as_mut() {
                        batch = t.decode(&batch);
                        if batch.is_empty() {
                            // Only part of a character so far; the rest comes with the next read.
                            continue;
                        }
                    }
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

// agent D: inventory and snippets
impl Sessions {
    /// Runs a saved snippet non-interactively on an exec channel of a session the caller owns
    /// (multi-host and existing-session execution). The text is read from the vault under the
    /// session's generation. `run_id` lets the caller cancel with [`Sessions::cancel_snippet_run`].
    pub async fn exec_snippet(
        &self,
        owner: &str,
        session_id: &str,
        snippet_id: &str,
        run_id: &str,
    ) -> Result<tyrminal_contracts::SnippetExecResult, IpcError> {
        // Ownership first: a wrong window learns nothing about which snippets exist.
        let (entry, conn) = self.connection(owner, session_id)?;
        let text = self.vault.snippet_text(entry.generation, snippet_id).await?;
        let env = match &entry.host_id {
            Some(host_id) => self.vault.session_env(host_id).await.unwrap_or_default(),
            None => Vec::new(),
        };
        let cancel = self.snippet_runs.start(owner, run_id)?;
        let result = crate::snippet_runs::run(&conn, &text, &env, cancel).await;
        self.snippet_runs.finish(run_id);
        result
    }

    pub fn cancel_snippet_run(&self, owner: &str, run_id: &str) {
        self.snippet_runs.cancel(owner, run_id);
    }

    /// Shell integration on the server of a session the caller owns: what `~/.bashrc` holds.
    pub async fn integration_status(
        &self,
        owner: &str,
        session_id: &str,
    ) -> Result<tyrminal_contracts::IntegrationStatus, IpcError> {
        let (_, conn) = self.connection(owner, session_id)?;
        crate::shell_integration::remote_status(&conn).await
    }

    /// Writes the shell integration block into the server's `~/.bashrc` (explicit user action).
    pub async fn integration_install(
        &self,
        owner: &str,
        session_id: &str,
    ) -> Result<tyrminal_contracts::IntegrationStatus, IpcError> {
        let (_, conn) = self.connection(owner, session_id)?;
        crate::shell_integration::remote_install(&conn).await
    }

    /// Removes the shell integration block from the server's `~/.bashrc`.
    pub async fn integration_remove(
        &self,
        owner: &str,
        session_id: &str,
    ) -> Result<tyrminal_contracts::IntegrationStatus, IpcError> {
        let (_, conn) = self.connection(owner, session_id)?;
        crate::shell_integration::remote_remove(&conn).await
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

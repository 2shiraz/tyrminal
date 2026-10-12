//! Session recordings (BUILD_SPEC Phase 08, LOG-*): what a session printed, encrypted under the
//! vault's `K_logs` (docs/crypto-format.md §11).
//!
//! Recording taps a session's **output sink** and nothing else: typed input never reaches it, so
//! keystrokes and passwords typed at prompts that do not echo them cannot be recorded. Recording
//! is off until the user turns it on for the vault; turning it off stops running recordings and
//! keeps the existing ones, which are deleted only by their own action.
//!
//! Each recording is a vault record (title, host, times, bookmark, comment, all encrypted) and a
//! file `logs/<id>.tyrlog` beside the database, readable by this account only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use tyrminal_contracts::{
    ErrorCode, IpcError, PlaybackFrame, SessionEvent, SessionLogKind, SessionLogPlayback, SessionLogState,
    SessionLogStorage, SessionLogSummary,
};
use tyrminal_session_log::{Completeness, EndReason, Event, LogIdentity, LogWriter, WriteStatus};
use tyrminal_vault::Id;

use crate::error::{err, internal};
use crate::records::{LogEnd, SessionLogRecord};
use crate::sessions::SessionSink;
use crate::validate;
use crate::vault::VaultService;

/// Buffered output is written to disk at least this often, so a crash loses at most this much.
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
/// Output one playback carries to the renderer; longer recordings are shown up to this point.
pub(crate) const MAX_PLAYBACK_OUTPUT: usize = 16 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const FILE_EXTENSION: &str = "tyrlog";

/// One recording in progress.
struct Active {
    log_id: Id,
    host_id: Option<String>,
    keep_per_host: u32,
    started: Instant,
    writer: Mutex<Option<LogWriter<std::fs::File>>>,
    /// Bytes on disk when the writer finished early (size limit or a write error).
    written_when_done: Mutex<Option<(u64, LogEnd)>>,
    flusher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Active {
    fn at_ms(&self) -> u32 {
        u32::try_from(self.started.elapsed().as_millis()).unwrap_or(u32::MAX)
    }

    fn writer(&self) -> std::sync::MutexGuard<'_, Option<LogWriter<std::fs::File>>> {
        self.writer.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Records output; a failed write ends the recording (the session itself carries on).
    fn output(&self, data: &[u8]) {
        let mut writer = self.writer();
        let Some(log) = writer.as_mut() else { return };
        match log.output(self.at_ms(), data) {
            Ok(WriteStatus::Recording) => {}
            Ok(WriteStatus::LimitReached) => {
                let size = log.written();
                *writer = None;
                *self.written_when_done.lock().unwrap_or_else(|p| p.into_inner()) = Some((size, LogEnd::SizeLimit));
            }
            Err(_) => self.abandon(&mut writer),
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let mut writer = self.writer();
        let Some(log) = writer.as_mut() else { return };
        match log.resize(self.at_ms(), cols, rows) {
            Ok(WriteStatus::Recording) => {}
            Ok(WriteStatus::LimitReached) => {
                let size = log.written();
                *writer = None;
                *self.written_when_done.lock().unwrap_or_else(|p| p.into_inner()) = Some((size, LogEnd::SizeLimit));
            }
            Err(_) => self.abandon(&mut writer),
        }
    }

    fn flush(&self) {
        let mut writer = self.writer();
        if let Some(log) = writer.as_mut()
            && log.flush().is_err()
        {
            self.abandon(&mut writer);
        }
    }

    /// Stops writing after an I/O error. What is on disk reads as an incomplete recording.
    /// No end is recorded, so the list shows it as incomplete.
    fn abandon(&self, writer: &mut Option<LogWriter<std::fs::File>>) {
        *writer = None;
    }

    /// Writes the final chunk. Returns the file size and how it ended, or `None` if the recording
    /// had already stopped without an end (a write error).
    fn finish(&self, reason: LogEnd) -> Option<(u64, LogEnd)> {
        if let Some(handle) = self.flusher.lock().unwrap_or_else(|p| p.into_inner()).take() {
            handle.abort();
        }
        let log = self.writer().take();
        match log {
            Some(log) => {
                let size_before = log.written();
                match log.finish(self.at_ms(), end_reason(reason)) {
                    Ok(file) => Some((file.metadata().map_or(size_before, |m| m.len()), reason)),
                    Err(_) => None,
                }
            }
            None => *self.written_when_done.lock().unwrap_or_else(|p| p.into_inner()),
        }
    }
}

fn end_reason(end: LogEnd) -> EndReason {
    match end {
        LogEnd::Closed => EndReason::Closed,
        LogEnd::SizeLimit => EndReason::SizeLimit,
        LogEnd::Locked => EndReason::Locked,
        LogEnd::Stopped => EndReason::Stopped,
    }
}

/// A session sink that also records output. Only `output` is recorded; events (prompts, state)
/// are passed through untouched.
struct RecordingSink {
    inner: Arc<dyn SessionSink>,
    active: Arc<Active>,
}

impl SessionSink for RecordingSink {
    fn output(&self, data: Vec<u8>) -> bool {
        self.active.output(&data);
        self.inner.output(data)
    }

    fn event(&self, event: SessionEvent) -> bool {
        self.inner.event(event)
    }
}

/// Running recordings, by session id.
pub(crate) struct Recordings {
    dir: PathBuf,
    active: Mutex<HashMap<String, Arc<Active>>>,
}

impl Recordings {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self { dir, active: Mutex::new(HashMap::new()) }
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Active>>> {
        self.active.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn path(&self, id: &Id) -> PathBuf {
        self.dir.join(format!("{}.{FILE_EXTENSION}", validate::id_text(id)))
    }

    fn active_ids(&self) -> Vec<Id> {
        self.active().values().map(|a| a.log_id).collect()
    }

    /// Starts recording `session_id` if recording is on, and returns the sink the session should
    /// write to. When recording is off, or cannot start, the session's own sink comes back and the
    /// session runs unrecorded.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn wrap(
        &self,
        vault: &VaultService,
        generation: u32,
        session_id: &str,
        title: String,
        host_id: Option<String>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn SessionSink>,
    ) -> Arc<dyn SessionSink> {
        match self.start(vault, generation, session_id, title, host_id, cols, rows).await {
            Ok(Some(active)) => Arc::new(RecordingSink { inner: sink, active }),
            Ok(None) | Err(_) => sink,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn start(
        &self,
        vault: &VaultService,
        generation: u32,
        session_id: &str,
        title: String,
        host_id: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<Option<Arc<Active>>, IpcError> {
        let Some(ctx) = vault.recording_context(generation).await? else {
            return Ok(None);
        };
        let started_at = now_ms();
        let kind = if host_id.is_some() { SessionLogKind::Ssh } else { SessionLogKind::Local };
        let record = SessionLogRecord {
            title,
            host_id: host_id.clone(),
            kind,
            started_at,
            ended_at: None,
            size_bytes: 0,
            end: None,
            bookmarked: false,
            comment: String::new(),
        };
        let log_id = vault.create_session_log(generation, record).await?;
        let identity = LogIdentity { vault_id: ctx.vault_id, log_id, key_version: ctx.key_version };
        let opened = create_private_dir(&self.dir).and_then(|()| create_private_file(&self.path(&log_id)));
        let writer = opened.ok().and_then(|file| {
            LogWriter::start(
                ctx.logs_key.expose(),
                identity,
                started_at,
                cols,
                rows,
                u64::from(ctx.settings.max_log_mib) * MIB,
                file,
            )
            .ok()
        });
        let Some(writer) = writer else {
            // Leave nothing behind for a recording that never started.
            let _ = vault.delete_session_logs(&[log_id]).await;
            let _ = std::fs::remove_file(self.path(&log_id));
            return Err(err(ErrorCode::Internal, "The recording could not be started."));
        };
        let active = Arc::new(Active {
            log_id,
            host_id,
            keep_per_host: ctx.settings.keep_per_host,
            started: Instant::now(),
            writer: Mutex::new(Some(writer)),
            written_when_done: Mutex::new(None),
            flusher: Mutex::new(None),
        });
        let weak = Arc::downgrade(&active);
        let flusher = tokio::spawn(async move {
            let mut tick = tokio::time::interval(FLUSH_INTERVAL);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(active) = weak.upgrade() else { return };
                active.flush();
            }
        });
        *active.flusher.lock().unwrap_or_else(|p| p.into_inner()) = Some(flusher);
        self.active().insert(session_id.to_owned(), Arc::clone(&active));
        Ok(Some(active))
    }

    pub(crate) fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        let active = self.active().get(session_id).cloned();
        if let Some(active) = active {
            active.resize(cols, rows);
        }
    }

    /// Finishes the recording of a session that ended, records how it ended, and applies the
    /// per-host retention.
    pub(crate) async fn session_ended(&self, vault: &VaultService, session_id: &str, reason: LogEnd) {
        let Some(active) = self.active().remove(session_id) else { return };
        self.close(vault, &active, reason).await;
    }

    /// Stops every running recording (recording was turned off, or the vault locked).
    pub(crate) async fn stop_all(&self, vault: &VaultService, reason: LogEnd) {
        let all: Vec<_> = self.active().drain().map(|(_, a)| a).collect();
        for active in all {
            self.close(vault, &active, reason).await;
        }
    }

    async fn close(&self, vault: &VaultService, active: &Active, reason: LogEnd) {
        let Some((size, end)) = active.finish(reason) else { return };
        // After a lock this fails; the record is completed the next time the recording is opened.
        if vault.finish_session_log(active.log_id, now_ms(), size, end).await.is_err() {
            return;
        }
        let active_ids = self.active_ids();
        if let Ok(old) = vault.session_logs_beyond(active.host_id.as_deref(), active.keep_per_host, &active_ids).await {
            let _ = self.delete_ids(vault, &old).await;
        }
    }

    async fn delete_ids(&self, vault: &VaultService, ids: &[Id]) -> Result<(), IpcError> {
        vault.delete_session_logs(ids).await?;
        for id in ids {
            match tokio::fs::remove_file(self.path(id)).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(err(ErrorCode::Internal, "A recording's file could not be deleted.")),
            }
        }
        Ok(())
    }

    // ---------- the recordings list ----------

    pub(crate) async fn list(&self, vault: &VaultService) -> Result<Vec<SessionLogSummary>, IpcError> {
        let active = self.active_ids();
        Ok(vault
            .session_logs()
            .await?
            .into_iter()
            .map(|(id, record)| {
                let on_disk = self.path(&id).is_file();
                summary(&id, &record, active.contains(&id), on_disk)
            })
            .collect())
    }

    pub(crate) async fn storage(&self, vault: &VaultService) -> Result<SessionLogStorage, IpcError> {
        let logs = vault.session_logs().await?;
        let mut total_bytes = 0u64;
        for (id, _) in &logs {
            total_bytes += tokio::fs::metadata(self.path(id)).await.map_or(0, |m| m.len());
        }
        Ok(SessionLogStorage { count: u32::try_from(logs.len()).unwrap_or(u32::MAX), total_bytes })
    }

    pub(crate) async fn set_bookmark(
        &self,
        vault: &VaultService,
        id: &str,
        bookmarked: bool,
        comment: String,
    ) -> Result<SessionLogSummary, IpcError> {
        let id = validate::id(id)?;
        vault.session_log(id).await?;
        let comment = comment.trim().to_owned();
        vault
            .update_session_log(id, |record| {
                record.bookmarked = bookmarked;
                record.comment = comment;
            })
            .await?;
        let record = vault.session_log(id).await?;
        Ok(summary(&id, &record, self.active_ids().contains(&id), self.path(&id).is_file()))
    }

    pub(crate) async fn delete(&self, vault: &VaultService, id: &str) -> Result<(), IpcError> {
        let id = validate::id(id)?;
        vault.session_log(id).await?;
        if self.active_ids().contains(&id) {
            return Err(err(ErrorCode::InvalidInput, "This session is still being recorded. Close it first."));
        }
        self.delete_ids(vault, &[id]).await
    }

    /// Deletes every recording that is not running now, and any recording file the vault does
    /// not know (left from a restored or replaced vault). Returns how many recordings were deleted.
    pub(crate) async fn delete_all(&self, vault: &VaultService) -> Result<u32, IpcError> {
        let active = self.active_ids();
        let ids: Vec<Id> =
            vault.session_logs().await?.into_iter().map(|(id, _)| id).filter(|id| !active.contains(id)).collect();
        self.delete_ids(vault, &ids).await?;
        let known: Vec<PathBuf> = active.iter().map(|id| self.path(id)).collect();
        if let Ok(mut dir) = tokio::fs::read_dir(&self.dir).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let path = entry.path();
                let ours = path.extension().is_some_and(|e| e == FILE_EXTENSION);
                if ours && !known.contains(&path) {
                    let _ = tokio::fs::remove_file(&path).await;
                }
            }
        }
        Ok(u32::try_from(ids.len()).unwrap_or(u32::MAX))
    }

    /// Opens a recording for playback. Only output that authenticated is returned.
    pub(crate) async fn open(&self, vault: &VaultService, id: &str) -> Result<SessionLogPlayback, IpcError> {
        let id = validate::id(id)?;
        let record = vault.session_log(id).await?;
        let recording_now = self.active_ids().contains(&id);
        if recording_now {
            // Make what has been recorded so far readable.
            let active = self.active().values().find(|a| a.log_id == id).cloned();
            if let Some(active) = active {
                active.flush();
            }
        }
        let unreadable = || err(ErrorCode::NotFound, "This recording's file is missing or cannot be read.");
        let bytes = match tokio::fs::metadata(self.path(&id)).await {
            Ok(meta) if meta.len() <= tyrminal_session_log::MAX_LOG_LEN => {
                tokio::fs::read(self.path(&id)).await.map_err(|_| unreadable())?
            }
            _ => return Err(unreadable()),
        };
        let (key, vault_id, key_version) = vault.logs_key().await?;
        let identity = LogIdentity { vault_id, log_id: id, key_version };
        let playback =
            tokio::task::spawn_blocking(move || tyrminal_session_log::read_log(key.expose(), &identity, &bytes))
                .await
                .map_err(|_| internal())?
                .map_err(|_| unreadable())?;

        // A recording that ended while the vault was locking has no end in its record yet.
        let mut record = record;
        if record.end.is_none()
            && !recording_now
            && let Completeness::Complete(reason) = playback.completeness
        {
            let end = match reason {
                EndReason::Closed => LogEnd::Closed,
                EndReason::SizeLimit => LogEnd::SizeLimit,
                EndReason::Locked => LogEnd::Locked,
                EndReason::Stopped => LogEnd::Stopped,
            };
            let size = tokio::fs::metadata(self.path(&id)).await.map_or(0, |m| m.len());
            let ended_at = record.started_at + playback.events.iter().map(event_at).max().unwrap_or(0) as u64;
            if vault.finish_session_log(id, ended_at, size, end).await.is_ok() {
                record = vault.session_log(id).await?;
            }
        }
        let mut log = summary(&id, &record, recording_now, true);
        if !recording_now {
            match playback.completeness {
                Completeness::Damaged => log.state = SessionLogState::Damaged,
                Completeness::Incomplete => log.state = SessionLogState::Incomplete,
                Completeness::Complete(_) => {}
            }
        }
        let (frames, truncated) = frames(&playback.events);
        Ok(SessionLogPlayback { log, cols: playback.cols, rows: playback.rows, frames, truncated })
    }
}

fn event_at(event: &Event) -> u32 {
    match event {
        Event::Output { at_ms, .. } | Event::Resize { at_ms, .. } | Event::End { at_ms, .. } => *at_ms,
        Event::Start { .. } => 0,
    }
}

/// The renderer's frames, up to [`MAX_PLAYBACK_OUTPUT`] bytes of output.
fn frames(events: &[Event]) -> (Vec<PlaybackFrame>, bool) {
    let engine = base64::engine::general_purpose::STANDARD;
    let mut frames = Vec::new();
    let mut shown = 0usize;
    for event in events {
        match event {
            Event::Output { at_ms, data } => {
                if shown + data.len() > MAX_PLAYBACK_OUTPUT {
                    return (frames, true);
                }
                shown += data.len();
                frames.push(PlaybackFrame::Output { at_ms: *at_ms, data: engine.encode(data) });
            }
            Event::Resize { at_ms, cols, rows } => {
                frames.push(PlaybackFrame::Resize { at_ms: *at_ms, cols: *cols, rows: *rows });
            }
            Event::Start { .. } | Event::End { .. } => {}
        }
    }
    (frames, false)
}

fn summary(id: &Id, record: &SessionLogRecord, recording_now: bool, on_disk: bool) -> SessionLogSummary {
    let state = if recording_now {
        SessionLogState::Recording
    } else if !on_disk {
        SessionLogState::Unreadable
    } else {
        match record.end {
            Some(LogEnd::Closed | LogEnd::Locked | LogEnd::Stopped) => SessionLogState::Complete,
            Some(LogEnd::SizeLimit) => SessionLogState::SizeLimit,
            None => SessionLogState::Incomplete,
        }
    };
    SessionLogSummary {
        id: validate::id_text(id),
        title: record.title.clone(),
        host_id: record.host_id.clone(),
        kind: record.kind,
        started_at: record.started_at,
        ended_at: record.ended_at,
        size_bytes: record.size_bytes,
        state,
        bookmarked: record.bookmarked,
        comment: record.comment.clone(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn create_private_dir(dir: &Path) -> Result<(), IpcError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|_| internal())?;
    tyrminal_platform::restrict_to_owner(dir).map_err(|_| internal())
}

fn create_private_file(path: &Path) -> Result<std::fs::File, IpcError> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // On Windows the file inherits the owner-only access list of its directory.
    options.open(path).map_err(|_| internal())
}

impl crate::sessions::Sessions {
    pub async fn recording_settings(&self) -> Result<tyrminal_contracts::RecordingSettings, IpcError> {
        self.vault().recording_settings().await
    }

    /// Saves the settings. Turning recording off stops the running recordings now and keeps
    /// every recording made so far.
    pub async fn set_recording_settings(
        &self,
        settings: tyrminal_contracts::RecordingSettings,
    ) -> Result<tyrminal_contracts::RecordingSettings, IpcError> {
        let saved = self.vault().set_recording_settings(settings).await?;
        if !saved.enabled {
            self.recordings.stop_all(self.vault(), LogEnd::Stopped).await;
        }
        Ok(saved)
    }

    /// Every recording, newest first.
    pub async fn list_session_logs(&self) -> Result<Vec<SessionLogSummary>, IpcError> {
        self.recordings.list(self.vault()).await
    }

    pub async fn session_log_storage(&self) -> Result<SessionLogStorage, IpcError> {
        self.recordings.storage(self.vault()).await
    }

    /// Bookmarks a recording (bookmarked recordings are kept beyond the per-host limit) and sets
    /// its comment.
    pub async fn bookmark_session_log(
        &self,
        id: &str,
        bookmarked: bool,
        comment: String,
    ) -> Result<SessionLogSummary, IpcError> {
        self.recordings.set_bookmark(self.vault(), id, bookmarked, comment).await
    }

    pub async fn delete_session_log(&self, id: &str) -> Result<(), IpcError> {
        self.recordings.delete(self.vault(), id).await
    }

    /// Deletes every recording that is not running now. Separate from turning recording off.
    pub async fn delete_all_session_logs(&self) -> Result<u32, IpcError> {
        self.recordings.delete_all(self.vault()).await
    }

    pub async fn open_session_log(&self, id: &str) -> Result<SessionLogPlayback, IpcError> {
        self.recordings.open(self.vault(), id).await
    }
}

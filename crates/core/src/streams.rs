//! Uploads whose bytes come from the window rather than from a file the core can open
//! (FIL-05 files dropped from the desktop, FIL-18 files dropped on a terminal).
//!
//! A webview hands dropped files to the page without their paths, so the page sends the
//! content in bounded chunks, strictly in order. Everything else is as for any upload: the
//! data goes to a temporary name in the target folder and is renamed into place only once the
//! declared size has arrived and the server confirmed every write; an aborted, short or failed
//! upload removes the temporary file. Streams belong to one window and one session, and are
//! dropped with either.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tyrminal_contracts::limits::{MAX_STREAM_CHUNK, MAX_TRANSFERS};
use tyrminal_contracts::{ConflictChoice, ErrorCode, IpcError, StreamUpload};
use tyrminal_ssh::{FileError, RemoteKind, RemoteWriter, Sftp};

use crate::error::{err, invalid};
use crate::files::{self, from_file};

/// Permissions of a file uploaded this way (the page cannot tell the local file's mode).
const STREAM_MODE: u32 = 0o644;

struct Stream {
    sftp: Arc<Sftp>,
    writer: Option<RemoteWriter>,
    temp: String,
    target: String,
    name: String,
    expected: u64,
    written: u64,
    overwrite: bool,
}

/// A registered stream: who may use it (fixed at creation) and its state.
struct Slot {
    owner: String,
    session_id: String,
    stream: Arc<tokio::sync::Mutex<Stream>>,
}

#[derive(Default)]
pub(crate) struct Streams {
    open: Mutex<HashMap<String, Slot>>,
}

fn unknown() -> IpcError {
    err(ErrorCode::AccessDenied, "That upload is not running in this window.")
}

impl Streams {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn get(&self, owner: &str, id: &str) -> Result<Arc<tokio::sync::Mutex<Stream>>, IpcError> {
        match self.map().get(id) {
            Some(slot) if slot.owner == owner => Ok(Arc::clone(&slot.stream)),
            _ => Err(unknown()),
        }
    }

    /// Starts an upload of `size` bytes named `name` into `dir`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn begin(
        &self,
        owner: &str,
        session_id: &str,
        sftp: Arc<Sftp>,
        dir: &str,
        name: &str,
        size: u64,
        choice: ConflictChoice,
        id: String,
    ) -> Result<StreamUpload, IpcError> {
        let dir = files::remote_dir(dir)?.to_owned();
        files::remote_name(name)?;
        if self.map().len() >= MAX_TRANSFERS {
            return Err(err(ErrorCode::LimitExceeded, "Too many transfers are running. Wait for one to finish."));
        }
        let name = if choice == ConflictChoice::KeepBoth {
            files::free_remote_name(&sftp, &dir, name).await?
        } else {
            name.to_owned()
        };
        let overwrite = choice == ConflictChoice::Replace;
        let target = files::join(&dir, &name)?;
        check_target(&sftp, &target, overwrite).await?;
        let temp = files::join(&dir, &files::temp_name(&name, &id))?;
        let writer = sftp.create_new(&temp, 0o600).await.map_err(from_file)?;
        let stream = Stream {
            sftp,
            writer: Some(writer),
            temp,
            target,
            name: name.clone(),
            expected: size,
            written: 0,
            overwrite,
        };
        let slot = Slot {
            owner: owner.to_owned(),
            session_id: session_id.to_owned(),
            stream: Arc::new(tokio::sync::Mutex::new(stream)),
        };
        self.map().insert(id.clone(), slot);
        Ok(StreamUpload { upload_id: id, name })
    }

    /// Appends the next chunk. `offset` must be where the previous chunk ended.
    pub(crate) async fn chunk(&self, owner: &str, id: &str, offset: u64, data: &[u8]) -> Result<(), IpcError> {
        if data.len() > MAX_STREAM_CHUNK {
            return Err(err(ErrorCode::LimitExceeded, "That part of the upload is too large."));
        }
        let stream = self.get(owner, id)?;
        let mut s = stream.lock().await;
        if offset != s.written || s.written + data.len() as u64 > s.expected {
            drop(s);
            self.abort(owner, id).await;
            return Err(invalid("The upload arrived out of order and was stopped."));
        }
        let result = match s.writer.as_mut() {
            Some(writer) => writer.write(data).await.map_err(from_file),
            None => Err(unknown()),
        };
        if let Err(error) = result {
            drop(s);
            self.abort(owner, id).await;
            return Err(error);
        }
        s.written += data.len() as u64;
        Ok(())
    }

    /// Completes the upload: every byte declared must have arrived. Returns the name used.
    pub(crate) async fn finish(&self, owner: &str, id: &str) -> Result<String, IpcError> {
        let stream = self.get(owner, id)?;
        let mut s = stream.lock().await;
        if self.map().remove(id).is_none() {
            // Aborted (or finished) while this call waited for the stream.
            return Err(unknown());
        }
        let writer = s.writer.take();
        let placed = async {
            if s.written != s.expected {
                return Err(invalid("The upload ended before all of the file arrived."));
            }
            writer.ok_or_else(unknown)?.finish().await.map_err(from_file)?;
            s.sftp.set_permissions(&s.temp, STREAM_MODE).await.map_err(from_file)?;
            check_target(&s.sftp, &s.target, s.overwrite).await?;
            if s.overwrite {
                match s.sftp.remove_file(&s.target).await {
                    Ok(()) | Err(FileError::NotFound) => {}
                    Err(e) => return Err(from_file(e)),
                }
            }
            s.sftp.rename(&s.temp, &s.target).await.map_err(from_file)
        }
        .await;
        if placed.is_err() {
            let _ = s.sftp.remove_file(&s.temp).await;
        }
        placed.map(|()| s.name.clone())
    }

    /// Stops an upload and removes its temporary file (no-op for unknown ids).
    pub(crate) async fn abort(&self, owner: &str, id: &str) {
        let slot = {
            let mut map = self.map();
            match map.get(id) {
                Some(slot) if slot.owner == owner => map.remove(id),
                _ => None,
            }
        };
        if let Some(slot) = slot {
            discard(slot.stream).await;
        }
    }

    /// Drops every upload of a window or a session (it was closed).
    pub(crate) async fn abort_where(&self, owner: Option<&str>, session_id: Option<&str>) {
        let gone: Vec<Slot> = {
            let mut map = self.map();
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, s)| {
                    owner.is_some_and(|o| s.owner == o) || session_id.is_some_and(|sid| s.session_id == sid)
                })
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for slot in gone {
            discard(slot.stream).await;
        }
    }
}

async fn discard(stream: Arc<tokio::sync::Mutex<Stream>>) {
    let mut s = stream.lock().await;
    if let Some(writer) = s.writer.take() {
        writer.abandon().await;
    }
    let _ = s.sftp.remove_file(&s.temp).await;
}

async fn check_target(sftp: &Sftp, target: &str, overwrite: bool) -> Result<(), IpcError> {
    match sftp.lstat(target).await {
        Ok(attrs) if attrs.kind == RemoteKind::Dir || !overwrite => Err(files::conflict()),
        Ok(_) | Err(FileError::NotFound) => Ok(()),
        Err(e) => Err(from_file(e)),
    }
}

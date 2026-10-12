//! Editing a remote file in a local application (Phase 06, FIL-11).
//!
//! Opening a remote file for editing downloads it into its own owner-only folder under the
//! application's edit area. Changes are never uploaded on their own: the renderer polls the
//! status and the user saves explicitly. Saving refuses when the server's copy changed since it
//! was opened (size, modification time or, since times are whole seconds, content), unless the
//! user chooses to overwrite, and replaces
//! the remote file through a temporary file like any upload. The local copy is removed when the
//! edit is closed, when its session ends, and (by the adapter) when the application starts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tyrminal_contracts::{EditStatus, ErrorCode, IpcError};
use tyrminal_ssh::RemoteAttrs;

use crate::error::err;
use crate::files::local_io;

/// Largest file opened for editing.
pub(crate) const MAX_EDIT_SIZE: u64 = 64 * 1024 * 1024;

pub(crate) struct Edit {
    pub owner: String,
    pub session_id: String,
    pub remote: String,
    pub name: String,
    /// The edit's own folder (removed as a whole) and the file in it.
    pub folder: PathBuf,
    pub file: PathBuf,
    /// What the server had when the file was opened or last saved.
    pub remote_size: Option<u64>,
    pub remote_modified: Option<u64>,
    pub permissions: Option<u32>,
    /// The content as downloaded or last saved (local and remote were identical then).
    pub saved_hash: [u8; 32],
}

impl Edit {
    pub(crate) fn remote_unchanged(&self, now: &RemoteAttrs) -> bool {
        now.size == self.remote_size && now.modified == self.remote_modified
    }
}

#[derive(Default)]
pub(crate) struct Edits {
    open: Mutex<HashMap<String, Edit>>,
}

pub(crate) fn not_open() -> IpcError {
    err(ErrorCode::AccessDenied, "That file is not open for editing in this window.")
}

pub(crate) fn changed_on_server() -> IpcError {
    err(ErrorCode::Conflict, "The file changed on the server since you opened it.")
}

pub(crate) fn too_large() -> IpcError {
    err(ErrorCode::LimitExceeded, "Files larger than 64 MiB cannot be opened for editing.")
}

pub(crate) async fn hash_file(path: &Path) -> Result<[u8; 32], IpcError> {
    let mut file = tokio::fs::File::open(path).await.map_err(|e| local_io(&e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).await.map_err(|e| local_io(&e))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_EDIT_SIZE {
            return Err(too_large());
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

/// SHA-256 of a remote file's content (bounded like local copies).
pub(crate) async fn hash_remote(sftp: &tyrminal_ssh::Sftp, path: &str) -> Result<[u8; 32], IpcError> {
    let mut reader = sftp.open_read(path).await.map_err(crate::files::from_file)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let result = async {
        while let Some(chunk) = reader.next_chunk().await.map_err(crate::files::from_file)? {
            total += chunk.len() as u64;
            if total > MAX_EDIT_SIZE {
                return Err(too_large());
            }
            hasher.update(&chunk);
        }
        Ok(())
    }
    .await;
    reader.close().await;
    result.map(|()| hasher.finalize().into())
}

pub(crate) async fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await
}

impl Edits {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Edit>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn insert(&self, id: String, edit: Edit) {
        self.lock().insert(id, edit);
    }

    /// Runs `f` on an edit the caller owns.
    pub(crate) fn with<T>(&self, owner: &str, id: &str, f: impl FnOnce(&mut Edit) -> T) -> Result<T, IpcError> {
        let mut open = self.lock();
        match open.get_mut(id) {
            Some(edit) if edit.owner == owner => Ok(f(edit)),
            _ => Err(not_open()),
        }
    }

    /// Forgets an edit and returns its folder for removal.
    pub(crate) fn take(&self, owner: &str, id: &str) -> Result<PathBuf, IpcError> {
        let mut open = self.lock();
        match open.get(id) {
            Some(edit) if edit.owner == owner => Ok(open.remove(id).map(|e| e.folder).unwrap_or_default()),
            _ => Err(not_open()),
        }
    }

    /// Forgets every edit of a session and returns their folders.
    pub(crate) fn take_session(&self, session_id: &str) -> Vec<PathBuf> {
        let mut open = self.lock();
        let ids: Vec<String> =
            open.iter().filter(|(_, e)| e.session_id == session_id).map(|(id, _)| id.clone()).collect();
        ids.into_iter().filter_map(|id| open.remove(&id).map(|e| e.folder)).collect()
    }
}

/// Whether the local copy differs from what was downloaded or last saved.
pub(crate) async fn status(id: &str, name: &str, file: &Path, saved: [u8; 32]) -> Result<EditStatus, IpcError> {
    let changed = match tokio::fs::metadata(file).await {
        Ok(_) => hash_file(file).await? != saved,
        // The editor may replace the file (save via rename); a missing file is not a change.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(local_io(&e)),
    };
    Ok(EditStatus { edit_id: id.to_owned(), name: name.to_owned(), changed })
}

pub(crate) fn sftp_mode(attrs: &RemoteAttrs) -> u32 {
    attrs.permissions.unwrap_or(0o644)
}

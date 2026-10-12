//! Copying between two servers (Phase 06, FIL-04).
//!
//! Data streams from one session's SFTP channel to another's through this process, in bounded
//! chunks, never touching the local disk. The rules are those of uploads: a hidden temporary name
//! on the destination, renamed into place only when complete; a taken name is resolved by the
//! user's choice; folders are never merged; links and special files are skipped and counted.

use std::sync::Arc;

use tokio::sync::watch;
use tyrminal_contracts::{ErrorCode, IpcError};
use tyrminal_ssh::{FileError, RemoteKind, Sftp};

use crate::error::err;
use crate::files::{Progress, Stop, TransferSink, cancelled, conflict, from_file, join, temp_name};
use crate::folders::{Tree, finish, remote_path};

/// Streams one remote file to a new file on another server; verifies the size and removes the
/// partial file on any failure.
async fn stream(
    src: &Sftp,
    from: &str,
    dst: &Sftp,
    to: &str,
    progress: &mut Progress<'_>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<u64, Stop> {
    let mut reader = src.open_read(from).await.map_err(from_file)?;
    let mut writer = match dst.create_new(to, 0o600).await {
        Ok(w) => w,
        Err(e) => {
            reader.close().await;
            return Err(Stop::Failed(from_file(e)));
        }
    };
    let copied = async {
        loop {
            let chunk = tokio::select! {
                () = cancelled(cancel) => return Err(Stop::Cancelled),
                chunk = reader.next_chunk() => chunk.map_err(from_file)?,
            };
            let Some(chunk) = chunk else { break };
            writer.write(&chunk).await.map_err(from_file)?;
            progress.add(chunk.len());
        }
        Ok::<(), Stop>(())
    }
    .await;
    reader.close().await;
    let result = match copied {
        Err(stop) => {
            writer.abandon().await;
            Err(stop)
        }
        Ok(()) => {
            async {
                let bytes = writer.finish().await.map_err(from_file)?;
                if dst.stat(to).await.map_err(from_file)?.size != Some(bytes) {
                    return Err(Stop::Failed(err(ErrorCode::IoError, "The destination did not store the whole file.")));
                }
                Ok(bytes)
            }
            .await
        }
    };
    if result.is_err() {
        let _ = dst.remove_file(to).await;
    }
    result
}

pub(crate) struct RemoteCopy {
    pub src: Arc<Sftp>,
    pub src_path: String,
    pub dst: Arc<Sftp>,
    pub dst_dir: String,
    /// The final name on the destination (already resolved for "keep both").
    pub name: String,
    pub replace: bool,
    pub token: String,
    /// The source tree when copying a folder.
    pub tree: Option<Tree>,
    pub mode: u32,
}

/// Checks a copy before it starts. Returns the job and the bytes to copy.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn prepare(
    src: Arc<Sftp>,
    src_path: String,
    dst: Arc<Sftp>,
    dst_dir: String,
    name: String,
    replace: bool,
    token: String,
) -> Result<(RemoteCopy, u64), IpcError> {
    let attrs = src.stat(&src_path).await.map_err(from_file)?;
    let target = join(&dst_dir, &name)?;
    let existing = match dst.lstat(&target).await {
        Ok(a) => Some(a.kind),
        Err(FileError::NotFound) => None,
        Err(e) => return Err(from_file(e)),
    };
    let (tree, total) = match attrs.kind {
        RemoteKind::Dir => {
            if existing.is_some() {
                return Err(conflict());
            }
            let tree = crate::folders::walk_remote_checked(&src, &src_path, false).await?;
            let total = tree.bytes();
            (Some(tree), total)
        }
        RemoteKind::File => {
            if existing == Some(RemoteKind::Dir) || (existing.is_some() && !replace) {
                return Err(conflict());
            }
            (None, attrs.size.unwrap_or(0))
        }
        _ => return Err(err(ErrorCode::InvalidInput, "Only files and folders can be copied.")),
    };
    let mode = attrs.permissions.unwrap_or(0o644) & 0o777;
    Ok((RemoteCopy { src, src_path, dst, dst_dir, name, replace, token, tree, mode }, total))
}

pub(crate) async fn run(job: RemoteCopy, sink: &dyn TransferSink, mut cancel: watch::Receiver<bool>) {
    let (temp, target) = match (join(&job.dst_dir, &temp_name(&job.name, &job.token)), join(&job.dst_dir, &job.name)) {
        (Ok(t), Ok(f)) => (t, f),
        (Err(error), _) | (_, Err(error)) => {
            finish(sink, Err(Stop::Failed(error)), 0);
            return;
        }
    };
    let skipped = job.tree.as_ref().map_or(0, |t| t.skipped);
    let mut progress = Progress::new(sink);
    let result = match &job.tree {
        None => {
            async {
                stream(&job.src, &job.src_path, &job.dst, &temp, &mut progress, &mut cancel).await?;
                let placed = async {
                    job.dst.set_permissions(&temp, job.mode).await.map_err(from_file)?;
                    match job.dst.lstat(&target).await {
                        Ok(a) if a.kind == RemoteKind::Dir || !job.replace => return Err(conflict()),
                        Ok(_) => job.dst.remove_file(&target).await.map_err(from_file)?,
                        Err(FileError::NotFound) => {}
                        Err(e) => return Err(from_file(e)),
                    }
                    job.dst.rename(&temp, &target).await.map_err(from_file)
                }
                .await;
                if placed.is_err() {
                    let _ = job.dst.remove_file(&temp).await;
                }
                placed?;
                Ok((progress.done, 1))
            }
            .await
        }
        Some(tree) => {
            let copied = async {
                job.dst.create_dir(&temp).await.map_err(from_file)?;
                for rel in &tree.dirs {
                    job.dst.create_dir(&remote_path(&temp, rel)?).await.map_err(from_file)?;
                }
                for (rel, _) in &tree.files {
                    let to = remote_path(&temp, rel)?;
                    stream(&job.src, &remote_path(&job.src_path, rel)?, &job.dst, &to, &mut progress, &mut cancel)
                        .await?;
                }
                job.dst.rename(&temp, &target).await.map_err(|e| match e {
                    FileError::Failed => conflict(),
                    other => from_file(other),
                })?;
                Ok((progress.done, tree.files.len() as u32))
            }
            .await;
            if copied.is_err() {
                for (rel, _) in &tree.files {
                    if let Ok(p) = remote_path(&temp, rel) {
                        let _ = job.dst.remove_file(&p).await;
                    }
                }
                for rel in tree.dirs.iter().rev() {
                    if let Ok(p) = remote_path(&temp, rel) {
                        let _ = job.dst.remove_dir(&p).await;
                    }
                }
                let _ = job.dst.remove_dir(&temp).await;
            }
            copied
        }
    };
    finish(sink, result, skipped);
}

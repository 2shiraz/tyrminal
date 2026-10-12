//! Folder transfers over SFTP (Phase 06, FIL-03).
//!
//! The whole tree is listed and checked before anything is written: every name must be usable
//! on the receiving side, the tree is bounded in entries and depth, and the target name must not
//! exist yet. Symbolic links and special files are never followed or copied; they are counted
//! and reported as skipped. Everything is written into a hidden temporary folder next to the
//! target, which is renamed to the target name only when every file is complete, so a cancelled
//! or failed transfer never leaves a partial folder under the final name.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::watch;
use tyrminal_contracts::limits::{MAX_TREE_DEPTH, MAX_TREE_ENTRIES};
use tyrminal_contracts::{ErrorCode, IpcError, TransferEvent};
use tyrminal_ssh::{FileError, RemoteKind, Sftp};

use crate::error::err;
use crate::files::{
    Progress, Stop, TransferSink, conflict, create_private, from_file, join, local_io, local_name_ok, pull, push,
    remote_name, temp_name,
};

/// A tree to copy: folders (parents before children) and files, as relative name lists.
#[derive(Debug, Default)]
pub(crate) struct Tree {
    pub dirs: Vec<Vec<String>>,
    pub files: Vec<(Vec<String>, u64)>,
    pub skipped: u32,
}

impl Tree {
    pub(crate) fn bytes(&self) -> u64 {
        self.files.iter().map(|(_, size)| size).sum()
    }

    fn count(&self) -> usize {
        self.dirs.len() + self.files.len()
    }
}

fn too_big() -> IpcError {
    err(ErrorCode::LimitExceeded, "That folder has too many entries or is nested too deeply to copy at once.")
}

fn remote_path(root: &str, rel: &[String]) -> Result<String, IpcError> {
    rel.iter().try_fold(root.to_owned(), |path, name| join(&path, name))
}

fn local_path(root: &Path, rel: &[String]) -> PathBuf {
    rel.iter().fold(root.to_path_buf(), |path, name| path.join(name))
}

/// Lists a remote folder recursively without following links.
pub(crate) async fn walk_remote(sftp: &Sftp, root: &str) -> Result<Tree, IpcError> {
    let mut tree = Tree::default();
    let mut pending: Vec<Vec<String>> = vec![Vec::new()];
    while let Some(rel) = pending.pop() {
        if rel.len() > MAX_TREE_DEPTH {
            return Err(too_big());
        }
        let dir = remote_path(root, &rel)?;
        let (entries, truncated) = sftp.read_dir(&dir, MAX_TREE_ENTRIES).await.map_err(from_file)?;
        if truncated {
            return Err(too_big());
        }
        for entry in entries {
            if !local_name_ok(&entry.name) {
                return Err(err(
                    ErrorCode::InvalidInput,
                    "A name inside that folder cannot be used on this computer, so nothing was copied.",
                ));
            }
            let mut child = rel.clone();
            child.push(entry.name);
            match entry.attrs.kind {
                RemoteKind::Dir => {
                    tree.dirs.push(child.clone());
                    pending.push(child);
                }
                RemoteKind::File => tree.files.push((child, entry.attrs.size.unwrap_or(0))),
                RemoteKind::Symlink | RemoteKind::Other => tree.skipped += 1,
            }
            if tree.count() > MAX_TREE_ENTRIES {
                return Err(too_big());
            }
        }
    }
    // Parents before children (a stable order also makes the result deterministic).
    tree.dirs.sort();
    Ok(tree)
}

/// Lists a local folder recursively without following links.
pub(crate) async fn walk_local(root: &Path) -> Result<Tree, IpcError> {
    let mut tree = Tree::default();
    let mut pending: Vec<Vec<String>> = vec![Vec::new()];
    while let Some(rel) = pending.pop() {
        if rel.len() > MAX_TREE_DEPTH {
            return Err(too_big());
        }
        let mut dir = tokio::fs::read_dir(local_path(root, &rel)).await.map_err(|e| local_io(&e))?;
        while let Some(entry) = dir.next_entry().await.map_err(|e| local_io(&e))? {
            let Ok(name) = entry.file_name().into_string() else {
                return Err(err(
                    ErrorCode::InvalidInput,
                    "A name inside that folder is not valid text, so nothing was copied.",
                ));
            };
            if remote_name(&name).is_err() {
                return Err(err(ErrorCode::InvalidInput, "A name inside that folder cannot be used on the server."));
            }
            let kind = entry.file_type().await.map_err(|e| local_io(&e))?;
            let mut child = rel.clone();
            child.push(name);
            if kind.is_dir() {
                tree.dirs.push(child.clone());
                pending.push(child);
            } else if kind.is_file() {
                let size = entry.metadata().await.map_err(|e| local_io(&e))?.len();
                tree.files.push((child, size));
            } else {
                tree.skipped += 1;
            }
            if tree.count() > MAX_TREE_ENTRIES {
                return Err(too_big());
            }
        }
    }
    tree.dirs.sort();
    Ok(tree)
}

fn finish(sink: &dyn TransferSink, result: Result<(u64, u32), Stop>, skipped: u32) {
    sink.event(match result {
        Ok((bytes, files)) => TransferEvent::Done { bytes, files, skipped },
        Err(Stop::Cancelled) => TransferEvent::Cancelled,
        Err(Stop::Failed(error)) => TransferEvent::Failed { error },
    });
}

pub(crate) struct FolderDownload {
    pub sftp: Arc<Sftp>,
    pub remote: String,
    pub local_dir: PathBuf,
    pub name: String,
    pub token: String,
    pub tree: Tree,
}

/// Checks a folder download before it starts and lists the tree.
pub(crate) async fn prepare_download(
    sftp: Arc<Sftp>,
    remote: String,
    local_dir: PathBuf,
    name: &str,
    token: String,
) -> Result<FolderDownload, IpcError> {
    if !local_name_ok(name) {
        return Err(err(ErrorCode::InvalidInput, "That name cannot be used for a folder on this computer."));
    }
    if !tokio::fs::metadata(&local_dir).await.map_err(|e| local_io(&e))?.is_dir() {
        return Err(err(ErrorCode::InvalidInput, "Choose a folder on this computer."));
    }
    if tokio::fs::symlink_metadata(local_dir.join(name)).await.is_ok() {
        return Err(conflict());
    }
    let tree = walk_remote(&sftp, &remote).await?;
    Ok(FolderDownload { sftp, remote, local_dir, name: name.to_owned(), token, tree })
}

async fn create_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = tokio::fs::DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await
}

pub(crate) async fn run_download(d: FolderDownload, sink: &dyn TransferSink, mut cancel: watch::Receiver<bool>) {
    let temp = d.local_dir.join(temp_name(&d.name, &d.token));
    let target = d.local_dir.join(&d.name);
    let mut created = false;
    let result = async {
        create_private_dir(&temp).await.map_err(|e| local_io(&e))?;
        created = true;
        for rel in &d.tree.dirs {
            create_private_dir(&local_path(&temp, rel)).await.map_err(|e| local_io(&e))?;
        }
        let mut progress = Progress::new(sink);
        for (rel, _) in &d.tree.files {
            let remote = remote_path(&d.remote, rel)?;
            let mut file = create_private(&local_path(&temp, rel)).await.map_err(|e| local_io(&e))?;
            pull(&d.sftp, &remote, &mut file, &mut progress, &mut cancel).await?;
        }
        // The target name must still be free: never merge into or replace an existing folder.
        if tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err(Stop::Failed(conflict()));
        }
        tokio::fs::rename(&temp, &target).await.map_err(|e| local_io(&e))?;
        Ok((progress.done, d.tree.files.len() as u32))
    }
    .await;
    if result.is_err() && created {
        let _ = tokio::fs::remove_dir_all(&temp).await;
    }
    finish(sink, result, d.tree.skipped);
}

pub(crate) struct FolderUpload {
    pub sftp: Arc<Sftp>,
    pub local: PathBuf,
    pub dir: String,
    pub name: String,
    pub token: String,
    pub tree: Tree,
}

/// Checks a folder upload before it starts and lists the tree.
pub(crate) async fn prepare_upload(
    sftp: Arc<Sftp>,
    local: PathBuf,
    dir: String,
    name: &str,
    token: String,
) -> Result<FolderUpload, IpcError> {
    let target = join(&dir, name)?;
    match sftp.lstat(&target).await {
        Ok(_) => return Err(conflict()),
        Err(FileError::NotFound) => {}
        Err(e) => return Err(from_file(e)),
    }
    let tree = walk_local(&local).await?;
    Ok(FolderUpload { sftp, local, dir, name: name.to_owned(), token, tree })
}

/// Removes what an unfinished upload created under `root` (files, then folders deepest first).
async fn remove_remote_tree(sftp: &Sftp, root: &str, tree: &Tree) {
    for (rel, _) in &tree.files {
        if let Ok(path) = remote_path(root, rel) {
            let _ = sftp.remove_file(&path).await;
        }
    }
    for rel in tree.dirs.iter().rev() {
        if let Ok(path) = remote_path(root, rel) {
            let _ = sftp.remove_dir(&path).await;
        }
    }
    let _ = sftp.remove_dir(root).await;
}

pub(crate) async fn run_upload(u: FolderUpload, sink: &dyn TransferSink, mut cancel: watch::Receiver<bool>) {
    let (temp, target) = match (join(&u.dir, &temp_name(&u.name, &u.token)), join(&u.dir, &u.name)) {
        (Ok(t), Ok(f)) => (t, f),
        (Err(error), _) | (_, Err(error)) => {
            sink.event(TransferEvent::Failed { error });
            return;
        }
    };
    let mut created = false;
    let result = async {
        u.sftp.create_dir(&temp).await.map_err(from_file)?;
        created = true;
        for rel in &u.tree.dirs {
            u.sftp.create_dir(&remote_path(&temp, rel)?).await.map_err(from_file)?;
        }
        let mut progress = Progress::new(sink);
        for (rel, _) in &u.tree.files {
            let remote = remote_path(&temp, rel)?;
            let local = local_path(&u.local, rel);
            push(&u.sftp, &local, &remote, &mut progress, &mut cancel).await?;
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::metadata(&local).await.map_err(|e| local_io(&e))?.permissions().mode() & 0o777
            };
            #[cfg(not(unix))]
            let mode = 0o644;
            u.sftp.set_permissions(&remote, mode).await.map_err(from_file)?;
        }
        // SFTP rename refuses an existing target, so a folder that appeared meanwhile is kept.
        u.sftp.rename(&temp, &target).await.map_err(|e| match e {
            FileError::Failed => conflict(),
            other => from_file(other),
        })?;
        Ok((progress.done, u.tree.files.len() as u32))
    }
    .await;
    if result.is_err() && created {
        remove_remote_tree(&u.sftp, &temp, &u.tree).await;
    }
    finish(sink, result, u.tree.skipped);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_walk_skips_links_and_lists_parents_first() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/f.txt"), b"12345").unwrap();
        std::fs::write(root.join("top.txt"), b"1").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        let tree = walk_local(root).await.unwrap();
        assert_eq!(tree.dirs, vec![vec!["a".to_owned()], vec!["a".to_owned(), "b".to_owned()]]);
        assert_eq!(tree.bytes(), 6);
        assert_eq!(tree.files.len(), 2);
        assert_eq!(tree.skipped, u32::from(cfg!(unix)));
    }
}

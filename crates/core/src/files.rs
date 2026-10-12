//! Remote files over SFTP (Phase 06): browsing, basic changes and transfers.
//!
//! Every operation runs on an SFTP channel of a connected session's verified connection; no
//! remote shell is involved and nothing is interpolated into a command. Remote paths are built
//! here from an absolute folder the server reported and a single checked name. Local paths come
//! only from the adapter (native dialogs), never from the renderer.
//!
//! Transfers never leave a partial file under the final name: data goes to a new private
//! temporary file next to the target, which replaces the target only once it is complete. A
//! name that already exists is a conflict unless the user chose to replace it, and that is
//! checked both before starting and again right before the final rename.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tyrminal_contracts::limits::{MAX_FILE_NAME_LEN, MAX_REMOTE_PATH_LEN};
use tyrminal_contracts::{
    ErrorCode, IpcError, RemoteEntry, RemoteEntryKind, TransferDirection, TransferEvent, TransferStarted,
};
use tyrminal_ssh::{FileError, RemoteAttrs, RemoteKind, SFTP_CHUNK, Sftp};

use crate::error::err;

/// Where a transfer's events go (the adapter's per-transfer channel). `false`: nobody listens.
pub trait TransferSink: Send + Sync + 'static {
    fn event(&self, event: TransferEvent) -> bool;
}

const PROGRESS_EVERY: Duration = Duration::from_millis(200);
const TEMP_SUFFIX: &str = ".tyrpart";

pub(crate) fn from_file(e: FileError) -> IpcError {
    match e {
        FileError::NotFound => err(ErrorCode::NotFound, "That file or folder does not exist on the server."),
        FileError::PermissionDenied => err(ErrorCode::AccessDenied, "The server does not allow this for your account."),
        FileError::Failed => err(
            ErrorCode::IoError,
            "The server could not do that. The name may exist already, the folder may not be empty, or its disk may be full.",
        ),
        FileError::Unsupported => err(ErrorCode::InvalidInput, "The server does not support that."),
        FileError::Lost => err(ErrorCode::Disconnected, "The connection to the server was lost."),
        FileError::Timeout => err(ErrorCode::Timeout, "The server did not respond in time."),
        FileError::Protocol => err(ErrorCode::ProtocolError, "The server's file service did not follow the protocol."),
    }
}

pub(crate) fn local_io(e: &std::io::Error) -> IpcError {
    match e.kind() {
        std::io::ErrorKind::StorageFull => err(ErrorCode::StorageFull, "There is not enough space on this computer."),
        std::io::ErrorKind::PermissionDenied => {
            err(ErrorCode::AccessDenied, "This computer does not allow writing or reading there.")
        }
        std::io::ErrorKind::NotFound => err(ErrorCode::NotFound, "The local file or folder is no longer there."),
        _ => err(ErrorCode::IoError, "The local file could not be read or written."),
    }
}

pub(crate) fn conflict() -> IpcError {
    err(ErrorCode::Conflict, "Something with that name is already there.")
}

pub(crate) fn kind(k: RemoteKind) -> RemoteEntryKind {
    match k {
        RemoteKind::File => RemoteEntryKind::File,
        RemoteKind::Dir => RemoteEntryKind::Dir,
        RemoteKind::Symlink => RemoteEntryKind::Symlink,
        RemoteKind::Other => RemoteEntryKind::Other,
    }
}

pub(crate) fn entry(name: String, attrs: &RemoteAttrs) -> RemoteEntry {
    RemoteEntry {
        name,
        kind: kind(attrs.kind),
        size: attrs.size,
        permissions: attrs.permissions,
        modified: attrs.modified,
    }
}

/// An absolute remote folder as the renderer sends it back (it came from a listing).
pub(crate) fn remote_dir(dir: &str) -> Result<&str, IpcError> {
    if !dir.starts_with('/') || dir.len() > MAX_REMOTE_PATH_LEN || dir.contains('\0') {
        return Err(err(ErrorCode::InvalidInput, "That is not a folder on the server."));
    }
    Ok(dir)
}

/// One name inside a folder: not empty, not `.`/`..`, no `/` or NUL, bounded.
pub(crate) fn remote_name(name: &str) -> Result<&str, IpcError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) || name.len() > MAX_FILE_NAME_LEN {
        return Err(err(ErrorCode::InvalidInput, "That name cannot be used on the server."));
    }
    Ok(name)
}

pub(crate) fn join(dir: &str, name: &str) -> Result<String, IpcError> {
    let path = format!("{}/{}", dir.trim_end_matches('/'), remote_name(name)?);
    if path.len() > MAX_REMOTE_PATH_LEN {
        return Err(err(ErrorCode::LimitExceeded, "That path is too long."));
    }
    Ok(path)
}

/// The folder above `path`, unless it is the root.
pub(crate) fn parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_owned()),
        Some(i) => Some(trimmed[..i].to_owned()),
        None => None,
    }
}

/// Whether a server-supplied name can be created as-is in a local folder on this platform.
/// Names are never altered silently: an unusable name is refused with a reason.
pub(crate) fn local_name_ok(name: &str) -> bool {
    if remote_name(name).is_err() || name.contains('\\') || name.chars().any(char::is_control) {
        return false;
    }
    if cfg!(windows) {
        const RESERVED: [&str; 22] = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
            "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        let stem = name.split('.').next().unwrap_or("").trim_end();
        if name.contains(['<', '>', ':', '"', '|', '?', '*'])
            || name.ends_with(['.', ' '])
            || RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
        {
            return false;
        }
    }
    true
}

pub(crate) fn temp_name(name: &str, token: &str) -> String {
    // Keeps the temporary name within the usual 255-byte limit whatever the target name is.
    let short: String = name.chars().take(64).collect();
    format!(".{short}.{}{TEMP_SUFFIX}", &token[..token.len().min(12)])
}

/// Sends progress at most every `PROGRESS_EVERY`.
pub(crate) struct Progress<'a> {
    sink: &'a dyn TransferSink,
    last: Instant,
    pub(crate) done: u64,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(sink: &'a dyn TransferSink) -> Self {
        Self { sink, last: Instant::now(), done: 0 }
    }

    fn add(&mut self, n: usize) {
        self.done += n as u64;
        if self.last.elapsed() >= PROGRESS_EVERY {
            self.last = Instant::now();
            self.sink.event(TransferEvent::Progress { done: self.done });
        }
    }
}

/// Resolves when the transfer is cancelled (or its owner is gone).
pub(crate) async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

pub(crate) enum Stop {
    Cancelled,
    Failed(IpcError),
}

impl From<IpcError> for Stop {
    fn from(e: IpcError) -> Self {
        Self::Failed(e)
    }
}

/// Copies a remote file into `file` (already created), checking for cancellation per chunk.
pub(crate) async fn pull(
    sftp: &Sftp,
    remote: &str,
    file: &mut tokio::fs::File,
    progress: &mut Progress<'_>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), Stop> {
    let mut reader = sftp.open_read(remote).await.map_err(from_file)?;
    let copied = async {
        loop {
            let chunk = tokio::select! {
                () = cancelled(cancel) => return Err(Stop::Cancelled),
                chunk = reader.next_chunk() => chunk.map_err(from_file)?,
            };
            let Some(chunk) = chunk else { break };
            file.write_all(&chunk).await.map_err(|e| local_io(&e))?;
            progress.add(chunk.len());
        }
        file.sync_all().await.map_err(|e| local_io(&e))?;
        Ok::<(), Stop>(())
    }
    .await;
    reader.close().await;
    copied
}

/// Copies a local file to a new remote file `remote` (owner-only while incomplete), verifies the
/// stored size, and returns the bytes written. On failure the remote file is removed.
pub(crate) async fn push(
    sftp: &Sftp,
    local: &Path,
    remote: &str,
    progress: &mut Progress<'_>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<u64, Stop> {
    let mut file = tokio::fs::File::open(local).await.map_err(|e| local_io(&e))?;
    let mut writer = sftp.create_new(remote, 0o600).await.map_err(from_file)?;
    let mut buf = vec![0u8; SFTP_CHUNK as usize * 4];
    let copied = async {
        loop {
            let n = tokio::select! {
                () = cancelled(cancel) => return Err(Stop::Cancelled),
                n = file.read(&mut buf) => n.map_err(|e| local_io(&e))?,
            };
            if n == 0 {
                break;
            }
            writer.write(&buf[..n]).await.map_err(from_file)?;
            progress.add(n);
        }
        Ok::<(), Stop>(())
    }
    .await;
    let result = match copied {
        Err(stop) => {
            writer.abandon().await;
            Err(stop)
        }
        Ok(()) => {
            async {
                let bytes = writer.finish().await.map_err(from_file)?;
                // The server must hold exactly what was sent.
                if sftp.stat(remote).await.map_err(from_file)?.size != Some(bytes) {
                    return Err(Stop::Failed(err(ErrorCode::IoError, "The server did not store the whole file.")));
                }
                Ok(bytes)
            }
            .await
        }
    };
    if result.is_err() {
        let _ = sftp.remove_file(remote).await;
    }
    result
}

pub(crate) struct Download {
    pub sftp: Arc<Sftp>,
    pub remote: String,
    pub local_dir: PathBuf,
    pub name: String,
    pub overwrite: bool,
    pub token: String,
}

/// Checks a download before it starts: a regular remote file, a usable local name, and no
/// conflict unless replacing was chosen. Returns the file's size.
pub(crate) async fn prepare_download(d: &Download) -> Result<Option<u64>, IpcError> {
    if !local_name_ok(&d.name) {
        return Err(err(ErrorCode::InvalidInput, "That name cannot be used for a file on this computer."));
    }
    let attrs = d.sftp.stat(&d.remote).await.map_err(from_file)?;
    if attrs.kind != RemoteKind::File {
        return Err(err(ErrorCode::InvalidInput, "Only files can be downloaded."));
    }
    let target = d.local_dir.join(&d.name);
    match tokio::fs::symlink_metadata(&target).await {
        Ok(meta) if meta.is_dir() => return Err(conflict()),
        Ok(_) if !d.overwrite => return Err(conflict()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(local_io(&e)),
    }
    match tokio::fs::metadata(&d.local_dir).await {
        Ok(meta) if meta.is_dir() => Ok(attrs.size),
        Ok(_) => Err(err(ErrorCode::InvalidInput, "Choose a folder on this computer.")),
        Err(e) => Err(local_io(&e)),
    }
}

pub(crate) async fn create_private(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).await
}

/// Moves the finished temporary file to `target`. Without `overwrite` this never replaces
/// anything: a hard link fails if the name exists, and filesystems without hard links fall back
/// to a check right before the rename.
async fn finish_local(temp: &Path, target: &Path, overwrite: bool) -> Result<(), IpcError> {
    if overwrite {
        if tokio::fs::symlink_metadata(target).await.is_ok_and(|m| m.is_dir()) {
            return Err(conflict());
        }
        return tokio::fs::rename(temp, target).await.map_err(|e| local_io(&e));
    }
    match tokio::fs::hard_link(temp, target).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(temp).await;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(conflict()),
        Err(_) => {
            if tokio::fs::symlink_metadata(target).await.is_ok() {
                return Err(conflict());
            }
            tokio::fs::rename(temp, target).await.map_err(|e| local_io(&e))
        }
    }
}

pub(crate) async fn run_download(d: Download, sink: &dyn TransferSink, mut cancel: watch::Receiver<bool>) {
    let temp = d.local_dir.join(temp_name(&d.name, &d.token));
    let target = d.local_dir.join(&d.name);
    let result = async {
        let mut file = create_private(&temp).await.map_err(|e| local_io(&e))?;
        let mut progress = Progress::new(sink);
        let copied = pull(&d.sftp, &d.remote, &mut file, &mut progress, &mut cancel).await;
        drop(file);
        copied?;
        finish_local(&temp, &target, d.overwrite).await?;
        Ok::<u64, Stop>(progress.done)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    sink.event(match result {
        Ok(bytes) => TransferEvent::Done { bytes, files: 1, skipped: 0 },
        Err(Stop::Cancelled) => TransferEvent::Cancelled,
        Err(Stop::Failed(error)) => TransferEvent::Failed { error },
    });
}

pub(crate) struct Upload {
    pub sftp: Arc<Sftp>,
    pub local: PathBuf,
    pub dir: String,
    pub name: String,
    pub overwrite: bool,
    pub token: String,
}

/// Checks an upload before it starts. Returns the local file's size and permission bits.
pub(crate) async fn prepare_upload(u: &Upload) -> Result<(u64, u32), IpcError> {
    remote_name(&u.name)?;
    let meta = tokio::fs::metadata(&u.local).await.map_err(|e| local_io(&e))?;
    if !meta.is_file() {
        return Err(err(ErrorCode::InvalidInput, "Only files can be uploaded."));
    }
    let target = join(&u.dir, &u.name)?;
    match u.sftp.lstat(&target).await {
        Ok(attrs) if attrs.kind == RemoteKind::Dir || !u.overwrite => return Err(conflict()),
        Ok(_) | Err(FileError::NotFound) => {}
        Err(e) => return Err(from_file(e)),
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let mode = 0o644;
    Ok((meta.len(), mode))
}

pub(crate) async fn run_upload(u: Upload, mode: u32, sink: &dyn TransferSink, mut cancel: watch::Receiver<bool>) {
    let (temp, target) = match (join(&u.dir, &temp_name(&u.name, &u.token)), join(&u.dir, &u.name)) {
        (Ok(t), Ok(f)) => (t, f),
        (Err(error), _) | (_, Err(error)) => {
            sink.event(TransferEvent::Failed { error });
            return;
        }
    };
    let result = async {
        let mut progress = Progress::new(sink);
        let bytes = push(&u.sftp, &u.local, &temp, &mut progress, &mut cancel).await?;
        let placed = async {
            u.sftp.set_permissions(&temp, mode).await.map_err(from_file)?;
            match u.sftp.lstat(&target).await {
                Ok(attrs) if attrs.kind == RemoteKind::Dir || !u.overwrite => return Err(conflict()),
                Ok(_) => u.sftp.remove_file(&target).await.map_err(from_file)?,
                Err(FileError::NotFound) => {}
                Err(e) => return Err(from_file(e)),
            }
            u.sftp.rename(&temp, &target).await.map_err(from_file)
        }
        .await;
        if placed.is_err() {
            let _ = u.sftp.remove_file(&temp).await;
        }
        placed?;
        Ok::<u64, Stop>(bytes)
    }
    .await;
    sink.event(match result {
        Ok(bytes) => TransferEvent::Done { bytes, files: 1, skipped: 0 },
        Err(Stop::Cancelled) => TransferEvent::Cancelled,
        Err(Stop::Failed(error)) => TransferEvent::Failed { error },
    });
}

pub(crate) fn started(id: String, name: String, direction: TransferDirection, total: Option<u64>) -> TransferStarted {
    TransferStarted { transfer_id: id, name, direction, total }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_names_and_paths_are_checked() {
        assert_eq!(join("/home/u", "a.txt").unwrap(), "/home/u/a.txt");
        assert_eq!(join("/", "etc").unwrap(), "/etc");
        assert_eq!(join("/srv/", "x").unwrap(), "/srv/x");
        for bad in ["", ".", "..", "a/b", "a\0b", &"x".repeat(256)] {
            assert!(remote_name(bad).is_err(), "{bad:?}");
        }
        assert!(remote_dir("relative").is_err());
        assert!(remote_dir("/ok\0no").is_err());
        assert!(remote_dir("/fine/path").is_ok());
        // Names that look odd but are legal on the server stay legal.
        assert!(remote_name("..hidden").is_ok());
        assert!(remote_name("-rf").is_ok());
        assert!(remote_name("name with spaces;$(x)").is_ok());
    }

    #[test]
    fn parents() {
        assert_eq!(parent("/"), None);
        assert_eq!(parent("/home"), Some("/".into()));
        assert_eq!(parent("/home/u/"), Some("/home".into()));
        assert_eq!(parent("/a/b/c"), Some("/a/b".into()));
    }

    #[test]
    fn local_names_refuse_traversal_and_platform_specials() {
        for bad in ["..", ".", "a/b", "a\\b", "line\nbreak", "tab\there", ""] {
            assert!(!local_name_ok(bad), "{bad:?}");
        }
        assert!(local_name_ok("report (1).pdf"));
        assert!(local_name_ok("日本語.txt"));
        if cfg!(windows) {
            for bad in ["CON", "nul.txt", "a:b", "trailing.", "trailing ", "q?"] {
                assert!(!local_name_ok(bad), "{bad:?}");
            }
        }
    }

    #[test]
    fn temporary_names_are_hidden_bounded_and_distinct() {
        let long = "n".repeat(255);
        let t = temp_name(&long, "abcdef0123456789");
        assert!(t.starts_with('.') && t.ends_with(TEMP_SUFFIX) && t.len() < 100);
        assert_ne!(temp_name("a", "111111111111"), temp_name("a", "222222222222"));
    }
}

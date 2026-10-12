//! SFTP over an authenticated connection (Phase 06).
//!
//! Built on `russh-sftp`'s raw client so every response that can grow is bounded here: a
//! directory listing stops at a caller-given number of entries, file reads and writes keep a
//! fixed number of requests in flight, and every request has a time limit. Nothing here runs a
//! remote shell; paths travel as SFTP protocol fields only.

use std::collections::VecDeque;
use std::sync::Arc;

use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use tokio::task::JoinHandle;

/// Bytes asked for in one read request, and sent in one write request. OpenSSH serves up to
/// 255 KiB per read; 32 KiB is what every server accepts.
pub const SFTP_CHUNK: u32 = 32 * 1024;
/// Requests kept in flight per open file (so at most 512 KiB buffered per transfer).
const IN_FLIGHT: usize = 16;
/// Seconds a single SFTP request may take.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Why a file operation failed. Messages for users are chosen by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileError {
    NotFound,
    PermissionDenied,
    /// The server reported a generic failure (for example: the target exists, the folder is not
    /// empty, the disk is full).
    Failed,
    /// The server does not support the operation.
    Unsupported,
    /// The SFTP channel or the connection is gone.
    Lost,
    Timeout,
    /// The server sent something outside the protocol or beyond a limit.
    Protocol,
}

impl FileError {
    fn from_sftp(err: &SftpError) -> Self {
        match err {
            SftpError::Status(status) => match status.status_code {
                StatusCode::NoSuchFile => Self::NotFound,
                StatusCode::PermissionDenied => Self::PermissionDenied,
                StatusCode::OpUnsupported => Self::Unsupported,
                StatusCode::NoConnection | StatusCode::ConnectionLost => Self::Lost,
                StatusCode::BadMessage => Self::Protocol,
                StatusCode::Ok | StatusCode::Eof | StatusCode::Failure => Self::Failed,
            },
            SftpError::Timeout => Self::Timeout,
            SftpError::IO(_) => Self::Lost,
            // russh-sftp reports a session whose channel has gone away (the connection dropped)
            // through these messages; anything else in this variant is a protocol problem.
            SftpError::UnexpectedBehavior(text) if session_gone(text) => Self::Lost,
            SftpError::Limited(_) | SftpError::UnexpectedPacket | SftpError::UnexpectedBehavior(_) => Self::Protocol,
        }
    }
}

fn session_gone(text: &str) -> bool {
    text == "sender dropped"
        || text == "session closed"
        || text.starts_with("SendError")
        || text.starts_with("RecvError")
}

fn check<T>(result: Result<T, SftpError>) -> Result<T, FileError> {
    result.map_err(|e| FileError::from_sftp(&e))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// What the server reports about one path. Every field is optional in the protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAttrs {
    pub kind: RemoteKind,
    pub size: Option<u64>,
    /// Permission bits only (`0o7777`).
    pub permissions: Option<u32>,
    /// Seconds since the Unix epoch.
    pub modified: Option<u64>,
}

impl RemoteAttrs {
    fn from_sftp(attrs: &FileAttributes) -> Self {
        let kind = match attrs.permissions.map(|p| p & 0o170_000) {
            Some(0o040_000) => RemoteKind::Dir,
            Some(0o100_000) => RemoteKind::File,
            Some(0o120_000) => RemoteKind::Symlink,
            _ => RemoteKind::Other,
        };
        Self {
            kind,
            size: attrs.size,
            permissions: attrs.permissions.map(|p| p & 0o7777),
            modified: attrs.mtime.map(u64::from),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDirEntry {
    /// The name as the server sent it (untrusted text; may contain anything but `/`).
    pub name: String,
    pub attrs: RemoteAttrs,
}

/// An SFTP session on its own channel of a [`crate::VerifiedConnection`].
pub struct Sftp {
    raw: Arc<RawSftpSession>,
}

impl core::fmt::Debug for Sftp {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Sftp")
    }
}

impl Sftp {
    pub(crate) async fn start(stream: russh::ChannelStream<russh::client::Msg>) -> Result<Self, FileError> {
        let raw = RawSftpSession::new(stream);
        raw.set_timeout(REQUEST_TIMEOUT_SECS);
        check(raw.init().await)?;
        Ok(Self { raw: Arc::new(raw) })
    }

    /// The absolute form of `path` (`"."` is the login directory).
    pub async fn canonicalize(&self, path: &str) -> Result<String, FileError> {
        let name = check(self.raw.realpath(path).await)?;
        name.files.into_iter().next().map(|f| f.filename).ok_or(FileError::Protocol)
    }

    /// Follows symbolic links.
    pub async fn stat(&self, path: &str) -> Result<RemoteAttrs, FileError> {
        Ok(RemoteAttrs::from_sftp(&check(self.raw.stat(path).await)?.attrs))
    }

    /// Does not follow a final symbolic link.
    pub async fn lstat(&self, path: &str) -> Result<RemoteAttrs, FileError> {
        Ok(RemoteAttrs::from_sftp(&check(self.raw.lstat(path).await)?.attrs))
    }

    /// Whether anything (file, folder, link, even a dangling link) is at `path`.
    pub async fn exists(&self, path: &str) -> Result<bool, FileError> {
        match self.lstat(path).await {
            Ok(_) => Ok(true),
            Err(FileError::NotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Lists a directory, without `.` and `..`. Stops after `max` entries and reports whether
    /// there were more, so a server cannot make the client hold an unbounded listing.
    pub async fn read_dir(&self, path: &str, max: usize) -> Result<(Vec<RemoteDirEntry>, bool), FileError> {
        let handle = check(self.raw.opendir(path).await)?.handle;
        let mut entries = Vec::new();
        let mut truncated = false;
        let result = loop {
            match self.raw.readdir(handle.as_str()).await {
                Ok(name) => {
                    for file in name.files {
                        if file.filename == "." || file.filename == ".." {
                            continue;
                        }
                        if entries.len() >= max {
                            truncated = true;
                            break;
                        }
                        entries
                            .push(RemoteDirEntry { attrs: RemoteAttrs::from_sftp(&file.attrs), name: file.filename });
                    }
                    if truncated {
                        break Ok(());
                    }
                }
                Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => break Ok(()),
                Err(e) => break Err(FileError::from_sftp(&e)),
            }
        };
        let _ = self.raw.close(handle).await;
        result.map(|()| (entries, truncated))
    }

    pub async fn create_dir(&self, path: &str) -> Result<(), FileError> {
        check(self.raw.mkdir(path, FileAttributes::empty()).await).map(drop)
    }

    /// Fails if `to` exists (SFTP version 3 rename semantics).
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        check(self.raw.rename(from, to).await).map(drop)
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), FileError> {
        check(self.raw.remove(path).await).map(drop)
    }

    /// Removes an empty directory.
    pub async fn remove_dir(&self, path: &str) -> Result<(), FileError> {
        check(self.raw.rmdir(path).await).map(drop)
    }

    pub async fn set_permissions(&self, path: &str, mode: u32) -> Result<(), FileError> {
        let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() };
        check(self.raw.setstat(path, attrs).await).map(drop)
    }

    pub async fn open_read(&self, path: &str) -> Result<RemoteReader, FileError> {
        let handle = check(self.raw.open(path, OpenFlags::READ, FileAttributes::empty()).await)?.handle;
        Ok(RemoteReader { raw: Arc::clone(&self.raw), handle, next: 0, pending: VecDeque::new(), done: false })
    }

    /// Creates a new file that must not exist yet, with permission bits `mode`.
    pub async fn create_new(&self, path: &str, mode: u32) -> Result<RemoteWriter, FileError> {
        let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() };
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE;
        let handle = check(self.raw.open(path, flags, attrs).await)?.handle;
        Ok(RemoteWriter { raw: Arc::clone(&self.raw), handle, offset: 0, pending: VecDeque::new() })
    }
}

/// Aborts outstanding requests when dropped (their late responses are discarded).
struct Pending<T>(JoinHandle<T>);

impl<T> Drop for Pending<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

type ReadResult = Result<russh_sftp::protocol::Data, SftpError>;

/// Reads a remote file front to back with several requests in flight.
pub struct RemoteReader {
    raw: Arc<RawSftpSession>,
    handle: String,
    next: u64,
    pending: VecDeque<(u64, Pending<ReadResult>)>,
    done: bool,
}

impl core::fmt::Debug for RemoteReader {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("RemoteReader").field("next", &self.next).finish_non_exhaustive()
    }
}

impl RemoteReader {
    fn fill(&mut self) {
        while self.pending.len() < IN_FLIGHT {
            let (raw, handle, offset) = (Arc::clone(&self.raw), self.handle.clone(), self.next);
            let task = tokio::spawn(async move { raw.read(handle, offset, SFTP_CHUNK).await });
            self.pending.push_back((offset, Pending(task)));
            self.next += u64::from(SFTP_CHUNK);
        }
    }

    /// The next bytes of the file in order, or `None` at its end. Never more than one chunk.
    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, FileError> {
        if self.done {
            return Ok(None);
        }
        self.fill();
        let Some((offset, mut task)) = self.pending.pop_front() else { return Ok(None) };
        let result = (&mut task.0).await.map_err(|_| FileError::Lost)?;
        match result {
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => {
                self.done = true;
                self.pending.clear();
                Ok(None)
            }
            Err(e) => Err(FileError::from_sftp(&e)),
            Ok(data) if data.data.is_empty() => {
                self.done = true;
                self.pending.clear();
                Ok(None)
            }
            Ok(data) => {
                let got = data.data.len() as u64;
                if got > u64::from(SFTP_CHUNK) {
                    return Err(FileError::Protocol);
                }
                if got < u64::from(SFTP_CHUNK) {
                    // A short read: later requests started at offsets past a gap. Drop them and
                    // continue right after the bytes actually received.
                    self.pending.clear();
                    self.next = offset + got;
                }
                Ok(Some(data.data))
            }
        }
    }

    pub async fn close(mut self) {
        self.pending.clear();
        let _ = self.raw.close(std::mem::take(&mut self.handle)).await;
    }
}

type WriteResult = Result<russh_sftp::protocol::Status, SftpError>;

/// Writes a new remote file front to back with several requests in flight.
pub struct RemoteWriter {
    raw: Arc<RawSftpSession>,
    handle: String,
    offset: u64,
    pending: VecDeque<Pending<WriteResult>>,
}

impl core::fmt::Debug for RemoteWriter {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("RemoteWriter").field("offset", &self.offset).finish_non_exhaustive()
    }
}

impl RemoteWriter {
    async fn settle_one(&mut self) -> Result<(), FileError> {
        if let Some(mut task) = self.pending.pop_front() {
            check((&mut task.0).await.map_err(|_| FileError::Lost)?)?;
        }
        Ok(())
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<(), FileError> {
        for piece in data.chunks(SFTP_CHUNK as usize) {
            if self.pending.len() >= IN_FLIGHT {
                self.settle_one().await?;
            }
            let (raw, handle, offset, bytes) =
                (Arc::clone(&self.raw), self.handle.clone(), self.offset, piece.to_vec());
            self.pending.push_back(Pending(tokio::spawn(async move { raw.write(handle, offset, bytes).await })));
            self.offset += piece.len() as u64;
        }
        Ok(())
    }

    /// Waits for every write to be confirmed, then closes the file.
    pub async fn finish(mut self) -> Result<u64, FileError> {
        while !self.pending.is_empty() {
            self.settle_one().await?;
        }
        check(self.raw.close(std::mem::take(&mut self.handle)).await)?;
        Ok(self.offset)
    }

    /// Abandons the file (outstanding writes are dropped); the caller removes it.
    pub async fn abandon(mut self) {
        self.pending.clear();
        let _ = self.raw.close(std::mem::take(&mut self.handle)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_session_is_a_lost_link_not_a_protocol_error() {
        for text in ["sender dropped", "session closed", "SendError: channel closed", "RecvError: channel closed"] {
            assert_eq!(FileError::from_sftp(&SftpError::UnexpectedBehavior(text.into())), FileError::Lost, "{text}");
        }
        assert_eq!(
            FileError::from_sftp(&SftpError::UnexpectedBehavior("Duplicate version".into())),
            FileError::Protocol
        );
        assert_eq!(FileError::from_sftp(&SftpError::UnexpectedPacket), FileError::Protocol);
    }
}

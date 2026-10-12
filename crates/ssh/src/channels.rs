use bytes::Bytes;
use russh::client::Msg;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};

use crate::{SshError, Stage};

/// Terminal request parameters. Dimensions are clamped to sane bounds before use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyRequest {
    pub term: String,
    pub cols: u32,
    pub rows: u32,
}

pub(crate) const MAX_DIMENSION: u32 = 1000;

pub(crate) fn clamp_dimension(value: u32) -> u32 {
    value.clamp(1, MAX_DIMENSION)
}

/// What an interactive channel produces. Output bytes are untrusted remote data (INV-08).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    Output(Bytes),
    /// stderr-style extended data (rare with a PTY).
    ExtendedOutput(Bytes),
    ExitStatus(u32),
    /// Remote process ended by a signal; the name is untrusted text.
    ExitSignal(String),
    Eof,
    /// The connection ended without the server closing the channel (network drop, server
    /// process killed). Distinguishes a lost link from a session that ended normally.
    ConnectionLost,
}

/// Reading half of an interactive shell channel.
///
/// Backpressure: russh buffers a bounded number of channel messages
/// (`Config::channel_buffer_size`) and stops reading the TCP stream when the consumer does not call
/// [`ShellReader::next`], which in turn closes the SSH flow-control window for the server. Not
/// calling `next` is therefore the way to pause the remote producer; nothing is dropped.
pub struct ShellReader {
    pub(crate) read: ChannelReadHalf,
    pub(crate) ended: bool,
}

impl core::fmt::Debug for ShellReader {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ShellReader")
    }
}

impl ShellReader {
    /// Next event, or `None` once the channel is closed. A connection that ends without the
    /// server closing the channel yields [`ShellEvent::ConnectionLost`] once, then `None`.
    /// Zero-length data is skipped.
    pub async fn next(&mut self) -> Option<ShellEvent> {
        if self.ended {
            return None;
        }
        loop {
            let Some(message) = self.read.wait().await else {
                self.ended = true;
                return Some(ShellEvent::ConnectionLost);
            };
            match message {
                ChannelMsg::Data { data } if !data.is_empty() => {
                    return Some(ShellEvent::Output(data));
                }
                ChannelMsg::ExtendedData { data, .. } if !data.is_empty() => {
                    return Some(ShellEvent::ExtendedOutput(data));
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    return Some(ShellEvent::ExitStatus(exit_status));
                }
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    return Some(ShellEvent::ExitSignal(format!("{signal_name:?}")));
                }
                ChannelMsg::Eof => return Some(ShellEvent::Eof),
                ChannelMsg::Close => {
                    self.ended = true;
                    return None;
                }
                _ => {}
            }
        }
    }
}

/// Writing half of an interactive shell channel. Cheap to share behind an `Arc`.
pub struct ShellWriter {
    /// Always `Some` until dropped.
    pub(crate) write: Option<ChannelWriteHalf<Msg>>,
    /// Close the channel when this is dropped. Set for a channel on a connection that stays open
    /// after it (a command channel next to the session's own shell): dropping alone sends nothing,
    /// so without this the server would keep the channel, and the command, running.
    pub(crate) close_on_drop: bool,
}

impl Drop for ShellWriter {
    fn drop(&mut self) {
        if !self.close_on_drop {
            return;
        }
        if let (Some(write), Ok(runtime)) = (self.write.take(), tokio::runtime::Handle::try_current()) {
            runtime.spawn(async move {
                let _ = write.eof().await;
                let _ = write.close().await;
            });
        }
    }
}

impl core::fmt::Debug for ShellWriter {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ShellWriter")
    }
}

impl ShellWriter {
    /// The write half; it is taken only on drop, so this never fails while `self` is usable.
    fn half(&self) -> Result<&ChannelWriteHalf<Msg>, SshError> {
        self.write.as_ref().ok_or(SshError::Disconnected(Stage::Connected))
    }

    /// Sends input bytes. Waits when the remote window is full.
    pub async fn write(&self, data: &[u8]) -> Result<(), SshError> {
        self.half()?
            .data_bytes(Bytes::copy_from_slice(data))
            .await
            .map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.half()?
            .window_change(clamp_dimension(cols), clamp_dimension(rows), 0, 0)
            .await
            .map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }

    pub async fn eof(&self) -> Result<(), SshError> {
        self.half()?.eof().await.map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.half()?.close().await.map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }
}

/// Result of a non-interactive command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_are_clamped_to_a_sane_range() {
        assert_eq!(clamp_dimension(0), 1);
        assert_eq!(clamp_dimension(1), 1);
        assert_eq!(clamp_dimension(80), 80);
        assert_eq!(clamp_dimension(MAX_DIMENSION), MAX_DIMENSION);
        assert_eq!(clamp_dimension(u32::MAX), MAX_DIMENSION);
    }
}

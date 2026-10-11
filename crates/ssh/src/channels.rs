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
}

/// Reading half of an interactive shell channel.
///
/// Backpressure: russh buffers a bounded number of channel messages
/// (`Config::channel_buffer_size`) and stops reading the TCP stream when the consumer does not call
/// [`ShellReader::next`], which in turn closes the SSH flow-control window for the server. Not
/// calling `next` is therefore the way to pause the remote producer; nothing is dropped.
pub struct ShellReader {
    pub(crate) read: ChannelReadHalf,
}

impl core::fmt::Debug for ShellReader {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ShellReader")
    }
}

impl ShellReader {
    /// Next event, or `None` once the channel is closed. Zero-length data is skipped.
    pub async fn next(&mut self) -> Option<ShellEvent> {
        loop {
            match self.read.wait().await? {
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
                ChannelMsg::Close => return None,
                _ => {}
            }
        }
    }
}

/// Writing half of an interactive shell channel. Cheap to share behind an `Arc`.
pub struct ShellWriter {
    pub(crate) write: ChannelWriteHalf<Msg>,
}

impl core::fmt::Debug for ShellWriter {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ShellWriter")
    }
}

impl ShellWriter {
    /// Sends input bytes. Waits when the remote window is full.
    pub async fn write(&self, data: &[u8]) -> Result<(), SshError> {
        self.write
            .data_bytes(Bytes::copy_from_slice(data))
            .await
            .map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.write
            .window_change(clamp_dimension(cols), clamp_dimension(rows), 0, 0)
            .await
            .map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }

    pub async fn eof(&self) -> Result<(), SshError> {
        self.write.eof().await.map_err(|e| SshError::from_russh(&e, Stage::Connected))
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.write.close().await.map_err(|e| SshError::from_russh(&e, Stage::Connected))
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

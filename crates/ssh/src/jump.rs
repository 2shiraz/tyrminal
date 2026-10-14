//! Jump hosts (`ProxyJump`): a byte stream to the next hop through an authenticated connection.
//!
//! The next hop's SSH session runs over this stream with [`crate::connect_stream`], so it gets
//! its own key exchange and its own host-key verification before any credential is sent to it:
//! every hop is verified, not just the first (spec §4.5). A bastion only ever sees the
//! next hop's encrypted traffic.

use std::pin::Pin;
use std::task::{Context, Poll};

use russh::ChannelStream;
use russh::client::Msg;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{SshError, Stage, VerifiedConnection};

/// A `direct-tcpip` channel used as the transport of the next hop.
pub struct HopStream {
    inner: ChannelStream<Msg>,
}

impl core::fmt::Debug for HopStream {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("HopStream")
    }
}

impl AsyncRead for HopStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for HopStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl VerifiedConnection {
    /// Asks this (authenticated) server to open a TCP connection to `host:port` and returns it as
    /// a stream for the next hop. A server that refuses (`AllowTcpForwarding no`, `PermitOpen`)
    /// yields [`SshError::ChannelDenied`]; one that cannot reach the destination yields
    /// [`SshError::Unreachable`].
    pub async fn open_hop(&self, host: &str, port: u16) -> Result<HopStream, SshError> {
        if !self.is_authenticated() {
            return Err(SshError::NotAuthenticated);
        }
        let host = host.trim();
        if host.is_empty() || host.len() > 253 || !host.bytes().all(|b| b.is_ascii_graphic()) || port == 0 {
            return Err(SshError::Resolve);
        }
        let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
        // The originator is reported as this client's side of the bastion link, which carries no
        // information the server does not already have.
        let open = self.handle.channel_open_direct_tcpip(bare, u32::from(port), "127.0.0.1", 0);
        match tokio::time::timeout(self.request_timeout, open).await {
            Err(_) => Err(SshError::Timeout(Stage::Connecting)),
            Ok(Ok(channel)) => Ok(HopStream { inner: channel.into_stream() }),
            Ok(Err(russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed))) => {
                Err(SshError::Unreachable)
            }
            Ok(Err(russh::Error::ChannelOpenFailure(_))) => Err(SshError::ChannelDenied),
            Ok(Err(err)) => Err(SshError::from_russh(&err, Stage::Connecting)),
        }
    }
}

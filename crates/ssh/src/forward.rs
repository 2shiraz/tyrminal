//! Port forwarding over a verified, authenticated connection (BUILD_SPEC Phase 07).
//!
//! Three kinds, each with the same lifecycle (a [`ForwardHandle`] that reports statistics and
//! stops the forward when told to or when dropped):
//!
//! - **local** (`-L`): a listener on this machine; each accepted connection becomes a
//!   `direct-tcpip` channel to a destination the server can reach.
//! - **remote** (`-R`): the server listens (`tcpip-forward`); each connection it accepts arrives
//!   as a `forwarded-tcpip` channel and is connected to a destination this machine can reach.
//! - **dynamic** (`-D`): a SOCKS5 listener on this machine; each `CONNECT` request becomes a
//!   `direct-tcpip` channel to the requested destination.
//!
//! Exposure policy (BUILD_SPEC Phase 07 and §9.3 "Tunnels"): a listener binds to a loopback
//! address unless the caller passes an explicit external-bind approval. The check runs here, in
//! the adapter, before any socket or server request is made, so no caller can skip it. A local
//! listener's address must be an IP literal or `localhost` (mapped to `127.0.0.1` without a DNS
//! lookup), so a name can never resolve to something the policy did not see.
//!
//! The server can only deliver `forwarded-tcpip` channels for ports this connection asked it to
//! forward; anything else is refused in the connection handler (`client.rs`).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use russh::client::Msg;
use russh::{Channel, ChannelOpenFailure};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, mpsc, watch};

use crate::VerifiedConnection;

/// How long a SOCKS5 client has to finish its handshake, and a remote-forward destination to
/// accept a connection.
pub const FORWARD_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a listener re-checks that its SSH connection is still up, so a lost link never
/// leaves a listener bound (reconnect cleanup).
const LINK_CHECK_EVERY: Duration = Duration::from_millis(500);
/// Forwarded-tcpip channels waiting to be connected, per remote forward.
const PENDING_CHANNELS: usize = 16;

/// Forwarding failures with fixed messages. No address or remote text is embedded.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ForwardError {
    /// The listener would be reachable from other machines and no approval was given.
    #[error("binding to a non-loopback address needs explicit approval")]
    ExternalBindNotApproved,
    #[error("the address or port is not valid")]
    InvalidAddress,
    /// The local port is in use or the address is not on this machine.
    #[error("the listener could not be opened")]
    BindFailed,
    /// The server refused the forwarding request (for example `AllowTcpForwarding no`).
    #[error("the server refused port forwarding")]
    Denied,
    #[error("the connection is not authenticated")]
    NotAuthenticated,
    #[error("the connection was lost")]
    Disconnected,
    #[error("the server did not answer in time")]
    Timeout,
}

impl ForwardError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::ExternalBindNotApproved => "EXTERNAL_BIND_NOT_APPROVED",
            Self::InvalidAddress => "INVALID_ADDRESS",
            Self::BindFailed => "BIND_FAILED",
            Self::Denied => "FORWARDING_DENIED",
            Self::NotAuthenticated => "AUTH_REQUIRED",
            Self::Disconnected => "DISCONNECTED",
            Self::Timeout => "TIMEOUT",
        }
    }
}

// ---------- exposure policy ----------

/// Who can reach a listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindScope {
    /// Only this machine (127.0.0.0/8, `::1`, `localhost`).
    Loopback,
    /// Other machines may reach it (a LAN address, `0.0.0.0`, `::`, or on the server side an
    /// empty or wildcard address).
    External,
}

/// Parses a local listener address: an IP literal (IPv6 optionally in brackets) or `localhost`.
/// Host names are refused, so what is checked is exactly what is bound.
pub fn local_bind_addr(host: &str) -> Result<IpAddr, ForwardError> {
    let host = host.trim();
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    bare.parse::<IpAddr>().map_err(|_| ForwardError::InvalidAddress)
}

pub fn local_bind_scope(addr: IpAddr) -> BindScope {
    // An IPv4-mapped loopback (::ffff:127.0.0.1) is loopback too.
    let loopback = match addr {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    };
    if loopback { BindScope::Loopback } else { BindScope::External }
}

/// Scope of a server-side listen address as OpenSSH interprets it: `localhost` and loopback
/// literals stay on the server; an empty address, `*`, a wildcard or anything else may be
/// reachable from other machines (subject to the server's `GatewayPorts`).
pub fn remote_bind_scope(host: &str) -> BindScope {
    let host = host.trim();
    if host.eq_ignore_ascii_case("localhost") {
        return BindScope::Loopback;
    }
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    match bare.parse::<IpAddr>() {
        Ok(addr) => local_bind_scope(addr),
        Err(_) => BindScope::External,
    }
}

/// A destination host as sent to the server or connected to: printable ASCII or a bracketed
/// IPv6 literal, at most 253 bytes, no whitespace or control characters.
fn valid_destination(host: &str) -> bool {
    !host.is_empty() && host.len() <= 253 && host.bytes().all(|b| b.is_ascii_graphic())
}

// ---------- lifecycle and statistics ----------

/// Live counters of one forward.
#[derive(Debug, Default)]
pub struct ForwardStats {
    active: AtomicU32,
    accepted: AtomicU64,
    /// Refused because the connection limit was reached.
    refused: AtomicU64,
    /// The destination could not be reached, or the server refused the channel.
    failed: AtomicU64,
    /// Bytes from the connecting client towards the destination, counted as they pass.
    bytes_out: AtomicU64,
    bytes_in: AtomicU64,
}

/// A point-in-time copy of [`ForwardStats`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StatsSnapshot {
    pub active: u32,
    pub accepted: u64,
    pub refused: u64,
    pub failed: u64,
    pub bytes_out: u64,
    pub bytes_in: u64,
}

impl ForwardStats {
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            active: self.active.load(Ordering::Relaxed),
            accepted: self.accepted.load(Ordering::Relaxed),
            refused: self.refused.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            bytes_out: self.bytes_out.load(Ordering::Relaxed),
            bytes_in: self.bytes_in.load(Ordering::Relaxed),
        }
    }
}

/// Why a forward stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardEnd {
    /// [`ForwardHandle::stop`] was called or the handle was dropped.
    Stopped,
    /// The SSH connection ended; the listener was closed.
    ConnectionLost,
    /// The listener failed while running.
    ListenerFailed,
}

/// A running forward. Dropping it stops the forward: the listener closes (or the server is
/// asked to cancel its listener) and open connections are closed.
#[derive(Debug)]
pub struct ForwardHandle {
    bound: SocketAddr,
    stats: Arc<ForwardStats>,
    stop: watch::Sender<bool>,
    ended: watch::Receiver<Option<ForwardEnd>>,
}

impl ForwardHandle {
    /// Where the listener is bound. For a remote forward this is the server-side port (the
    /// address part is unspecified, since only the server knows it).
    pub fn bound(&self) -> SocketAddr {
        self.bound
    }

    pub fn stats(&self) -> StatsSnapshot {
        self.stats.snapshot()
    }

    /// `None` while running.
    pub fn ended(&self) -> Option<ForwardEnd> {
        *self.ended.borrow()
    }

    /// Resolves once the forward has stopped, with the reason.
    pub async fn wait_ended(&self) -> ForwardEnd {
        let mut ended = self.ended.clone();
        match ended.wait_for(Option::is_some).await {
            Ok(end) => end.unwrap_or(ForwardEnd::Stopped),
            Err(_) => ForwardEnd::Stopped,
        }
    }

    /// Stops the forward and waits (bounded) until its listener is closed.
    pub async fn stop(&self) {
        self.stop.send_replace(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.wait_ended()).await;
    }
}

impl Drop for ForwardHandle {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

/// Per-connection bookkeeping shared by the three kinds.
struct Lifecycle {
    stats: Arc<ForwardStats>,
    stop: watch::Receiver<bool>,
    ended: watch::Sender<Option<ForwardEnd>>,
    slots: Arc<Semaphore>,
}

fn lifecycle(max_connections: u32) -> (Lifecycle, watch::Sender<bool>, watch::Receiver<Option<ForwardEnd>>) {
    let (stop_tx, stop_rx) = watch::channel(false);
    let (ended_tx, ended_rx) = watch::channel(None);
    let lifecycle = Lifecycle {
        stats: Arc::new(ForwardStats::default()),
        stop: stop_rx,
        ended: ended_tx,
        slots: Arc::new(Semaphore::new(max_connections.max(1) as usize)),
    };
    (lifecycle, stop_tx, ended_rx)
}

/// Resolves once the forward is told to stop (or its handle is gone).
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|s| *s).await;
}

/// Resolves when the SSH connection is gone or closed.
async fn link_lost(conn: &Weak<VerifiedConnection>) {
    let mut tick = tokio::time::interval(LINK_CHECK_EVERY);
    loop {
        tick.tick().await;
        match conn.upgrade() {
            Some(c) if !c.is_closed() => {}
            _ => return,
        }
    }
}

/// Counts the bytes read through it into a shared counter, as they pass.
struct Counted<'a, S> {
    inner: S,
    counter: &'a AtomicU64,
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<'_, S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let poll = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        let read = buf.filled().len().saturating_sub(before);
        self.counter.fetch_add(read as u64, Ordering::Relaxed);
        poll
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<'_, S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        data: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Copies both ways until both sides have closed, counting bytes as they pass. `stop` ends the
/// copy early (the forward was stopped).
async fn relay<A, B>(client: A, target: B, stats: &ForwardStats, mut stop: watch::Receiver<bool>)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let mut client = Counted { inner: client, counter: &stats.bytes_out };
    let mut target = Counted { inner: target, counter: &stats.bytes_in };
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut client, &mut target) => {}
        () = stopped(&mut stop) => {}
    }
    let _ = client.shutdown().await;
    let _ = target.shutdown().await;
}

fn require_authenticated(conn: &VerifiedConnection) -> Result<(), ForwardError> {
    if conn.is_closed() {
        return Err(ForwardError::Disconnected);
    }
    if !conn.is_authenticated() { Err(ForwardError::NotAuthenticated) } else { Ok(()) }
}

async fn open_direct(
    conn: &Weak<VerifiedConnection>,
    host: &str,
    port: u16,
    origin: SocketAddr,
) -> Result<Channel<Msg>, ChannelOpenFailure> {
    let conn = conn.upgrade().ok_or(ChannelOpenFailure::ConnectFailed)?;
    let open =
        conn.handle.channel_open_direct_tcpip(host, u32::from(port), origin.ip().to_string(), u32::from(origin.port()));
    match tokio::time::timeout(conn.request_timeout, open).await {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(russh::Error::ChannelOpenFailure(reason))) => Err(reason),
        _ => Err(ChannelOpenFailure::ConnectFailed),
    }
}

/// Binds a local listener after the exposure check.
async fn bind_local(host: &str, port: u16, approve_external: bool) -> Result<TcpListener, ForwardError> {
    let addr = local_bind_addr(host)?;
    if local_bind_scope(addr) == BindScope::External && !approve_external {
        return Err(ForwardError::ExternalBindNotApproved);
    }
    TcpListener::bind(SocketAddr::new(addr, port)).await.map_err(|_| ForwardError::BindFailed)
}

// ---------- local forwarding ----------

/// `-L [bind_host:]bind_port:dest_host:dest_port`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalForward {
    pub bind_host: String,
    /// 0 picks a free port; see [`ForwardHandle::bound`].
    pub bind_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
    /// Explicit user approval for a non-loopback listener. Ignored for loopback addresses.
    pub approve_external: bool,
    /// Simultaneous connections; further ones are accepted and closed at once.
    pub max_connections: u32,
}

pub async fn start_local(conn: &Arc<VerifiedConnection>, spec: &LocalForward) -> Result<ForwardHandle, ForwardError> {
    require_authenticated(conn)?;
    if !valid_destination(&spec.dest_host) || spec.dest_port == 0 {
        return Err(ForwardError::InvalidAddress);
    }
    let listener = bind_local(&spec.bind_host, spec.bind_port, spec.approve_external).await?;
    let bound = listener.local_addr().map_err(|_| ForwardError::BindFailed)?;
    let (life, stop, ended) = lifecycle(spec.max_connections);
    let stats = Arc::clone(&life.stats);
    let weak = Arc::downgrade(conn);
    let (dest_host, dest_port) = (spec.dest_host.clone(), spec.dest_port);
    tokio::spawn(async move {
        let mut stop_rx = life.stop.clone();
        let end = loop {
            tokio::select! {
                () = stopped(&mut stop_rx) => break ForwardEnd::Stopped,
                () = link_lost(&weak) => break ForwardEnd::ConnectionLost,
                accepted = listener.accept() => {
                    let Ok((client, origin)) = accepted else { break ForwardEnd::ListenerFailed };
                    let Ok(permit) = Arc::clone(&life.slots).try_acquire_owned() else {
                        life.stats.refused.fetch_add(1, Ordering::Relaxed);
                        drop(client);
                        continue;
                    };
                    life.stats.accepted.fetch_add(1, Ordering::Relaxed);
                    let (weak, host, stats, stop) = (weak.clone(), dest_host.clone(), Arc::clone(&life.stats), life.stop.clone());
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = client.set_nodelay(true);
                        match open_direct(&weak, &host, dest_port, origin).await {
                            Ok(channel) => {
                                stats.active.fetch_add(1, Ordering::Relaxed);
                                relay(client, channel.into_stream(), &stats, stop).await;
                                stats.active.fetch_sub(1, Ordering::Relaxed);
                            }
                            Err(_) => {
                                stats.failed.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                }
            }
        };
        // The listener closes here, before the end is reported.
        drop(listener);
        life.ended.send_replace(Some(end));
    });
    Ok(ForwardHandle { bound, stats, stop, ended })
}

// ---------- remote forwarding ----------

/// `-R [remote_host:]remote_port:dest_host:dest_port`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteForward {
    /// Server-side listen address. Empty, `*` or a wildcard means every interface of the
    /// server (if its `GatewayPorts` allows); that needs `approve_external`.
    pub remote_host: String,
    /// 0 lets the server pick; see [`ForwardHandle::bound`].
    pub remote_port: u16,
    /// Reached from this machine.
    pub dest_host: String,
    pub dest_port: u16,
    pub approve_external: bool,
    pub max_connections: u32,
}

/// A forwarded-tcpip channel and where the server says it came in.
pub(crate) struct Forwarded {
    pub channel: Channel<Msg>,
}

/// The remote forwards this connection asked for: the only `forwarded-tcpip` channels the
/// connection accepts. Keyed by server-side port.
#[derive(Default)]
pub(crate) struct Routes {
    remote: Mutex<HashMap<u32, mpsc::Sender<Forwarded>>>,
}

impl Routes {
    fn remote(&self) -> std::sync::MutexGuard<'_, HashMap<u32, mpsc::Sender<Forwarded>>> {
        self.remote.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Hands a server-opened channel to the forward that asked for `port`. `false` (refuse the
    /// channel) when no forward asked for it or that forward is saturated.
    pub(crate) fn deliver(&self, port: u32, channel: Channel<Msg>) -> bool {
        let sender = self.remote().get(&port).cloned();
        sender.is_some_and(|s| s.try_send(Forwarded { channel }).is_ok())
    }
}

pub async fn start_remote(conn: &Arc<VerifiedConnection>, spec: &RemoteForward) -> Result<ForwardHandle, ForwardError> {
    require_authenticated(conn)?;
    if !valid_destination(&spec.dest_host) || spec.dest_port == 0 {
        return Err(ForwardError::InvalidAddress);
    }
    let remote_host = spec.remote_host.trim().to_owned();
    if remote_host.len() > 253 || !remote_host.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ForwardError::InvalidAddress);
    }
    if remote_bind_scope(&remote_host) == BindScope::External && !spec.approve_external {
        return Err(ForwardError::ExternalBindNotApproved);
    }

    let request = conn.handle.tcpip_forward(remote_host.clone(), u32::from(spec.remote_port));
    let port = match tokio::time::timeout(conn.request_timeout, request).await {
        Err(_) => return Err(ForwardError::Timeout),
        Ok(Err(russh::Error::RequestDenied)) => return Err(ForwardError::Denied),
        Ok(Err(_)) => return Err(ForwardError::Disconnected),
        Ok(Ok(assigned)) if spec.remote_port == 0 => assigned,
        Ok(Ok(_)) => u32::from(spec.remote_port),
    };
    let Ok(port16) = u16::try_from(port) else {
        return Err(ForwardError::Denied);
    };
    if port16 == 0 {
        return Err(ForwardError::Denied);
    }

    let (tx, mut rx) = mpsc::channel(PENDING_CHANNELS);
    conn.routes.remote().insert(port, tx);

    let (life, stop, ended) = lifecycle(spec.max_connections);
    let stats = Arc::clone(&life.stats);
    let weak = Arc::downgrade(conn);
    let (dest_host, dest_port) = (spec.dest_host.clone(), spec.dest_port);
    tokio::spawn(async move {
        let mut stop_rx = life.stop.clone();
        let end = loop {
            tokio::select! {
                () = stopped(&mut stop_rx) => break ForwardEnd::Stopped,
                () = link_lost(&weak) => break ForwardEnd::ConnectionLost,
                incoming = rx.recv() => {
                    let Some(Forwarded { channel }) = incoming else { break ForwardEnd::ConnectionLost };
                    let Ok(permit) = Arc::clone(&life.slots).try_acquire_owned() else {
                        life.stats.refused.fetch_add(1, Ordering::Relaxed);
                        let _ = channel.close().await;
                        continue;
                    };
                    life.stats.accepted.fetch_add(1, Ordering::Relaxed);
                    let (host, stats, stop) = (dest_host.clone(), Arc::clone(&life.stats), life.stop.clone());
                    tokio::spawn(async move {
                        let _permit = permit;
                        let connect = TcpStream::connect((host.as_str(), dest_port));
                        match tokio::time::timeout(FORWARD_HANDSHAKE_TIMEOUT, connect).await {
                            Ok(Ok(target)) => {
                                let _ = target.set_nodelay(true);
                                stats.active.fetch_add(1, Ordering::Relaxed);
                                relay(channel.into_stream(), target, &stats, stop).await;
                                stats.active.fetch_sub(1, Ordering::Relaxed);
                            }
                            _ => {
                                stats.failed.fetch_add(1, Ordering::Relaxed);
                                let _ = channel.close().await;
                            }
                        }
                    });
                }
            }
        };
        // Stop routing first, so a late channel is refused, then ask the server to close its
        // listener. Best effort: on a lost link the server has closed it already.
        if let Some(conn) = weak.upgrade() {
            conn.routes.remote().remove(&port);
            let cancel = conn.handle.cancel_tcpip_forward(remote_host, port);
            let _ = tokio::time::timeout(conn.request_timeout, cancel).await;
        }
        life.ended.send_replace(Some(end));
    });
    Ok(ForwardHandle { bound: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port16), stats, stop, ended })
}

// ---------- dynamic forwarding (SOCKS5) ----------

/// `-D [bind_host:]bind_port`: a SOCKS5 (RFC 1928) listener, `CONNECT` only, no authentication
/// method other than "none". Like OpenSSH's, a loopback listener is reachable by other accounts
/// on this machine; that is why external binds need approval and the default is loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DynamicForward {
    pub bind_host: String,
    pub bind_port: u16,
    pub approve_external: bool,
    pub max_connections: u32,
}

/// Where a SOCKS client asked to go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocksTarget {
    pub host: String,
    pub port: u16,
}

/// SOCKS5 reply codes used here.
pub(crate) mod reply {
    pub const SUCCEEDED: u8 = 0x00;
    pub const GENERAL_FAILURE: u8 = 0x01;
    pub const NOT_ALLOWED: u8 = 0x02;
    pub const HOST_UNREACHABLE: u8 = 0x04;
    pub const CONNECTION_REFUSED: u8 = 0x05;
    pub const COMMAND_NOT_SUPPORTED: u8 = 0x07;
    pub const ADDRESS_NOT_SUPPORTED: u8 = 0x08;
}

/// Why a SOCKS handshake was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocksRefusal {
    /// Not SOCKS version 5.
    Version,
    /// The client offered no acceptable authentication method.
    NoAcceptableMethod,
    /// BIND, UDP ASSOCIATE or an unknown command.
    Command,
    AddressType,
    /// An invalid or empty destination.
    Destination,
    /// The client stopped sending or closed the connection.
    Io,
}

/// Server side of a SOCKS5 handshake up to (not including) the reply to the request. Reads at
/// most 4 + 255 + 4 + 255 + 2 bytes; the caller bounds the time.
pub async fn socks5_accept<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<SocksTarget, SocksRefusal> {
    let io = |_| SocksRefusal::Io;
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[0] != 0x05 {
        return Err(SocksRefusal::Version);
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    stream.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err(SocksRefusal::NoAcceptableMethod);
    }
    stream.write_all(&[0x05, 0x00]).await.map_err(io)?;

    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await.map_err(io)?;
    if request[0] != 0x05 {
        return Err(SocksRefusal::Version);
    }
    let host = match request[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(io)?;
            Ipv4Addr::from(a).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            let mut name = vec![0u8; usize::from(len[0])];
            stream.read_exact(&mut name).await.map_err(io)?;
            let name = String::from_utf8(name).map_err(|_| SocksRefusal::Destination)?;
            if !valid_destination(&name) {
                let _ = send_reply(stream, reply::GENERAL_FAILURE).await;
                return Err(SocksRefusal::Destination);
            }
            name
        }
        _ => {
            let _ = send_reply(stream, reply::ADDRESS_NOT_SUPPORTED).await;
            return Err(SocksRefusal::AddressType);
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await.map_err(io)?;
    let port = u16::from_be_bytes(port);
    if request[1] != 0x01 {
        let _ = send_reply(stream, reply::COMMAND_NOT_SUPPORTED).await;
        return Err(SocksRefusal::Command);
    }
    if port == 0 {
        let _ = send_reply(stream, reply::GENERAL_FAILURE).await;
        return Err(SocksRefusal::Destination);
    }
    Ok(SocksTarget { host, port })
}

/// A SOCKS5 reply with an all-zero bound address (clients do not use it for CONNECT).
pub(crate) async fn send_reply<S: AsyncWrite + Unpin>(stream: &mut S, code: u8) -> std::io::Result<()> {
    stream.write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await
}

fn socks_code(failure: &ChannelOpenFailure) -> u8 {
    match failure {
        ChannelOpenFailure::AdministrativelyProhibited => reply::NOT_ALLOWED,
        ChannelOpenFailure::ConnectFailed => reply::CONNECTION_REFUSED,
        ChannelOpenFailure::UnknownChannelType | ChannelOpenFailure::Other { .. } => reply::GENERAL_FAILURE,
        ChannelOpenFailure::ResourceShortage => reply::HOST_UNREACHABLE,
    }
}

pub async fn start_dynamic(
    conn: &Arc<VerifiedConnection>,
    spec: &DynamicForward,
) -> Result<ForwardHandle, ForwardError> {
    require_authenticated(conn)?;
    let listener = bind_local(&spec.bind_host, spec.bind_port, spec.approve_external).await?;
    let bound = listener.local_addr().map_err(|_| ForwardError::BindFailed)?;
    let (life, stop, ended) = lifecycle(spec.max_connections);
    let stats = Arc::clone(&life.stats);
    let weak = Arc::downgrade(conn);
    tokio::spawn(async move {
        let mut stop_rx = life.stop.clone();
        let end = loop {
            tokio::select! {
                () = stopped(&mut stop_rx) => break ForwardEnd::Stopped,
                () = link_lost(&weak) => break ForwardEnd::ConnectionLost,
                accepted = listener.accept() => {
                    let Ok((mut client, origin)) = accepted else { break ForwardEnd::ListenerFailed };
                    let Ok(permit) = Arc::clone(&life.slots).try_acquire_owned() else {
                        life.stats.refused.fetch_add(1, Ordering::Relaxed);
                        drop(client);
                        continue;
                    };
                    life.stats.accepted.fetch_add(1, Ordering::Relaxed);
                    let (weak, stats, stop) = (weak.clone(), Arc::clone(&life.stats), life.stop.clone());
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = client.set_nodelay(true);
                        let handshake = tokio::time::timeout(FORWARD_HANDSHAKE_TIMEOUT, socks5_accept(&mut client)).await;
                        let Ok(Ok(target)) = handshake else {
                            stats.failed.fetch_add(1, Ordering::Relaxed);
                            return;
                        };
                        match open_direct(&weak, &target.host, target.port, origin).await {
                            Ok(channel) => {
                                if send_reply(&mut client, reply::SUCCEEDED).await.is_err() {
                                    return;
                                }
                                stats.active.fetch_add(1, Ordering::Relaxed);
                                relay(client, channel.into_stream(), &stats, stop).await;
                                stats.active.fetch_sub(1, Ordering::Relaxed);
                            }
                            Err(failure) => {
                                stats.failed.fetch_add(1, Ordering::Relaxed);
                                let _ = send_reply(&mut client, socks_code(&failure)).await;
                            }
                        }
                    });
                }
            }
        };
        drop(listener);
        life.ended.send_replace(Some(end));
    });
    Ok(ForwardHandle { bound, stats, stop, ended })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_addresses_bind_without_approval() {
        for host in ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "localhost", "LOCALHOST", "::ffff:127.0.0.1"] {
            let addr = local_bind_addr(host).unwrap();
            assert_eq!(local_bind_scope(addr), BindScope::Loopback, "{host}");
        }
        for host in ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.1", "fe80::1", "::ffff:10.0.0.1"] {
            let addr = local_bind_addr(host).unwrap();
            assert_eq!(local_bind_scope(addr), BindScope::External, "{host}");
        }
    }

    #[test]
    fn local_listeners_take_ip_literals_only_so_no_name_can_resolve_elsewhere() {
        for host in ["", "example.test", "localhost.", "127.0.0.1:80", "1.2.3", "[::1", "lo cal"] {
            assert_eq!(local_bind_addr(host), Err(ForwardError::InvalidAddress), "{host:?}");
        }
    }

    #[test]
    fn server_side_wildcards_and_names_count_as_external() {
        for host in ["localhost", "127.0.0.1", "::1", "[::1]"] {
            assert_eq!(remote_bind_scope(host), BindScope::Loopback, "{host}");
        }
        for host in ["", "*", "0.0.0.0", "::", "server.example", "192.0.2.1"] {
            assert_eq!(remote_bind_scope(host), BindScope::External, "{host:?}");
        }
    }

    #[tokio::test]
    async fn an_unapproved_external_listener_is_never_bound() {
        assert_eq!(bind_local("0.0.0.0", 0, false).await.err(), Some(ForwardError::ExternalBindNotApproved));
        assert_eq!(bind_local("::", 0, false).await.err(), Some(ForwardError::ExternalBindNotApproved));
        // Approved, a wildcard binds.
        let listener = bind_local("0.0.0.0", 0, true).await.unwrap();
        assert!(listener.local_addr().unwrap().ip().is_unspecified());
        // Loopback needs no approval; an occupied port is a bind failure, not a silent move.
        let taken = bind_local("127.0.0.1", 0, false).await.unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_eq!(bind_local("127.0.0.1", port, false).await.err(), Some(ForwardError::BindFailed));
    }

    async fn handshake(bytes: &[u8]) -> (Result<SocksTarget, SocksRefusal>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(1024);
        client.write_all(bytes).await.unwrap();
        client.shutdown().await.unwrap();
        let result = socks5_accept(&mut server).await;
        drop(server);
        let mut answer = Vec::new();
        client.read_to_end(&mut answer).await.unwrap();
        (result, answer)
    }

    #[tokio::test]
    async fn socks5_connect_requests_parse_for_every_address_type() {
        let (r, a) = handshake(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 80]).await;
        assert_eq!(r, Ok(SocksTarget { host: "10.0.0.7".into(), port: 80 }));
        assert_eq!(a, [5, 0]);

        let mut domain = vec![5, 2, 2, 0, 5, 1, 0, 3, 11];
        domain.extend_from_slice(b"example.lab");
        domain.extend_from_slice(&443u16.to_be_bytes());
        assert_eq!(handshake(&domain).await.0, Ok(SocksTarget { host: "example.lab".into(), port: 443 }));

        let mut v6 = vec![5, 1, 0, 5, 1, 0, 4];
        v6.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        v6.extend_from_slice(&22u16.to_be_bytes());
        assert_eq!(handshake(&v6).await.0, Ok(SocksTarget { host: "::1".into(), port: 22 }));
    }

    #[tokio::test]
    async fn socks5_refuses_other_versions_methods_commands_and_bad_destinations() {
        assert_eq!(handshake(&[4, 1, 0, 80, 127, 0, 0, 1, 0]).await.0, Err(SocksRefusal::Version));
        // Only username/password offered: refused with 0xFF, never accepted without it.
        let (r, a) = handshake(&[5, 1, 2]).await;
        assert_eq!((r, a), (Err(SocksRefusal::NoAcceptableMethod), vec![5, 0xff]));
        // BIND and UDP ASSOCIATE.
        for cmd in [2u8, 3] {
            let (r, a) = handshake(&[5, 1, 0, 5, cmd, 0, 1, 127, 0, 0, 1, 0, 80]).await;
            assert_eq!(r, Err(SocksRefusal::Command));
            assert_eq!(a[2..4], [5, reply::COMMAND_NOT_SUPPORTED]);
        }
        let (r, a) = handshake(&[5, 1, 0, 5, 1, 0, 9, 0, 0]).await;
        assert_eq!(r, Err(SocksRefusal::AddressType));
        assert_eq!(a[2..4], [5, reply::ADDRESS_NOT_SUPPORTED]);
        // Empty name, a name with a space, port 0.
        assert_eq!(handshake(&[5, 1, 0, 5, 1, 0, 3, 0, 0, 80]).await.0, Err(SocksRefusal::Destination));
        assert_eq!(
            handshake(&[5, 1, 0, 5, 1, 0, 3, 3, b'a', b' ', b'b', 0, 80]).await.0,
            Err(SocksRefusal::Destination)
        );
        assert_eq!(handshake(&[5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 0]).await.0, Err(SocksRefusal::Destination));
        // Truncated anywhere.
        assert_eq!(handshake(&[5, 3, 0]).await.0, Err(SocksRefusal::Io));
        assert_eq!(handshake(&[5, 1, 0, 5, 1, 0, 3, 20, b'a']).await.0, Err(SocksRefusal::Io));
    }
}

//! Port forwarding against the real OpenSSH lab (`pnpm lab:up`). Nothing here is mocked.
//!
//! Run with `cargo test -p tyrminal-ssh --test forward_lab -- --ignored`. The lab's sshd runs on
//! this machine (local mode) or publishes to loopback (containers); destinations below are
//! loopback services this test starts, which the server reaches in local mode and the client
//! reaches in both.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tyrminal_ssh::{
    AuthOutcome, ClientKey, ConnectOptions, DynamicForward, Endpoint, ForwardEnd, ForwardError, HostKeyRequest,
    HostKeyVerifier, LocalForward, RejectReason, RemoteForward, TrustVerdict, VerifiedConnection, connect,
    connect_stream, start_dynamic, start_local, start_remote,
};

const WAIT: Duration = Duration::from_secs(10);

struct Lab(Value);

impl Lab {
    fn load() -> Self {
        let path = std::env::var_os("TYRMINAL_LAB")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/ssh-lab/.run/lab.json"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("SSH lab is not running ({}). Run `pnpm lab:up` first.", path.display()));
        Self(serde_json::from_str(&text).expect("lab.json parses"))
    }
    fn str(&self, pointer: &str) -> String {
        self.0.pointer(pointer).and_then(Value::as_str).unwrap_or_else(|| panic!("lab.json: {pointer}")).to_owned()
    }
    fn port(&self) -> u16 {
        self.0.pointer("/servers/a/port").and_then(Value::as_u64).unwrap() as u16
    }
    /// Destinations the server must reach exist only on this machine in the local lab.
    fn server_shares_loopback(&self) -> bool {
        self.0.pointer("/mode").and_then(Value::as_str) == Some("local")
    }
}

struct Pinned(String);

impl HostKeyVerifier for Pinned {
    async fn verify(&mut self, request: &HostKeyRequest) -> TrustVerdict {
        if request.key.public_key == self.0 {
            TrustVerdict::Accept
        } else {
            TrustVerdict::Reject(RejectReason::Changed)
        }
    }
}

async fn authenticate(lab: &Lab, mut conn: VerifiedConnection, user: &str) -> Arc<VerifiedConnection> {
    let text = std::fs::read_to_string(lab.str("/keys/ed25519")).unwrap();
    let key = ClientKey::from_openssh(&text, None).unwrap();
    assert_eq!(conn.authenticate_key(user, &key).await.unwrap(), AuthOutcome::Success);
    Arc::new(conn)
}

async fn connected_as(lab: &Lab, user: &str) -> Arc<VerifiedConnection> {
    let options = ConnectOptions::new(Endpoint::new("127.0.0.1", lab.port()));
    let conn = connect(&options, Pinned(lab.str("/servers/a/hostKeyEd25519"))).await.expect("connect");
    authenticate(lab, conn, user).await
}

/// A loopback TCP echo service; returns its port.
async fn echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = stream.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

/// A port with nothing listening on it (bound once, then released).
async fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

async fn round_trip(stream: &mut TcpStream, payload: &[u8]) -> Vec<u8> {
    stream.write_all(payload).await.unwrap();
    let mut back = vec![0u8; payload.len()];
    tokio::time::timeout(WAIT, stream.read_exact(&mut back)).await.expect("echo in time").unwrap();
    back
}

/// `true` once nothing accepts connections on `addr` (the listener is closed).
async fn refuses(addr: SocketAddr) -> bool {
    TcpStream::connect(addr).await.is_err()
}

/// Waits until a connection that the forward accepted is closed by it.
async fn closed_by_peer(stream: &mut TcpStream) -> bool {
    let mut byte = [0u8; 1];
    matches!(tokio::time::timeout(WAIT, stream.read(&mut byte)).await, Ok(Ok(0) | Err(_)))
}

fn local(dest_port: u16) -> LocalForward {
    LocalForward {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        dest_host: "127.0.0.1".into(),
        dest_port,
        approve_external: false,
        max_connections: 8,
    }
}

async fn socks_connect(proxy: SocketAddr, host: &str, port: u16) -> (TcpStream, u8) {
    let mut s = TcpStream::connect(proxy).await.unwrap();
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut choice = [0u8; 2];
    s.read_exact(&mut choice).await.unwrap();
    assert_eq!(choice, [5, 0]);
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    s.write_all(&request).await.unwrap();
    let mut reply = [0u8; 10];
    tokio::time::timeout(WAIT, s.read_exact(&mut reply)).await.expect("socks reply in time").unwrap();
    (s, reply[1])
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn local_forward_carries_bytes_both_ways_and_stopping_closes_the_listener() {
    let lab = Lab::load();
    assert!(lab.server_shares_loopback(), "this test needs the local lab (TYRMINAL_LAB_MODE=local)");
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let echo = echo_server().await;
    let forward = start_local(&conn, &local(echo)).await.unwrap();
    let bound = forward.bound();
    assert!(bound.ip().is_loopback() && bound.port() != 0);

    let payload: Vec<u8> = (0..200_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let mut a = TcpStream::connect(bound).await.unwrap();
    let mut b = TcpStream::connect(bound).await.unwrap();
    assert_eq!(round_trip(&mut a, &payload).await, payload);
    assert_eq!(round_trip(&mut b, b"second connection").await, b"second connection");
    assert_eq!(forward.stats().active, 2);
    drop((a, b));

    forward.stop().await;
    assert_eq!(forward.ended(), Some(ForwardEnd::Stopped));
    assert!(refuses(bound).await, "the listener must be closed once the forward is stopped");
    let stats = forward.stats();
    assert_eq!((stats.accepted, stats.refused, stats.failed), (2, 0, 0));
    assert_eq!(stats.bytes_out, (payload.len() + 17) as u64);
    assert_eq!(stats.bytes_in, stats.bytes_out);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn listeners_never_bind_beyond_loopback_without_approval() {
    let lab = Lab::load();
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let free = closed_port().await;
    for host in ["0.0.0.0", "::", "[::]"] {
        let spec = LocalForward { bind_host: host.into(), bind_port: free, ..local(22) };
        assert_eq!(start_local(&conn, &spec).await.err(), Some(ForwardError::ExternalBindNotApproved), "{host}");
        let socks =
            DynamicForward { bind_host: host.into(), bind_port: free, approve_external: false, max_connections: 4 };
        assert_eq!(start_dynamic(&conn, &socks).await.err(), Some(ForwardError::ExternalBindNotApproved), "{host}");
    }
    // Nothing was bound on the way to the refusal.
    let probe = TcpListener::bind(("0.0.0.0", free)).await;
    assert!(probe.is_ok(), "the refused port must still be free");
    drop(probe);
    // A host name is refused outright, even one that would resolve to loopback.
    let named = LocalForward { bind_host: "localhost.localdomain".into(), ..local(22) };
    assert_eq!(start_local(&conn, &named).await.err(), Some(ForwardError::InvalidAddress));

    // Server side: every interface needs approval; the request is never sent without it.
    for host in ["", "*", "0.0.0.0"] {
        let spec = RemoteForward {
            remote_host: host.into(),
            remote_port: 0,
            dest_host: "127.0.0.1".into(),
            dest_port: 22,
            approve_external: false,
            max_connections: 4,
        };
        assert_eq!(start_remote(&conn, &spec).await.err(), Some(ForwardError::ExternalBindNotApproved), "{host:?}");
    }

    // With approval a wildcard local listener binds.
    let approved = LocalForward { bind_host: "0.0.0.0".into(), approve_external: true, ..local(22) };
    let forward = start_local(&conn, &approved).await.unwrap();
    assert!(forward.bound().ip().is_unspecified());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn a_port_in_use_is_a_bind_failure() {
    let lab = Lab::load();
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let taken = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let spec = LocalForward { bind_port: taken.local_addr().unwrap().port(), ..local(22) };
    assert_eq!(start_local(&conn, &spec).await.err(), Some(ForwardError::BindFailed));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn a_server_that_denies_forwarding_is_reported_and_nothing_leaks() {
    let lab = Lab::load();
    let conn = connected_as(&lab, &lab.str("/noForwardUser")).await;
    let echo = echo_server().await;

    // Local: the listener is ours, but every channel is refused by the server.
    let forward = start_local(&conn, &local(echo)).await.unwrap();
    let mut client = TcpStream::connect(forward.bound()).await.unwrap();
    assert!(closed_by_peer(&mut client).await, "a denied channel must close the client connection");
    let stats = forward.stats();
    assert_eq!((stats.accepted, stats.failed, stats.active), (1, 1, 0));

    // Remote: the server refuses to listen.
    let spec = RemoteForward {
        remote_host: "localhost".into(),
        remote_port: 0,
        dest_host: "127.0.0.1".into(),
        dest_port: echo,
        approve_external: false,
        max_connections: 4,
    };
    assert_eq!(start_remote(&conn, &spec).await.err(), Some(ForwardError::Denied));

    // Dynamic: the SOCKS client is told "not allowed by ruleset".
    let socks = start_dynamic(
        &conn,
        &DynamicForward { bind_host: "127.0.0.1".into(), bind_port: 0, approve_external: false, max_connections: 4 },
    )
    .await
    .unwrap();
    let (_s, code) = socks_connect(socks.bound(), "127.0.0.1", echo).await;
    assert_eq!(code, 0x02);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn remote_forward_reaches_a_local_service_and_is_cancelled_on_stop() {
    let lab = Lab::load();
    assert!(lab.server_shares_loopback(), "this test needs the local lab (TYRMINAL_LAB_MODE=local)");
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let echo = echo_server().await;
    let spec = RemoteForward {
        remote_host: "127.0.0.1".into(),
        remote_port: 0,
        dest_host: "127.0.0.1".into(),
        dest_port: echo,
        approve_external: false,
        max_connections: 4,
    };
    let forward = start_remote(&conn, &spec).await.unwrap();
    let port = forward.bound().port();
    assert_ne!(port, 0, "the server reports the port it picked");
    // The server's listener is on this machine's loopback in the local lab.
    let server_side = SocketAddr::from(([127, 0, 0, 1], port));
    let mut client = TcpStream::connect(server_side).await.unwrap();
    assert_eq!(round_trip(&mut client, b"through the server and back").await, b"through the server and back");
    drop(client);

    forward.stop().await;
    assert_eq!(forward.ended(), Some(ForwardEnd::Stopped));
    // cancel-tcpip-forward was acknowledged before the end was reported.
    assert!(refuses(server_side).await, "the server must stop listening once the forward is stopped");
    assert_eq!(forward.stats().accepted, 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn dynamic_forward_is_a_socks5_proxy_through_the_server() {
    let lab = Lab::load();
    assert!(lab.server_shares_loopback(), "this test needs the local lab (TYRMINAL_LAB_MODE=local)");
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let echo = echo_server().await;
    let socks = start_dynamic(
        &conn,
        &DynamicForward { bind_host: "localhost".into(), bind_port: 0, approve_external: false, max_connections: 4 },
    )
    .await
    .unwrap();
    assert!(socks.bound().ip().is_loopback());

    let (mut stream, code) = socks_connect(socks.bound(), "127.0.0.1", echo).await;
    assert_eq!(code, 0x00);
    assert_eq!(round_trip(&mut stream, b"socks payload").await, b"socks payload");

    // The server could not connect: "connection refused", not success.
    let (_s, code) = socks_connect(socks.bound(), "127.0.0.1", closed_port().await).await;
    assert_eq!(code, 0x05);

    // A client that never finishes its handshake is cut off, and BIND is refused.
    let mut stalled = TcpStream::connect(socks.bound()).await.unwrap();
    stalled.write_all(&[5, 1]).await.unwrap();
    let mut s = TcpStream::connect(socks.bound()).await.unwrap();
    s.write_all(&[5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80]).await.unwrap();
    let mut answer = [0u8; 12];
    s.read_exact(&mut answer).await.unwrap();
    assert_eq!(answer[2..4], [5, 0x07]);
    assert!(closed_by_peer(&mut s).await);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn connections_beyond_the_limit_are_refused_and_counted() {
    let lab = Lab::load();
    assert!(lab.server_shares_loopback(), "this test needs the local lab (TYRMINAL_LAB_MODE=local)");
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let echo = echo_server().await;
    let forward = start_local(&conn, &LocalForward { max_connections: 2, ..local(echo) }).await.unwrap();
    let mut held = Vec::new();
    for _ in 0..2 {
        let mut s = TcpStream::connect(forward.bound()).await.unwrap();
        assert_eq!(round_trip(&mut s, b"x").await, b"x");
        held.push(s);
    }
    let mut extra = TcpStream::connect(forward.bound()).await.unwrap();
    assert!(closed_by_peer(&mut extra).await, "a connection beyond the limit is closed at once");
    assert_eq!(forward.stats().refused, 1);
    // Releasing one frees a slot.
    drop(held.pop());
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let mut s = TcpStream::connect(forward.bound()).await.unwrap();
        s.write_all(b"y").await.unwrap();
        let mut b = [0u8; 1];
        if matches!(tokio::time::timeout(Duration::from_secs(2), s.read(&mut b)).await, Ok(Ok(1))) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "a freed slot must be reusable");
    }
}

/// A TCP relay to the lab server whose live connections can be cut.
async fn cuttable(lab: &Lab) -> (SocketAddr, watch::Sender<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let backend = SocketAddr::from(([127, 0, 0, 1], lab.port()));
    let (cut, _) = watch::channel(false);
    let cut_tx = cut.clone();
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            let mut cut_rx = cut_tx.subscribe();
            tokio::spawn(async move {
                let Ok(mut outbound) = TcpStream::connect(backend).await else { return };
                tokio::select! {
                    _ = copy_bidirectional(&mut inbound, &mut outbound) => {}
                    _ = cut_rx.wait_for(|c| *c) => {}
                }
            });
        }
    });
    (addr, cut)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn a_lost_link_closes_every_listener() {
    let lab = Lab::load();
    let (relay, cut) = cuttable(&lab).await;
    let options = ConnectOptions {
        keepalive_interval: Some(Duration::from_secs(1)),
        ..ConnectOptions::new(Endpoint::new("127.0.0.1", lab.port()))
    };
    let stream = TcpStream::connect(relay).await.unwrap();
    let conn = connect_stream(&options, stream, Some(relay), Pinned(lab.str("/servers/a/hostKeyEd25519")))
        .await
        .expect("connect");
    let conn = authenticate(&lab, conn, &lab.str("/user")).await;
    let local_fwd = start_local(&conn, &local(22)).await.unwrap();
    let socks = start_dynamic(
        &conn,
        &DynamicForward { bind_host: "127.0.0.1".into(), bind_port: 0, approve_external: false, max_connections: 4 },
    )
    .await
    .unwrap();

    cut.send_replace(true);
    for forward in [&local_fwd, &socks] {
        let end = tokio::time::timeout(Duration::from_secs(20), forward.wait_ended()).await.expect("ended in time");
        assert_eq!(end, ForwardEnd::ConnectionLost);
        assert!(refuses(forward.bound()).await, "no listener may outlive its connection");
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn dropping_the_handle_or_the_connection_stops_the_forward() {
    let lab = Lab::load();
    let conn = connected_as(&lab, &lab.str("/user")).await;
    let forward = start_local(&conn, &local(22)).await.unwrap();
    let bound = forward.bound();
    drop(forward);
    let deadline = tokio::time::Instant::now() + WAIT;
    while !refuses(bound).await {
        assert!(tokio::time::Instant::now() < deadline, "a dropped handle must close its listener");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let forward = start_local(&conn, &local(22)).await.unwrap();
    drop(conn);
    let end = tokio::time::timeout(WAIT, forward.wait_ended()).await.expect("ended in time");
    assert_eq!(end, ForwardEnd::ConnectionLost);
    assert!(refuses(forward.bound()).await);
}

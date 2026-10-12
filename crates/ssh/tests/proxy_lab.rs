//! SSH through outbound proxies against the real OpenSSH lab (`pnpm lab:up`). The proxies are
//! minimal HTTP CONNECT and SOCKS5 servers started by this test on loopback, with credentials;
//! the SSH server is real.
//!
//! Run with `cargo test -p tyrminal-ssh --test proxy_lab -- --ignored`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use tyrminal_ssh::{
    AuthOutcome, ClientKey, ConnectOptions, Endpoint, HostKeyRequest, HostKeyVerifier, ProxyError, ProxyKind,
    ProxySpec, RejectReason, TrustVerdict, connect_stream, connect_via_proxy,
};
use zeroize::Zeroizing;

const USER: &str = "proxy-user";
const PASSWORD: &str = "proxy-canary-7f3a";

struct Lab(Value);

impl Lab {
    fn load() -> Self {
        let path = std::env::var_os("TYRMINAL_LAB")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/ssh-lab/.run/lab.json"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("SSH lab is not running ({}). Run `pnpm lab:up` first.", path.display()));
        Self(serde_json::from_str(&text).unwrap())
    }
    fn str(&self, pointer: &str) -> String {
        self.0.pointer(pointer).and_then(Value::as_str).unwrap_or_else(|| panic!("lab.json: {pointer}")).to_owned()
    }
    fn port(&self) -> u16 {
        self.0.pointer("/servers/a/port").and_then(Value::as_u64).unwrap() as u16
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

/// A proxy server for the test: counts tunnels it opened (so a refused sign-in can be shown to
/// have opened none).
struct TestProxy {
    port: u16,
    tunnels: Arc<AtomicUsize>,
}

fn basic(user: &str, password: &str) -> String {
    // Independent of the client's encoder: a tiny table-free base64 for the expected header.
    let input = format!("{user}:{password}").into_bytes();
    let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= chunk.len() { table[((n >> (18 - 6 * i)) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

async fn http_proxy() -> TestProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tunnels = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&tunnels);
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let count = Arc::clone(&count);
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8(head).unwrap();
                let target = head.split(' ').nth(1).unwrap().to_owned();
                let expected = format!("Proxy-Authorization: Basic {}\r\n", basic(USER, PASSWORD));
                if !head.contains(&expected) {
                    let _ = client.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").await;
                    return;
                }
                let Ok(mut upstream) = TcpStream::connect(target.as_str()).await else {
                    let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                    return;
                };
                count.fetch_add(1, Ordering::SeqCst);
                client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                let _ = copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    TestProxy { port, tunnels }
}

async fn socks_proxy() -> TestProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tunnels = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&tunnels);
    tokio::spawn(async move {
        while let Ok((mut c, _)) = listener.accept().await {
            let count = Arc::clone(&count);
            tokio::spawn(async move {
                let mut head = [0u8; 2];
                c.read_exact(&mut head).await.unwrap();
                let mut methods = vec![0u8; usize::from(head[1])];
                c.read_exact(&mut methods).await.unwrap();
                if !methods.contains(&2) {
                    c.write_all(&[5, 0xff]).await.unwrap();
                    return;
                }
                c.write_all(&[5, 2]).await.unwrap();
                let mut ver_len = [0u8; 2];
                c.read_exact(&mut ver_len).await.unwrap();
                let mut user = vec![0u8; usize::from(ver_len[1])];
                c.read_exact(&mut user).await.unwrap();
                let mut plen = [0u8; 1];
                c.read_exact(&mut plen).await.unwrap();
                let mut password = vec![0u8; usize::from(plen[0])];
                c.read_exact(&mut password).await.unwrap();
                if user != USER.as_bytes() || password != PASSWORD.as_bytes() {
                    c.write_all(&[1, 1]).await.unwrap();
                    return;
                }
                c.write_all(&[1, 0]).await.unwrap();
                let mut req = [0u8; 4];
                c.read_exact(&mut req).await.unwrap();
                assert_eq!(req[3], 3, "the destination name is left to the proxy to resolve");
                let mut len = [0u8; 1];
                c.read_exact(&mut len).await.unwrap();
                let mut name = vec![0u8; usize::from(len[0])];
                c.read_exact(&mut name).await.unwrap();
                let mut port = [0u8; 2];
                c.read_exact(&mut port).await.unwrap();
                let target = format!("{}:{}", String::from_utf8(name).unwrap(), u16::from_be_bytes(port));
                let Ok(mut upstream) = TcpStream::connect(target.as_str()).await else {
                    c.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                    return;
                };
                count.fetch_add(1, Ordering::SeqCst);
                c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                let _ = copy_bidirectional(&mut c, &mut upstream).await;
            });
        }
    });
    TestProxy { port, tunnels }
}

fn spec(kind: ProxyKind, port: u16, password: Option<&str>) -> ProxySpec {
    ProxySpec {
        kind,
        host: "127.0.0.1".into(),
        port,
        credentials: password.map(|p| (USER.to_owned(), Zeroizing::new(p.to_owned()))),
        timeout: Duration::from_secs(5),
    }
}

/// Connects through the proxy, verifies the real server's key, signs in and runs a command.
async fn ssh_through(lab: &Lab, proxy: &ProxySpec, host: &str) -> Result<String, ProxyError> {
    let stream = connect_via_proxy(proxy, host, lab.port()).await?;
    let options = ConnectOptions::new(Endpoint::new(host, lab.port()));
    let mut conn = connect_stream(&options, stream, None, Pinned(lab.str("/servers/a/hostKeyEd25519"))).await.unwrap();
    let key = ClientKey::from_openssh(&std::fs::read_to_string(lab.str("/keys/ed25519")).unwrap(), None).unwrap();
    assert_eq!(conn.authenticate_key(&lab.str("/user"), &key).await.unwrap(), AuthOutcome::Success);
    let out = conn.exec("echo via-proxy-$((6*7))", 1024, Duration::from_secs(10)).await.unwrap();
    Ok(String::from_utf8(out.stdout).unwrap())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn ssh_runs_through_an_authenticated_http_connect_proxy() {
    let lab = Lab::load();
    let proxy = http_proxy().await;
    let out = ssh_through(&lab, &spec(ProxyKind::Http, proxy.port, Some(PASSWORD)), "127.0.0.1").await.unwrap();
    assert_eq!(out.trim(), "via-proxy-42");
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 1);

    // Wrong or missing credentials: refused, and the proxy opened no tunnel.
    let wrong = connect_via_proxy(&spec(ProxyKind::Http, proxy.port, Some("nope")), "127.0.0.1", lab.port()).await;
    assert_eq!(wrong.err(), Some(ProxyError::AuthRejected));
    let missing = connect_via_proxy(&spec(ProxyKind::Http, proxy.port, None), "127.0.0.1", lab.port()).await;
    assert_eq!(missing.err(), Some(ProxyError::AuthRequired));
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn ssh_runs_through_an_authenticated_socks5_proxy_with_remote_name_resolution() {
    let lab = Lab::load();
    let proxy = socks_proxy().await;
    // A name, so the request carries it unresolved (the proxy test asserts address type 3).
    let out = ssh_through(&lab, &spec(ProxyKind::Socks5, proxy.port, Some(PASSWORD)), "localhost").await.unwrap();
    assert_eq!(out.trim(), "via-proxy-42");

    let wrong = connect_via_proxy(&spec(ProxyKind::Socks5, proxy.port, Some("nope")), "localhost", lab.port()).await;
    assert_eq!(wrong.err(), Some(ProxyError::AuthRejected));
    let missing = connect_via_proxy(&spec(ProxyKind::Socks5, proxy.port, None), "localhost", lab.port()).await;
    assert_eq!(missing.err(), Some(ProxyError::AuthRequired));
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the SSH lab: pnpm lab:up"]
async fn a_proxy_cannot_impersonate_the_server() {
    // A "proxy" that ignores the requested destination and connects to another lab server: the
    // host-key check end to end with the intended server refuses it before any credential.
    let lab = Lab::load();
    let other = lab.0.pointer("/servers/b/port").and_then(Value::as_u64).unwrap() as u16;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let mut upstream = TcpStream::connect(("127.0.0.1", other)).await.unwrap();
                client.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
                let _ = copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    let stream = connect_via_proxy(&spec(ProxyKind::Http, port, None), "127.0.0.1", lab.port()).await.unwrap();
    let options = ConnectOptions::new(Endpoint::new("127.0.0.1", lab.port()));
    let result = connect_stream(&options, stream, None, Pinned(lab.str("/servers/a/hostKeyEd25519"))).await;
    assert!(matches!(result, Err(tyrminal_ssh::SshError::HostKey(RejectReason::Changed))), "{result:?}");
}

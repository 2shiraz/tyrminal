//! Outbound proxies: the TCP connection to the first SSH hop through an HTTP `CONNECT` or a
//! SOCKS5 proxy, optionally with a user name and password.
//!
//! The proxy only carries the SSH byte stream; host-key verification happens end to end with the
//! server afterwards ([`crate::connect_stream`]), so a proxy cannot impersonate the server. The
//! destination name is sent to the proxy unresolved, so DNS for it happens at the proxy.
//!
//! Proxy credentials are secrets: they are copied into the request and never logged or put in an
//! error. An HTTP proxy receives them base64-encoded, which is not encryption; the UI says so.

use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use zeroize::Zeroizing;

/// Largest HTTP response head accepted from a proxy.
const MAX_HTTP_HEAD: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    /// HTTP `CONNECT` (RFC 9110 §9.3.6), Basic authentication.
    Http,
    /// SOCKS5 (RFC 1928), username/password authentication (RFC 1929).
    Socks5,
}

/// Where the proxy is and how to sign in to it.
pub struct ProxySpec {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    /// User name and password, or neither.
    pub credentials: Option<(String, Zeroizing<String>)>,
    /// Limit for reaching the proxy and for its handshake, each.
    pub timeout: Duration,
}

impl core::fmt::Debug for ProxySpec {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ProxySpec")
            .field("kind", &self.kind)
            .field("port", &self.port)
            .field("credentials", &self.credentials.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// Proxy failures with fixed messages; no proxy-supplied text is ever embedded.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ProxyError {
    #[error("the proxy could not be reached")]
    Unreachable,
    #[error("the proxy did not answer in time")]
    Timeout,
    /// The proxy wants credentials and none were configured.
    #[error("the proxy requires a user name and password")]
    AuthRequired,
    /// The proxy refused the configured credentials.
    #[error("the proxy did not accept the user name and password")]
    AuthRejected,
    /// The proxy refused or could not reach the destination.
    #[error("the proxy refused the connection to the server")]
    Refused,
    #[error("the proxy answered with something that is not a valid proxy response")]
    Protocol,
    #[error("the proxy settings are not valid")]
    Invalid,
}

impl ProxyError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreachable => "PROXY_UNREACHABLE",
            Self::Timeout => "PROXY_TIMEOUT",
            Self::AuthRequired => "PROXY_AUTH_REQUIRED",
            Self::AuthRejected => "PROXY_AUTH_REJECTED",
            Self::Refused => "PROXY_REFUSED",
            Self::Protocol => "PROXY_PROTOCOL",
            Self::Invalid => "PROXY_INVALID",
        }
    }
}

fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 253 && host.bytes().all(|b| b.is_ascii_graphic() && b != b'@' && b != b'/')
}

/// Opens a TCP connection to the proxy and asks it for a tunnel to `host:port`.
pub async fn connect_via_proxy(proxy: &ProxySpec, host: &str, port: u16) -> Result<TcpStream, ProxyError> {
    let proxy_host = proxy.host.trim();
    let proxy_host = proxy_host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(proxy_host);
    if !valid_host(proxy_host) || proxy.port == 0 {
        return Err(ProxyError::Invalid);
    }
    let connect = TcpStream::connect((proxy_host, proxy.port));
    let mut stream = match tokio::time::timeout(proxy.timeout, connect).await {
        Err(_) => return Err(ProxyError::Timeout),
        Ok(Err(_)) => return Err(ProxyError::Unreachable),
        Ok(Ok(stream)) => stream,
    };
    let _ = stream.set_nodelay(true);
    match tokio::time::timeout(proxy.timeout, handshake(proxy, &mut stream, host, port)).await {
        Err(_) => Err(ProxyError::Timeout),
        Ok(result) => result.map(|()| stream),
    }
}

/// The proxy protocol on an established stream, up to the point where it carries the tunnel.
pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(
    proxy: &ProxySpec,
    stream: &mut S,
    host: &str,
    port: u16,
) -> Result<(), ProxyError> {
    let host = host.trim();
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if !valid_host(host) || port == 0 {
        return Err(ProxyError::Invalid);
    }
    if let Some((user, password)) = &proxy.credentials
        && (user.is_empty()
            || user.len() > 255
            || password.len() > 255
            || user.contains(':')
            || user.bytes().any(|b| b.is_ascii_control()))
    {
        return Err(ProxyError::Invalid);
    }
    match proxy.kind {
        ProxyKind::Http => http_connect(stream, host, port, proxy.credentials.as_ref()).await,
        ProxyKind::Socks5 => socks5_connect(stream, host, port, proxy.credentials.as_ref()).await,
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding, into a zeroizing buffer (it encodes a password).
fn base64(input: &[u8]) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::with_capacity(input.len().div_ceil(3) * 4));
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18u32, 12, 6, 0].iter().enumerate() {
            if i <= chunk.len() {
                out.push(BASE64[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    port: u16,
    credentials: Option<&(String, Zeroizing<String>)>,
) -> Result<(), ProxyError> {
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut request = Zeroizing::new(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"));
    if let Some((user, password)) = credentials {
        let mut pair = Zeroizing::new(Vec::with_capacity(user.len() + 1 + password.len()));
        pair.extend_from_slice(user.as_bytes());
        pair.push(b':');
        pair.extend_from_slice(password.as_bytes());
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&base64(&pair));
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.map_err(|_| ProxyError::Unreachable)?;

    // Read the response head byte by byte: anything after it already belongs to the tunnel.
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HTTP_HEAD {
            return Err(ProxyError::Protocol);
        }
        match stream.read(&mut byte).await {
            Ok(1) => head.push(byte[0]),
            _ => return Err(if head.is_empty() { ProxyError::Unreachable } else { ProxyError::Protocol }),
        }
    }
    let status_line = head.split(|&b| b == b'\r').next().unwrap_or_default();
    let status_line = std::str::from_utf8(status_line).map_err(|_| ProxyError::Protocol)?;
    let mut parts = status_line.splitn(3, ' ');
    let (version, code) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    if !version.starts_with("HTTP/1.") || code.len() != 3 {
        return Err(ProxyError::Protocol);
    }
    match code {
        c if c.starts_with('2') => Ok(()),
        "407" if credentials.is_some() => Err(ProxyError::AuthRejected),
        "407" => Err(ProxyError::AuthRequired),
        c if c.bytes().all(|b| b.is_ascii_digit()) => Err(ProxyError::Refused),
        _ => Err(ProxyError::Protocol),
    }
}

async fn socks5_connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    port: u16,
    credentials: Option<&(String, Zeroizing<String>)>,
) -> Result<(), ProxyError> {
    let io = |_| ProxyError::Protocol;
    // Offer exactly what is configured: with credentials only username/password, so a proxy
    // cannot silently downgrade the session to an unauthenticated one we did not intend.
    let greeting: &[u8] = if credentials.is_some() { &[5, 1, 2] } else { &[5, 1, 0] };
    stream.write_all(greeting).await.map_err(|_| ProxyError::Unreachable)?;
    let mut choice = [0u8; 2];
    stream.read_exact(&mut choice).await.map_err(io)?;
    match (choice, credentials) {
        ([5, 0], None) => {}
        ([5, 2], Some((user, password))) => {
            let mut auth = Zeroizing::new(Vec::with_capacity(3 + user.len() + password.len()));
            auth.push(1);
            auth.push(user.len() as u8);
            auth.extend_from_slice(user.as_bytes());
            auth.push(password.len() as u8);
            auth.extend_from_slice(password.as_bytes());
            stream.write_all(&auth).await.map_err(io)?;
            let mut status = [0u8; 2];
            stream.read_exact(&mut status).await.map_err(io)?;
            if status[0] != 1 {
                return Err(ProxyError::Protocol);
            }
            if status[1] != 0 {
                return Err(ProxyError::AuthRejected);
            }
        }
        ([5, 0xff], None) => return Err(ProxyError::AuthRequired),
        ([5, 0xff], Some(_)) => return Err(ProxyError::AuthRejected),
        _ => return Err(ProxyError::Protocol),
    }

    let mut request = vec![5, 1, 0];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            request.push(1);
            request.extend_from_slice(&v4.octets());
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            request.push(4);
            request.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            request.push(3);
            request.push(u8::try_from(host.len()).map_err(|_| ProxyError::Invalid)?);
            request.extend_from_slice(host.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(io)?;

    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).await.map_err(io)?;
    if reply[0] != 5 || reply[2] != 0 {
        return Err(ProxyError::Protocol);
    }
    // The bound address, whose length depends on its type; read and discard it.
    let skip = match reply[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            usize::from(len[0])
        }
        _ => return Err(ProxyError::Protocol),
    };
    let mut rest = vec![0u8; skip + 2];
    stream.read_exact(&mut rest).await.map_err(io)?;
    match reply[1] {
        0 => Ok(()),
        1..=8 => Err(ProxyError::Refused),
        _ => Err(ProxyError::Protocol),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: ProxyKind, credentials: Option<(&str, &str)>) -> ProxySpec {
        ProxySpec {
            kind,
            host: "127.0.0.1".into(),
            port: 1,
            credentials: credentials.map(|(u, p)| (u.to_owned(), Zeroizing::new(p.to_owned()))),
            timeout: Duration::from_secs(5),
        }
    }

    /// Runs the client handshake against a scripted proxy that answers with `reply` once it has
    /// read `expect` bytes; returns the result and what the client sent.
    async fn scripted(proxy: &ProxySpec, reply: &'static [u8], host: &str) -> (Result<(), ProxyError>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        let fake = tokio::spawn(async move {
            server.write_all(reply).await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(200), server.read(&mut buf)).await {
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            seen
        });
        let result = handshake(proxy, &mut client, host, 22).await;
        drop(client);
        (result, fake.await.unwrap())
    }

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        for (input, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()).as_str(), encoded);
        }
    }

    #[tokio::test]
    async fn http_connect_sends_authority_and_basic_credentials() {
        let proxy = spec(ProxyKind::Http, Some(("lab", "s3cret")));
        let (result, sent) = scripted(&proxy, b"HTTP/1.1 200 Connection established\r\n\r\n", "inner.lab").await;
        assert_eq!(result, Ok(()));
        let text = String::from_utf8(sent).unwrap();
        assert!(text.starts_with("CONNECT inner.lab:22 HTTP/1.1\r\nHost: inner.lab:22\r\n"), "{text}");
        assert!(text.contains("Proxy-Authorization: Basic bGFiOnMzY3JldA==\r\n"), "{text}");
        // IPv6 destinations are bracketed in the authority.
        let (result, sent) = scripted(&spec(ProxyKind::Http, None), b"HTTP/1.0 200 OK\r\n\r\n", "::1").await;
        assert_eq!(result, Ok(()));
        assert!(String::from_utf8(sent).unwrap().starts_with("CONNECT [::1]:22 HTTP/1.1"));
    }

    #[tokio::test]
    async fn http_proxy_refusals_are_told_apart_and_never_accepted() {
        let none = spec(ProxyKind::Http, None);
        let creds = spec(ProxyKind::Http, Some(("lab", "wrong")));
        let required = b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n";
        assert_eq!(scripted(&none, required, "h").await.0, Err(ProxyError::AuthRequired));
        assert_eq!(scripted(&creds, required, "h").await.0, Err(ProxyError::AuthRejected));
        assert_eq!(scripted(&none, b"HTTP/1.1 403 Forbidden\r\n\r\n", "h").await.0, Err(ProxyError::Refused));
        assert_eq!(scripted(&none, b"HTTP/1.1 502 Bad Gateway\r\n\r\n", "h").await.0, Err(ProxyError::Refused));
        // Not HTTP, truncated, or an endless head.
        assert_eq!(scripted(&none, b"SSH-2.0-OpenSSH_9.6\r\n\r\n", "h").await.0, Err(ProxyError::Protocol));
        assert_eq!(scripted(&none, b"HTTP/1.1 200", "h").await.0, Err(ProxyError::Protocol));
        assert_eq!(scripted(&none, b"", "h").await.0, Err(ProxyError::Unreachable));
        let flood: &'static [u8] =
            Box::leak(format!("HTTP/1.1 200 OK\r\nX: {}\r\n\r\n", "a".repeat(9000)).into_bytes().into_boxed_slice());
        assert_eq!(scripted(&none, flood, "h").await.0, Err(ProxyError::Protocol));
    }

    #[tokio::test]
    async fn http_bytes_after_the_head_stay_in_the_stream() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        server.write_all(b"HTTP/1.1 200 OK\r\n\r\nSSH-2.0-banner\r\n").await.unwrap();
        handshake(&spec(ProxyKind::Http, None), &mut client, "h", 22).await.unwrap();
        let mut rest = [0u8; 16];
        client.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"SSH-2.0-banner\r\n");
    }

    #[tokio::test]
    async fn socks5_with_credentials_offers_only_username_password() {
        let proxy = spec(ProxyKind::Socks5, Some(("lab", "pw")));
        let ok: &'static [u8] = &[5, 2, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        let (result, sent) = scripted(&proxy, ok, "inner.lab").await;
        assert_eq!(result, Ok(()));
        let mut expected = vec![5, 1, 2, 1, 3, b'l', b'a', b'b', 2, b'p', b'w', 5, 1, 0, 3, 9];
        expected.extend_from_slice(b"inner.lab");
        expected.extend_from_slice(&[0, 22]);
        assert_eq!(sent, expected);
        // A proxy that answers "no authentication" to a credentialed offer is not trusted.
        assert_eq!(scripted(&proxy, &[5, 0], "h").await.0, Err(ProxyError::Protocol));
    }

    #[tokio::test]
    async fn socks5_refusals_are_told_apart() {
        let none = spec(ProxyKind::Socks5, None);
        let creds = spec(ProxyKind::Socks5, Some(("lab", "wrong")));
        assert_eq!(scripted(&none, &[5, 0xff], "h").await.0, Err(ProxyError::AuthRequired));
        assert_eq!(scripted(&creds, &[5, 0xff], "h").await.0, Err(ProxyError::AuthRejected));
        assert_eq!(scripted(&creds, &[5, 2, 1, 1], "h").await.0, Err(ProxyError::AuthRejected));
        // Not allowed by ruleset, host unreachable, connection refused.
        for code in [2u8, 4, 5] {
            let reply: &'static [u8] = Box::leak(vec![5, 0, 5, code, 0, 1, 0, 0, 0, 0, 0, 0].into_boxed_slice());
            assert_eq!(scripted(&none, reply, "h").await.0, Err(ProxyError::Refused), "code {code}");
        }
        assert_eq!(scripted(&none, &[4, 0], "h").await.0, Err(ProxyError::Protocol));
        assert_eq!(scripted(&none, &[5, 0, 5, 0, 0, 9], "h").await.0, Err(ProxyError::Protocol));
        assert_eq!(scripted(&none, &[5, 0, 5], "h").await.0, Err(ProxyError::Protocol));
    }

    #[tokio::test]
    async fn invalid_settings_are_refused_before_anything_is_sent() {
        let bad_user = spec(ProxyKind::Http, Some(("a:b", "pw")));
        let (result, sent) = scripted(&bad_user, b"", "h").await;
        assert_eq!((result, sent.len()), (Err(ProxyError::Invalid), 0));
        let (result, sent) = scripted(&spec(ProxyKind::Socks5, None), b"", "evil host").await;
        assert_eq!((result, sent.len()), (Err(ProxyError::Invalid), 0));
    }

    #[tokio::test]
    async fn an_unreachable_or_silent_proxy_fails_promptly() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let mut proxy = spec(ProxyKind::Http, None);
        proxy.port = port;
        assert_eq!(connect_via_proxy(&proxy, "h", 22).await.err(), Some(ProxyError::Unreachable));

        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        proxy.port = silent.local_addr().unwrap().port();
        proxy.timeout = Duration::from_millis(300);
        let _hold = tokio::spawn(async move {
            let accepted = silent.accept().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(accepted);
        });
        assert_eq!(connect_via_proxy(&proxy, "h", 22).await.err(), Some(ProxyError::Timeout));
    }

    #[test]
    fn debug_output_never_contains_credentials() {
        let proxy = spec(ProxyKind::Socks5, Some(("lab-user", "canary-proxy-password")));
        let text = format!("{proxy:?}");
        assert!(!text.contains("canary-proxy-password") && !text.contains("lab-user"), "{text}");
    }
}

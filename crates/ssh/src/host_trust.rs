//! Server identity: what was presented, what is known, and who decides.

use std::future::Future;
use std::net::SocketAddr;

use russh::keys::{HashAlg, PublicKey};

/// A destination as the user configured it (before DNS resolution).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

impl Endpoint {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self { host: host.into(), port }
    }

    /// Canonical `(host, port)` used to match known-host entries.
    pub fn canonical(&self) -> (String, u16) {
        (canonical_host(&self.host), self.port)
    }
}

/// Canonical host form for trust matching: IPv6 brackets and zone-less literals normalized, ASCII
/// lower-cased, one trailing root dot removed. Non-ASCII names are kept as typed (lower-cased by
/// Unicode rules); IDNA mapping is **not yet implemented**, so `bücher.example` and its punycode
/// form are distinct trust entries (fail-closed: at worst an extra prompt, never a false match).
pub fn canonical_host(host: &str) -> String {
    let trimmed = host.trim();
    let unbracketed = trimmed.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(trimmed);
    if let Ok(ip) = unbracketed.parse::<std::net::IpAddr>() {
        return ip.to_string();
    }
    let lowered = unbracketed.to_lowercase();
    lowered.strip_suffix('.').unwrap_or(&lowered).to_owned()
}

/// The host key a server presented during key exchange. Contains only public data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedHostKey {
    /// SSH algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// `SHA256:<base64>` fingerprint as OpenSSH prints it.
    pub fingerprint: String,
    /// `<algorithm> <base64>` public key without a comment.
    pub public_key: String,
}

impl PresentedHostKey {
    pub(crate) fn from_public_key(key: &PublicKey) -> Option<Self> {
        let openssh = key.to_openssh().ok()?;
        let mut parts = openssh.split_whitespace();
        let public_key = format!("{} {}", parts.next()?, parts.next()?);
        Some(Self {
            algorithm: key.algorithm().as_str().to_owned(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            public_key,
        })
    }
}

/// A previously trusted host key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownHost {
    /// Canonical host (see [`canonical_host`]).
    pub host: String,
    pub port: u16,
    /// `<algorithm> <base64>` public key.
    pub public_key: String,
}

/// Result of comparing a presented key with the known-hosts set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustStatus {
    /// The exact key is already trusted for this endpoint.
    Trusted,
    /// Nothing is known about this endpoint.
    Unknown,
    /// The endpoint is known but presented a different key. Fails closed.
    Changed { known_keys: Vec<String> },
}

/// Pure trust evaluation. Any entry for the endpoint that does not match the presented key means
/// `Changed`, including a key of a different algorithm: a server "switching algorithm" is
/// indistinguishable from an impersonator and needs the explicit replace-trust flow.
pub fn evaluate(known: &[KnownHost], endpoint: &Endpoint, presented: &PresentedHostKey) -> TrustStatus {
    let (host, port) = endpoint.canonical();
    let mut for_endpoint = known.iter().filter(|k| k.port == port && canonical_host(&k.host) == host).peekable();
    if for_endpoint.peek().is_none() {
        return TrustStatus::Unknown;
    }
    let mut known_keys = Vec::new();
    for entry in for_endpoint {
        if entry.public_key == presented.public_key {
            return TrustStatus::Trusted;
        }
        known_keys.push(entry.public_key.clone());
    }
    TrustStatus::Changed { known_keys }
}

/// Everything a verifier (and a trust dialog) needs to decide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyRequest {
    pub endpoint: Endpoint,
    /// The address actually connected to, when known.
    pub resolved: Option<SocketAddr>,
    pub key: PresentedHostKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// Unknown key and the user (or policy) declined to trust it.
    NotTrusted,
    /// A different key is already trusted for this endpoint.
    Changed,
    /// The trust prompt was cancelled, timed out, or the vault locked meanwhile.
    Cancelled,
    /// The server presented a host certificate; certificate validation is not implemented, and a
    /// certificate is never accepted merely for being signed.
    CertificateUnsupported,
    /// A later key exchange presented a different key than the one accepted for this connection.
    ChangedDuringSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustVerdict {
    Accept,
    Reject(RejectReason),
}

/// Decides whether a presented host key is trusted. Called once per connection during key
/// exchange, before any authentication message can be sent. May wait for the user.
pub trait HostKeyVerifier: Send + 'static {
    fn verify(&mut self, request: &HostKeyRequest) -> impl Future<Output = TrustVerdict> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(material: &str) -> PresentedHostKey {
        PresentedHostKey {
            algorithm: "ssh-ed25519".into(),
            fingerprint: format!("SHA256:{material}"),
            public_key: format!("ssh-ed25519 {material}"),
        }
    }

    fn known(host: &str, port: u16, material: &str) -> KnownHost {
        KnownHost { host: host.into(), port, public_key: format!("ssh-ed25519 {material}") }
    }

    #[test]
    fn canonical_host_normalizes_case_brackets_ipv6_and_root_dot() {
        assert_eq!(canonical_host("Example.COM"), "example.com");
        assert_eq!(canonical_host("example.com."), "example.com");
        assert_eq!(canonical_host(" example.com "), "example.com");
        assert_eq!(canonical_host("[::1]"), "::1");
        assert_eq!(canonical_host("0:0:0:0:0:0:0:1"), "::1");
        assert_eq!(canonical_host("[2001:DB8::0001]"), "2001:db8::1");
        assert_eq!(canonical_host("127.0.0.1"), "127.0.0.1");
        // Not an IP literal: must not be "fixed up" into one.
        assert_eq!(canonical_host("127.0.0.1.example"), "127.0.0.1.example");
    }

    #[test]
    fn unknown_trusted_and_changed() {
        let ep = Endpoint::new("Host.Example", 22);
        let store = vec![known("host.example", 22, "AAAA")];
        assert_eq!(evaluate(&[], &ep, &key("AAAA")), TrustStatus::Unknown);
        assert_eq!(evaluate(&store, &ep, &key("AAAA")), TrustStatus::Trusted);
        assert_eq!(
            evaluate(&store, &ep, &key("BBBB")),
            TrustStatus::Changed { known_keys: vec!["ssh-ed25519 AAAA".into()] }
        );
    }

    #[test]
    fn trust_is_scoped_to_host_and_port() {
        let store = vec![known("host.example", 22, "AAAA")];
        // Same key on another port or host is a separate, unknown endpoint: no implicit trust.
        assert_eq!(evaluate(&store, &Endpoint::new("host.example", 2222), &key("AAAA")), TrustStatus::Unknown);
        assert_eq!(evaluate(&store, &Endpoint::new("other.example", 22), &key("AAAA")), TrustStatus::Unknown);
        // A lookalike host name is a different endpoint.
        assert_eq!(evaluate(&store, &Endpoint::new("host.examp1e", 22), &key("AAAA")), TrustStatus::Unknown);
    }

    #[test]
    fn ipv6_spellings_match_the_same_entry() {
        let store = vec![known("::1", 22, "AAAA")];
        for spelling in ["::1", "[::1]", "0:0:0:0:0:0:0:1"] {
            assert_eq!(evaluate(&store, &Endpoint::new(spelling, 22), &key("AAAA")), TrustStatus::Trusted);
            assert!(matches!(
                evaluate(&store, &Endpoint::new(spelling, 22), &key("BBBB")),
                TrustStatus::Changed { .. }
            ));
        }
    }

    #[test]
    fn a_different_algorithm_for_a_known_endpoint_is_changed_not_unknown() {
        let store = vec![known("host.example", 22, "AAAA")];
        let rsa = PresentedHostKey {
            algorithm: "rsa-sha2-512".into(),
            fingerprint: "SHA256:zzz".into(),
            public_key: "ssh-rsa CCCC".into(),
        };
        assert!(matches!(evaluate(&store, &Endpoint::new("host.example", 22), &rsa), TrustStatus::Changed { .. }));
    }

    #[test]
    fn any_matching_entry_among_several_is_trusted() {
        let store = vec![known("host.example", 22, "AAAA"), known("host.example", 22, "BBBB")];
        assert_eq!(evaluate(&store, &Endpoint::new("host.example", 22), &key("BBBB")), TrustStatus::Trusted);
        assert_eq!(
            evaluate(&store, &Endpoint::new("host.example", 22), &key("CCCC")),
            TrustStatus::Changed { known_keys: vec!["ssh-ed25519 AAAA".into(), "ssh-ed25519 BBBB".into()] }
        );
    }
}

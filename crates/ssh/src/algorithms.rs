//! Explicit algorithm policy. The lists are written out rather than inherited from library
//! defaults so an upgrade cannot silently widen them (spec §4.5).

use std::borrow::Cow;

use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{Preferred, cipher, compression, kex, mac};

/// Hybrid post-quantum first (ML-KEM-768 with X25519), then classical exchanges for servers that
/// do not offer it.
const KEX: &[kex::Name] = &[
    kex::MLKEM768X25519_SHA256,
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::DH_GEX_SHA256,
    kex::DH_G16_SHA512,
    kex::DH_G14_SHA256,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
];

/// Only the hybrid post-quantum exchange: a server without it fails key exchange, before any
/// credential could be sent.
const KEX_POST_QUANTUM_ONLY: &[kex::Name] =
    &[kex::MLKEM768X25519_SHA256, kex::EXTENSION_SUPPORT_AS_CLIENT, kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT];

/// Without the post-quantum exchange, for servers that mishandle it.
const KEX_CLASSIC: &[kex::Name] = &[
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::DH_GEX_SHA256,
    kex::DH_G16_SHA512,
    kex::DH_G14_SHA256,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
];

/// The name of the hybrid post-quantum key exchange this build offers.
pub const POST_QUANTUM_KEX: &str = "mlkem768x25519-sha256";

/// How a connection treats post-quantum key exchange.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyExchangePolicy {
    /// Offer the hybrid post-quantum exchange first and fall back to classical ones.
    #[default]
    PreferPostQuantum,
    /// Offer only the hybrid post-quantum exchange.
    RequirePostQuantum,
    /// Offer only classical exchanges (compatibility with servers that mishandle it).
    Classic,
}

fn kex_for(policy: KeyExchangePolicy) -> &'static [kex::Name] {
    match policy {
        KeyExchangePolicy::PreferPostQuantum => KEX,
        KeyExchangePolicy::RequirePostQuantum => KEX_POST_QUANTUM_ONLY,
        KeyExchangePolicy::Classic => KEX_CLASSIC,
    }
}

/// Host key algorithms. `ssh-rsa` with SHA-1 (`Rsa { hash: None }`) is deliberately absent.
const HOST_KEYS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
    Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
    Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
    Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
    Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
];

const CIPHERS: &[cipher::Name] =
    &[cipher::CHACHA20_POLY1305, cipher::AES_256_GCM, cipher::AES_256_CTR, cipher::AES_192_CTR, cipher::AES_128_CTR];

const MACS: &[mac::Name] = &[mac::HMAC_SHA512_ETM, mac::HMAC_SHA256_ETM, mac::HMAC_SHA512, mac::HMAC_SHA256];

/// Compression is off: it is unnecessary for interactive use and is a known side channel.
const COMPRESSION: &[compression::Name] = &[compression::NONE];

pub(crate) fn preferred(policy: KeyExchangePolicy) -> Preferred {
    Preferred {
        kex: Cow::Borrowed(kex_for(policy)),
        host_key_certificates: Cow::Borrowed(&[]),
        key: Cow::Borrowed(HOST_KEYS),
        cipher: Cow::Borrowed(CIPHERS),
        mac: Cow::Borrowed(MACS),
        compression: Cow::Borrowed(COMPRESSION),
    }
}

// agent D: known-host import
/// Whether a host key of this algorithm (as named in a public key, e.g. `ssh-rsa`) can ever be
/// accepted. RSA keys are named `ssh-rsa` whatever signature hash is negotiated.
pub(crate) fn accepts_host_key(algorithm: &str) -> bool {
    HOST_KEYS.iter().any(|a| a.as_str() == algorithm || (matches!(a, Algorithm::Rsa { .. }) && algorithm == "ssh-rsa"))
}

/// The exact offer this build makes, for documentation and diagnostics.
pub fn negotiation_summary() -> String {
    let join = |names: Vec<String>| names.join(",");
    format!(
        "kex={}\nhost_key={}\ncipher={}\nmac={}\ncompression={}",
        join(KEX.iter().map(|n| n.as_ref().to_owned()).collect()),
        join(HOST_KEYS.iter().map(|a| a.as_str().to_owned()).collect()),
        join(CIPHERS.iter().map(|n| n.as_ref().to_owned()).collect()),
        join(MACS.iter().map(|n| n.as_ref().to_owned()).collect()),
        join(COMPRESSION.iter().map(|n| n.as_ref().to_owned()).collect()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_sha1_rsa_host_keys_no_cbc_no_weak_dh_no_compression() {
        let summary = negotiation_summary();
        assert!(!HOST_KEYS.contains(&Algorithm::Rsa { hash: None }));
        for banned in
            ["ssh-dss", "-cbc", "3des", "arcfour", "group1-", "group-exchange-sha1", "hmac-sha1", "hmac-md5", "zlib"]
        {
            assert!(!summary.contains(banned), "{banned} must not be offered:\n{summary}");
        }
        assert!(summary.contains("curve25519-sha256"));
        assert!(summary.contains("chacha20-poly1305@openssh.com"));
    }

    #[test]
    fn the_key_exchange_policy_selects_the_offer() {
        let names = |p| kex_for(p).iter().map(|n| n.as_ref().to_owned()).collect::<Vec<_>>();
        assert_eq!(names(KeyExchangePolicy::PreferPostQuantum)[0], POST_QUANTUM_KEX, "post-quantum first by default");
        assert!(names(KeyExchangePolicy::PreferPostQuantum).iter().any(|n| n == "curve25519-sha256"));
        let required = names(KeyExchangePolicy::RequirePostQuantum);
        assert_eq!(required[0], POST_QUANTUM_KEX);
        assert!(required[1..].iter().all(|n| n.starts_with("ext-info") || n.starts_with("kex-strict")), "{required:?}");
        let classic = names(KeyExchangePolicy::Classic);
        assert!(!classic.iter().any(|n| n == POST_QUANTUM_KEX));
        assert_eq!(classic[0], "curve25519-sha256");
        // Strict key exchange (Terrapin countermeasure) is kept in every policy.
        for policy in
            [KeyExchangePolicy::PreferPostQuantum, KeyExchangePolicy::RequirePostQuantum, KeyExchangePolicy::Classic]
        {
            assert!(names(policy).iter().any(|n| n == "kex-strict-c-v00@openssh.com"));
        }
        assert_eq!(KeyExchangePolicy::default(), KeyExchangePolicy::PreferPostQuantum);
    }
}

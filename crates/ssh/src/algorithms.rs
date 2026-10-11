//! Explicit algorithm policy. The lists are written out rather than inherited from library
//! defaults so an upgrade cannot silently widen them (BUILD_SPEC §4.5).

use std::borrow::Cow;

use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{Preferred, cipher, compression, kex, mac};

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

pub(crate) fn preferred() -> Preferred {
    Preferred {
        kex: Cow::Borrowed(KEX),
        host_key_certificates: Cow::Borrowed(&[]),
        key: Cow::Borrowed(HOST_KEYS),
        cipher: Cow::Borrowed(CIPHERS),
        mac: Cow::Borrowed(MACS),
        compression: Cow::Borrowed(COMPRESSION),
    }
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
}

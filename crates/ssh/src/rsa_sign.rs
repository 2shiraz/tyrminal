//! RSA signatures of exactly the modulus length.
//!
//! RFC 8332 §3 requires an `rsa-sha2-*` signature blob to be exactly as long as the RSA modulus
//! (`ceil(bits / 8)` bytes, left-padded with zeros). The `rsa` crate's signature encoding pads to
//! whole 64-bit words instead, so for a key whose size is not a multiple of 64 bits (4000, 4048,
//! ...) the blob carried extra leading zeros, came out longer than the modulus, and OpenSSH
//! refused the signature ("Failed publickey" right after "Accepted key"). This module signs RSA
//! keys itself through russh's external-signer path and normalises the length before the
//! signature leaves.
//!
//! Only SHA-2 is ever used; the hash comes from the server's `server-sig-algs` as before. Nothing
//! here logs, and errors carry no key or signature bytes.

use std::future::Future;

use russh::keys::agent::AgentIdentity;
use russh::keys::signature::Signer as _;
use russh::keys::ssh_encoding::Encode;
use russh::keys::ssh_key::private::KeypairData;
use russh::keys::ssh_key::{Algorithm, Signature};
use russh::keys::{HashAlg, PrivateKey};

/// Why an RSA signature could not be made. Never carries key material.
#[derive(Debug)]
pub(crate) enum RsaSignError {
    /// The connection went away while signing.
    Send,
    /// The key could not sign (not RSA, no SHA-2 hash, or the signature was malformed).
    Sign,
}

impl From<russh::SendError> for RsaSignError {
    fn from(_: russh::SendError) -> Self {
        Self::Send
    }
}

/// `signature` as exactly `modulus_len` bytes: leading zero bytes beyond that length are dropped,
/// and a shorter value is left-padded with zeros (RFC 8332 §3). `None` if the value itself (after
/// its leading zeros) is longer than the modulus, which no valid signature is.
pub(crate) fn exact_length(signature: &[u8], modulus_len: usize) -> Option<Vec<u8>> {
    let first = signature.iter().position(|b| *b != 0).unwrap_or(signature.len());
    let value = signature.get(first..)?;
    let pad = modulus_len.checked_sub(value.len())?;
    let mut out = Vec::with_capacity(modulus_len);
    out.resize(pad, 0);
    out.extend_from_slice(value);
    (out.len() == modulus_len).then_some(out)
}

/// Signs `to_sign` with an RSA key and appends the SSH signature blob, as russh expects from an
/// external signer.
fn sign_appended(key: &PrivateKey, hash: Option<HashAlg>, mut to_sign: Vec<u8>) -> Result<Vec<u8>, RsaSignError> {
    let KeypairData::Rsa(pair) = key.key_data() else {
        return Err(RsaSignError::Sign);
    };
    // SHA-1 `ssh-rsa` is never produced.
    let hash = hash.ok_or(RsaSignError::Sign)?;
    let signed: Signature = (pair, Some(hash)).try_sign(&to_sign).map_err(|_| RsaSignError::Sign)?;
    let modulus_len = (pair.public().key_size() as usize).div_ceil(8);
    let data = exact_length(signed.as_bytes(), modulus_len).ok_or(RsaSignError::Sign)?;
    if data.len() != modulus_len {
        return Err(RsaSignError::Sign);
    }
    let blob = Signature::new(Algorithm::Rsa { hash: Some(hash) }, data)
        .and_then(|s| s.encode_vec().map_err(Into::into))
        .map_err(|_| RsaSignError::Sign)?;
    blob.encode(&mut to_sign).map_err(|_| RsaSignError::Sign)?;
    Ok(to_sign)
}

/// Signs user-authentication requests for one RSA key, with signatures of exactly the modulus
/// length. Used for plain keys and for RSA keys with an OpenSSH certificate.
pub(crate) struct ExactRsaSigner<'a> {
    key: &'a PrivateKey,
}

impl<'a> ExactRsaSigner<'a> {
    pub(crate) fn new(key: &'a PrivateKey) -> Self {
        Self { key }
    }
}

impl russh::Signer for ExactRsaSigner<'_> {
    type Error = RsaSignError;

    fn auth_sign(
        &mut self,
        _identity: &AgentIdentity,
        hash_alg: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = Result<Vec<u8>, Self::Error>> + Send {
        std::future::ready(sign_appended(self.key, hash_alg, to_sign))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_encoding::Decode;

    #[test]
    fn signatures_are_normalised_to_the_modulus_length() {
        // Word padding: extra leading zeros beyond the modulus are dropped.
        assert_eq!(exact_length(&[0, 0, 0, 0, 0, 0, 0xab, 0xcd], 2).unwrap(), vec![0xab, 0xcd]);
        // A value that happens to start with zero bytes keeps them up to the modulus length.
        assert_eq!(exact_length(&[0, 0, 0, 0, 0x01, 0x02], 4).unwrap(), vec![0, 0, 0x01, 0x02]);
        // A short value is left-padded (RFC 8332 §3).
        assert_eq!(exact_length(&[0x7f], 3).unwrap(), vec![0, 0, 0x7f]);
        // Already exact: unchanged.
        assert_eq!(exact_length(&[0x80, 0, 1], 3).unwrap(), vec![0x80, 0, 1]);
        // All zeros (never a real signature) still comes out at the exact length.
        assert_eq!(exact_length(&[0; 8], 4).unwrap(), vec![0; 4]);
        // A value longer than the modulus is not a signature for this key.
        assert_eq!(exact_length(&[0x01, 0x02, 0x03], 2), None);
        assert_eq!(exact_length(&[0, 0x01, 0x02, 0x03], 2), None);
    }

    /// A fresh 2000-bit key: 2000 is not a multiple of 64, so the `rsa` crate's encoding pads its
    /// signatures to 2048 bits.
    fn odd_sized_key() -> PrivateKey {
        let mut rng = rand::rng();
        let pair = russh::keys::ssh_key::private::RsaKeypair::random(&mut rng, 2000).expect("rsa key");
        PrivateKey::from(pair)
    }

    #[test]
    fn an_odd_sized_key_signs_at_exactly_its_modulus_length_and_verifies() {
        let key = odd_sized_key();
        let KeypairData::Rsa(pair) = key.key_data() else { unreachable!() };
        assert_eq!(pair.public().key_size() % 64, 2000 % 64, "a size that is not a whole number of words");
        let modulus_len = 2000usize.div_ceil(8);
        for hash in [HashAlg::Sha256, HashAlg::Sha512] {
            let message = b"session id and userauth request".to_vec();
            let out = sign_appended(&key, Some(hash), message.clone()).unwrap();
            assert_eq!(&out[..message.len()], &message[..], "the request is kept and the blob appended");
            let mut rest = &out[message.len()..];
            let blob = Vec::<u8>::decode(&mut rest).unwrap();
            assert!(rest.is_empty());
            let signature = Signature::decode(&mut &blob[..]).unwrap();
            assert_eq!(signature.algorithm(), Algorithm::Rsa { hash: Some(hash) });
            assert_eq!(signature.as_bytes().len(), modulus_len, "{hash:?}");
            russh::keys::signature::Verifier::verify(key.public_key().key_data(), &message, &signature)
                .expect("the normalised signature verifies");
        }
    }

    #[test]
    fn sha1_and_non_rsa_keys_are_refused() {
        let key = odd_sized_key();
        assert!(matches!(sign_appended(&key, None, vec![1, 2, 3]), Err(RsaSignError::Sign)));
        let ed = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        assert!(matches!(sign_appended(&ed, Some(HashAlg::Sha256), vec![1]), Err(RsaSignError::Sign)));
    }
}

use core::fmt;

use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::certificate::CertType;
use russh::keys::{Algorithm, Certificate, EcdsaCurve, HashAlg, PrivateKey, PublicKey, decode_secret_key};
use thiserror::Error;
use zeroize::Zeroizing;

/// Maximum accepted private-key text (BUILD_SPEC §13: 1 MiB imported key payloads).
pub const MAX_KEY_TEXT_LEN: usize = 1024 * 1024;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    #[error("the private key is encrypted and needs its passphrase")]
    PassphraseRequired,
    #[error("the passphrase did not decrypt the private key")]
    WrongPassphrase,
    #[error("the private key could not be parsed")]
    Malformed,
    #[error("the private key exceeds the size limit")]
    TooLarge,
    #[error("this key type is not supported")]
    Unsupported,
    // agent D: key formats and certificates
    /// A PuTTY key asks for key-derivation work beyond what Tyrminal allows (its file chooses it).
    #[error("the key file asks for more key-derivation work than allowed")]
    KdfTooCostly,
    #[error("the certificate could not be parsed or its signature is invalid")]
    CertificateInvalid,
    #[error("the certificate is not for this key")]
    CertificateMismatch,
    #[error("the certificate is a host certificate, not a user certificate")]
    CertificateNotForUsers,
    #[error("the certificate has expired")]
    CertificateExpired,
}

/// A decoded client private key. Never printed; the underlying key material is zeroized by the
/// `ssh-key` types when dropped.
pub struct ClientKey {
    key: PrivateKey,
}

impl fmt::Debug for ClientKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientKey").field("algorithm", &self.algorithm()).finish_non_exhaustive()
    }
}

impl ClientKey {
    /// Parses an OpenSSH/PEM private key. Bounded; never touches the filesystem.
    pub fn from_openssh(text: &str, passphrase: Option<&str>) -> Result<Self, KeyError> {
        if text.len() > MAX_KEY_TEXT_LEN {
            return Err(KeyError::TooLarge);
        }
        // agent D: PuTTY keys are checked before the library spends any work on them.
        if let Some(ppk) = ppk::header(text) {
            ppk.check()?;
            if ppk.encrypted && passphrase.is_none() {
                return Err(KeyError::PassphraseRequired);
            }
        }
        match decode_secret_key(text, passphrase) {
            Ok(key) => Ok(Self { key }),
            Err(russh::keys::Error::KeyIsEncrypted) => Err(KeyError::PassphraseRequired),
            Err(russh::keys::Error::UnsupportedKeyType { .. } | russh::keys::Error::UnknownAlgorithm(_)) => {
                Err(KeyError::Unsupported)
            }
            // With a passphrase supplied, a decryption failure surfaces as a parse/crypto error.
            // The library does not distinguish "wrong passphrase" from "corrupt after decrypt".
            Err(_) if passphrase.is_some() && Self::looks_encrypted(text) => Err(KeyError::WrongPassphrase),
            Err(_) => Err(KeyError::Malformed),
        }
    }

    fn looks_encrypted(text: &str) -> bool {
        if let Some(ppk) = ppk::header(text) {
            return ppk.encrypted;
        }
        matches!(decode_secret_key(text, None), Err(russh::keys::Error::KeyIsEncrypted))
    }

    /// Generates a new Ed25519 key from the OS-seeded CSPRNG.
    pub fn generate_ed25519() -> Result<Self, KeyError> {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(|_| KeyError::Unsupported)?;
        Ok(Self { key })
    }

    /// Whether `text` is a private key that needs a passphrase to decode.
    pub fn is_passphrase_protected(text: &str) -> bool {
        text.len() <= MAX_KEY_TEXT_LEN && Self::looks_encrypted(text)
    }

    /// Unencrypted OpenSSH private key text. Secret: for storing inside the vault only.
    pub fn to_openssh(&self) -> Result<Zeroizing<String>, KeyError> {
        self.key.to_openssh(LineEnding::LF).map_err(|_| KeyError::Malformed)
    }

    /// `<algorithm> <base64>` public key, safe to display and to install on servers.
    pub fn public_key_openssh(&self) -> Result<String, KeyError> {
        let text = self.key.public_key().to_openssh().map_err(|_| KeyError::Malformed)?;
        let mut parts = text.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some(algorithm), Some(blob)) => Ok(format!("{algorithm} {blob}")),
            _ => Err(KeyError::Malformed),
        }
    }

    pub fn algorithm(&self) -> String {
        self.key.algorithm().as_str().to_owned()
    }

    /// `SHA256:` fingerprint of the public half.
    pub fn fingerprint(&self) -> String {
        self.key.public_key().fingerprint(HashAlg::Sha256).to_string()
    }

    pub fn is_rsa(&self) -> bool {
        self.key.algorithm().is_rsa()
    }

    pub(crate) fn private_key(&self) -> &PrivateKey {
        &self.key
    }
}

// agent D: key generation choices, PuTTY key limits and user certificates

/// Key types Tyrminal generates. RSA keys are 3072 bits or more; there is no DSA.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    EcdsaP521,
    Rsa3072,
    Rsa4096,
}

impl ClientKey {
    /// Generates a new key of `kind` from the OS-seeded CSPRNG. RSA generation takes a while;
    /// call it off the async runtime.
    pub fn generate(kind: KeyKind) -> Result<Self, KeyError> {
        use russh::keys::ssh_key::private::{KeypairData, RsaKeypair};
        let mut rng = rand::rng();
        let ecdsa = |curve| PrivateKey::random(&mut rand::rng(), Algorithm::Ecdsa { curve });
        let key = match kind {
            KeyKind::Ed25519 => PrivateKey::random(&mut rng, Algorithm::Ed25519),
            KeyKind::EcdsaP256 => ecdsa(EcdsaCurve::NistP256),
            KeyKind::EcdsaP384 => ecdsa(EcdsaCurve::NistP384),
            KeyKind::EcdsaP521 => ecdsa(EcdsaCurve::NistP521),
            KeyKind::Rsa3072 | KeyKind::Rsa4096 => {
                let bits = if kind == KeyKind::Rsa3072 { 3072 } else { 4096 };
                RsaKeypair::random(&mut rng, bits).and_then(|pair| PrivateKey::new(KeypairData::from(pair), ""))
            }
        }
        .map_err(|_| KeyError::Unsupported)?;
        Ok(Self { key })
    }

    /// Checks a user certificate against this key; see [`check_user_certificate`].
    pub fn check_certificate(&self, text: &str, now: u64) -> Result<CertificateInfo, KeyError> {
        certificate_for(self.key.public_key().key_data(), text, now)
    }
}

/// Checks an OpenSSH user certificate (`*-cert-v01@openssh.com …`) against a public key
/// (`<algorithm> <base64>`): it must parse, carry a valid CA signature, be a user certificate,
/// certify exactly this key and not have expired at `now` (Unix seconds). Whether the server
/// trusts its CA, and which principals it accepts, only the server decides.
pub fn check_user_certificate(public_key: &str, text: &str, now: u64) -> Result<CertificateInfo, KeyError> {
    let key = PublicKey::from_openssh(public_key.trim()).map_err(|_| KeyError::Malformed)?;
    certificate_for(key.key_data(), text, now)
}

fn certificate_for(
    key: &russh::keys::ssh_key::public::KeyData,
    text: &str,
    now: u64,
) -> Result<CertificateInfo, KeyError> {
    if text.len() > MAX_KEY_TEXT_LEN {
        return Err(KeyError::TooLarge);
    }
    let cert = Certificate::from_openssh(text.trim()).map_err(|_| KeyError::CertificateInvalid)?;
    cert.verify_signature().map_err(|_| KeyError::CertificateInvalid)?;
    if cert.cert_type() != CertType::User {
        return Err(KeyError::CertificateNotForUsers);
    }
    if cert.public_key() != key {
        return Err(KeyError::CertificateMismatch);
    }
    if cert.valid_before() <= now {
        return Err(KeyError::CertificateExpired);
    }
    let text = cert.to_openssh().map_err(|_| KeyError::CertificateInvalid)?;
    let algorithm = text.split_whitespace().next().ok_or(KeyError::CertificateInvalid)?.to_owned();
    Ok(CertificateInfo {
        text,
        algorithm,
        key_id: cert.key_id().to_owned(),
        principals: cert.valid_principals().to_vec(),
        valid_after: cert.valid_after(),
        valid_before: cert.valid_before(),
        ca_fingerprint: cert.signature_key().fingerprint(HashAlg::Sha256).to_string(),
    })
}

/// Parses one OpenSSH public key (`<algorithm> <base64> [comment]`) as a host key, for importing
/// `known_hosts` entries. `None` if it does not parse or is not a host key type this client
/// accepts (see `algorithms.rs`), so nothing is trusted that could never be negotiated.
pub fn host_key_from_openssh(text: &str) -> Option<crate::PresentedHostKey> {
    if text.len() > MAX_KEY_TEXT_LEN {
        return None;
    }
    let key = PublicKey::from_openssh(text.trim()).ok()?;
    if !crate::algorithms::accepts_host_key(key.algorithm().as_str()) {
        return None;
    }
    crate::PresentedHostKey::from_public_key(&key)
}

/// What a checked user certificate says. `text` is the normalized certificate line (public data).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateInfo {
    pub text: String,
    pub algorithm: String,
    pub key_id: String,
    /// Empty: valid for any principal the server accepts.
    pub principals: Vec<String>,
    pub valid_after: u64,
    /// `u64::MAX`: never expires.
    pub valid_before: u64,
    pub ca_fingerprint: String,
}

/// PuTTY key files (`PuTTY-User-Key-File-2/3`): the header is read here so that the work a file
/// can demand from Argon2 is bounded before any decoding starts.
mod ppk {
    use super::KeyError;

    /// PuTTY's defaults are 8 MiB, a few passes and one lane; these bounds leave room for keys
    /// made with stronger settings while keeping one decode well under a second and 256 MiB.
    pub(super) const MAX_ARGON2_MEMORY_KIB: u64 = 256 * 1024;
    pub(super) const MAX_ARGON2_PASSES: u64 = 64;
    pub(super) const MAX_ARGON2_LANES: u64 = 16;

    pub(super) struct Header {
        pub encrypted: bool,
        memory: Option<u64>,
        passes: Option<u64>,
        lanes: Option<u64>,
        malformed: bool,
    }

    pub(super) fn header(text: &str) -> Option<Header> {
        let text = text.trim_start();
        if !text.starts_with("PuTTY-User-Key-File-") {
            return None;
        }
        let mut h = Header { encrypted: false, memory: None, passes: None, lanes: None, malformed: false };
        for line in text.lines().take(64) {
            let Some((name, value)) = line.split_once(": ") else { continue };
            let number = || value.trim().parse::<u64>().ok();
            match name {
                "Encryption" => h.encrypted = value.trim() != "none",
                "Argon2-Memory" => h.memory = number(),
                "Argon2-Passes" => h.passes = number(),
                "Argon2-Parallelism" => h.lanes = number(),
                _ => {}
            }
            if matches!(name, "Argon2-Memory" | "Argon2-Passes" | "Argon2-Parallelism") && number().is_none() {
                h.malformed = true;
            }
        }
        Some(h)
    }

    impl Header {
        pub(super) fn check(&self) -> Result<(), KeyError> {
            if self.malformed {
                return Err(KeyError::Malformed);
            }
            let over = |value: Option<u64>, max| value.is_some_and(|v| v > max);
            if over(self.memory, MAX_ARGON2_MEMORY_KIB)
                || over(self.passes, MAX_ARGON2_PASSES)
                || over(self.lanes, MAX_ARGON2_LANES)
            {
                return Err(KeyError::KdfTooCostly);
            }
            Ok(())
        }
    }
}

/// Outcome of one authentication attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthOutcome {
    Success,
    Failure {
        /// Method names the server says may continue (untrusted, informational).
        remaining_methods: Vec<String>,
        /// The method was accepted but the server requires another factor.
        partial_success: bool,
    },
}

impl AuthOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Success)
    }
}

/// Upper bounds for a keyboard-interactive exchange. The server controls how many rounds and
/// prompts it sends, so both are capped; exceeding either ends authentication.
pub const MAX_KBD_ROUNDS: usize = 8;
pub const MAX_KBD_PROMPTS: usize = 8;
/// Longest server-supplied name, instruction or prompt kept, in bytes.
pub const MAX_SERVER_TEXT: usize = 512;

/// One prompt of a keyboard-interactive round. `text` is server-supplied and untrusted: it has
/// been sanitized for display (no control characters) and must still be rendered as plain text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbdPrompt {
    pub text: String,
    /// Whether the server says the answer may be shown while typed (false for secrets).
    pub echo: bool,
}

/// One keyboard-interactive information request, sanitized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbdRound {
    /// 1-based round number.
    pub round: usize,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdPrompt>,
}

/// Makes server text safe to display: drops control characters (keeping line breaks), Unicode
/// bidi controls, trims, and truncates to `max` bytes on a character boundary.
pub fn sanitize_server_text(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.replace("\r\n", "\n").chars() {
        let bidi = matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}');
        if bidi || (ch.is_control() && ch != '\n') {
            continue;
        }
        if out.len() + ch.len_utf8() > max {
            break;
        }
        out.push(ch);
    }
    out.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_round_trip_through_openssh_text() {
        let key = ClientKey::generate_ed25519().unwrap();
        assert_eq!(key.algorithm(), "ssh-ed25519");
        let text = key.to_openssh().unwrap();
        assert!(!ClientKey::is_passphrase_protected(&text));
        let again = ClientKey::from_openssh(&text, None).unwrap();
        assert_eq!(again.fingerprint(), key.fingerprint());
        assert_eq!(again.public_key_openssh().unwrap(), key.public_key_openssh().unwrap());
        assert!(key.public_key_openssh().unwrap().starts_with("ssh-ed25519 AAAA"));
        // Two generated keys differ.
        assert_ne!(ClientKey::generate_ed25519().unwrap().fingerprint(), key.fingerprint());
        // Debug output never contains key material.
        assert!(!format!("{key:?}").contains(&text[40..60]));
    }

    #[test]
    fn garbage_and_oversized_keys_are_rejected() {
        assert_eq!(ClientKey::from_openssh("", None).err(), Some(KeyError::Malformed));
        assert_eq!(ClientKey::from_openssh("not a key", None).err(), Some(KeyError::Malformed));
        assert_eq!(
            ClientKey::from_openssh(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
                None
            )
            .err(),
            Some(KeyError::Malformed)
        );
        let huge = "A".repeat(MAX_KEY_TEXT_LEN + 1);
        assert_eq!(ClientKey::from_openssh(&huge, None).err(), Some(KeyError::TooLarge));
    }

    #[test]
    fn server_text_is_sanitized_and_bounded() {
        assert_eq!(sanitize_server_text("  Password: ", 64), "Password:");
        assert_eq!(sanitize_server_text("a\x1b[31mred\x07\r\nnext", 64), "a[31mred\nnext");
        assert_eq!(sanitize_server_text("ok\u{202e}evil", 64), "okevil");
        assert_eq!(sanitize_server_text("éééé", 5), "éé");
        assert_eq!(sanitize_server_text(&"x".repeat(2000), MAX_SERVER_TEXT).len(), MAX_SERVER_TEXT);
    }

    // agent D: key formats and certificates

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{}/../../tests/fixtures/keys/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn putty_v2_and_v3_keys_import_with_their_passphrase() {
        let plain = ClientKey::from_openssh(&fixture("ed25519-v3.ppk"), None).unwrap();
        assert_eq!(plain.algorithm(), "ssh-ed25519");
        assert!(!ClientKey::is_passphrase_protected(&fixture("ed25519-v3.ppk")));

        for (name, algorithm) in [("ecdsa-v3-enc.ppk", "ecdsa-sha2-nistp256"), ("rsa-v2-enc.ppk", "rsa-sha2-512")] {
            let text = fixture(name);
            assert!(ClientKey::is_passphrase_protected(&text), "{name}");
            assert_eq!(ClientKey::from_openssh(&text, None).err(), Some(KeyError::PassphraseRequired), "{name}");
            assert!(ClientKey::from_openssh(&text, Some("wrong")).is_err(), "{name}");
            let key = ClientKey::from_openssh(&text, Some("fixture passphrase")).unwrap();
            assert!(
                key.algorithm() == algorithm || (algorithm.starts_with("rsa") && key.is_rsa()),
                "{name}: {}",
                key.algorithm()
            );
            // The decrypted key re-encodes as OpenSSH text with the same fingerprint.
            let again = ClientKey::from_openssh(&key.to_openssh().unwrap(), None).unwrap();
            assert_eq!(again.fingerprint(), key.fingerprint());
        }
    }

    #[test]
    fn putty_keys_cannot_demand_unbounded_key_derivation_work() {
        let text = fixture("ecdsa-v3-enc.ppk");
        let line = text.lines().find(|l| l.starts_with("Argon2-Memory")).unwrap().to_owned();
        for costly in [
            text.replace(&line, "Argon2-Memory: 4194304"),
            text.replace("Argon2-Passes: ", "Argon2-Passes: 1000"),
            text.replace("Argon2-Parallelism: 1", "Argon2-Parallelism: 255"),
        ] {
            // Refused before any Argon2 work, with or without a passphrase.
            assert_eq!(
                ClientKey::from_openssh(&costly, Some("fixture passphrase")).err(),
                Some(KeyError::KdfTooCostly)
            );
            assert_eq!(ClientKey::from_openssh(&costly, None).err(), Some(KeyError::KdfTooCostly));
        }
        let garbage = text.replace(&line, "Argon2-Memory: lots");
        assert_eq!(ClientKey::from_openssh(&garbage, Some("fixture passphrase")).err(), Some(KeyError::Malformed));
    }

    #[test]
    fn generated_ecdsa_and_rsa_keys_round_trip() {
        for (kind, algorithm) in [
            (KeyKind::Ed25519, "ssh-ed25519"),
            (KeyKind::EcdsaP256, "ecdsa-sha2-nistp256"),
            (KeyKind::EcdsaP384, "ecdsa-sha2-nistp384"),
            (KeyKind::EcdsaP521, "ecdsa-sha2-nistp521"),
            (KeyKind::Rsa3072, "ssh-rsa"),
        ] {
            let key = ClientKey::generate(kind).unwrap();
            assert_eq!(key.algorithm(), algorithm);
            let again = ClientKey::from_openssh(&key.to_openssh().unwrap(), None).unwrap();
            assert_eq!(again.public_key_openssh().unwrap(), key.public_key_openssh().unwrap());
        }
        let rsa = ClientKey::generate(KeyKind::Rsa3072).unwrap();
        let Some(russh::keys::ssh_key::public::KeyData::Rsa(public)) =
            Some(rsa.private_key().public_key().key_data().clone())
        else {
            panic!("not RSA")
        };
        assert_eq!(public.key_size(), 3072);
    }

    #[test]
    fn user_certificates_must_match_the_key_be_signed_and_unexpired() {
        use russh::keys::ssh_key::certificate::Builder;
        let ca = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let user = ClientKey::generate(KeyKind::Ed25519).unwrap();
        let other = ClientKey::generate(KeyKind::Ed25519).unwrap();
        let now = 1_800_000_000;
        let make = |key: &ClientKey, kind: CertType, before: u64| {
            let mut b =
                Builder::new_with_random_nonce(&mut rand::rng(), key.private_key().public_key(), now - 60, before)
                    .unwrap();
            b.cert_type(kind).unwrap();
            b.key_id("synthetic user").unwrap();
            b.valid_principal("tyr").unwrap();
            b.sign(&ca).unwrap().to_openssh().unwrap()
        };
        let good = make(&user, CertType::User, now + 3600);
        let info = user.check_certificate(&good, now).unwrap();
        assert_eq!(info.principals, ["tyr"]);
        assert_eq!(info.key_id, "synthetic user");
        assert_eq!(info.algorithm, "ssh-ed25519-cert-v01@openssh.com");
        assert_eq!(info.ca_fingerprint, ca.public_key().fingerprint(HashAlg::Sha256).to_string());

        assert_eq!(other.check_certificate(&good, now).err(), Some(KeyError::CertificateMismatch));
        assert_eq!(user.check_certificate(&good, now + 7200).err(), Some(KeyError::CertificateExpired));
        assert_eq!(
            user.check_certificate(&make(&user, CertType::Host, now + 3600), now).err(),
            Some(KeyError::CertificateNotForUsers)
        );
        // A flipped byte in the signed body breaks the CA signature.
        let mut parts: Vec<String> = good.split(' ').map(str::to_owned).collect();
        let mut blob = parts[1].clone().into_bytes();
        let at = blob.len() / 2;
        blob[at] = if blob[at] == b'A' { b'B' } else { b'A' };
        parts[1] = String::from_utf8(blob).unwrap();
        assert_eq!(user.check_certificate(&parts.join(" "), now).err(), Some(KeyError::CertificateInvalid));
        assert_eq!(user.check_certificate("ssh-ed25519 AAAA", now).err(), Some(KeyError::CertificateInvalid));
    }
}

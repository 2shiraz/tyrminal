use core::fmt;

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::encoding::{base32_decode, base32_encode};
use crate::{SecretKey, VaultError};

const CHECK_LABEL: &[u8] = b"tyrminal.recovery.check.v1";
const GROUP: usize = 5;

/// A locally generated 256-bit recovery key (docs/crypto-format.md §6).
pub struct RecoveryKey(SecretKey);

impl RecoveryKey {
    pub fn generate() -> Result<Self, VaultError> {
        Ok(Self(SecretKey::generate()?))
    }

    pub(crate) fn key(&self) -> &SecretKey {
        &self.0
    }

    fn check(key: &[u8; 32]) -> [u8; 2] {
        let digest = Sha256::new().chain_update(CHECK_LABEL).chain_update(key).finalize();
        [digest[0], digest[1]]
    }

    /// Human-readable form: 55 Crockford base32 characters in hyphenated groups of five.
    /// The returned string is zeroized when dropped; show it once and do not store it.
    pub fn to_display_string(&self) -> Zeroizing<String> {
        let mut raw = Zeroizing::new([0u8; 34]);
        raw[..32].copy_from_slice(self.0.expose());
        raw[32..].copy_from_slice(&Self::check(self.0.expose()));
        let flat = Zeroizing::new(base32_encode(&raw[..]));
        let mut out = Zeroizing::new(String::with_capacity(flat.len() + flat.len() / GROUP));
        for (i, ch) in flat.chars().enumerate() {
            if i > 0 && i % GROUP == 0 {
                out.push('-');
            }
            out.push(ch);
        }
        out
    }

    /// Parses user input. Case, spaces and hyphens are ignored; `O` reads as `0`, `I`/`L` as `1`.
    pub fn parse(text: &str) -> Result<Self, VaultError> {
        if text.len() > 256 {
            return Err(VaultError::InvalidRecoveryKey);
        }
        let mut symbols = Zeroizing::new(Vec::with_capacity(55));
        for ch in text.chars() {
            match ch {
                '-' | ' ' | '\t' | '\n' | '\r' => {}
                'o' | 'O' => symbols.push(b'0'),
                'i' | 'I' | 'l' | 'L' => symbols.push(b'1'),
                c if c.is_ascii_alphanumeric() => symbols.push(c.to_ascii_uppercase() as u8),
                _ => return Err(VaultError::InvalidRecoveryKey),
            }
        }
        let mut raw = base32_decode::<34>(&symbols).ok_or(VaultError::InvalidRecoveryKey)?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&raw[..32]);
        let ok = Self::check(&key) == [raw[32], raw[33]];
        raw.zeroize();
        if !ok {
            key.zeroize();
            return Err(VaultError::InvalidRecoveryKey);
        }
        Ok(Self(SecretKey::from_bytes(key)))
    }
}

impl fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoveryKey(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_form_round_trips_with_forgiving_input() {
        let key = RecoveryKey::generate().unwrap();
        let text = key.to_display_string();
        assert_eq!(text.len(), 55 + 10);
        assert_eq!(text.split('-').count(), 11);
        let parsed = RecoveryKey::parse(&text).unwrap();
        assert_eq!(parsed.key().expose(), key.key().expose());
        let sloppy = text.to_lowercase().replace('-', " ");
        assert_eq!(RecoveryKey::parse(&sloppy).unwrap().key().expose(), key.key().expose());
    }

    #[test]
    fn typos_and_garbage_are_rejected() {
        let key = RecoveryKey::generate().unwrap();
        let text = key.to_display_string().to_string();
        // Change one symbol to a different valid symbol: the check must catch it.
        let mut chars: Vec<char> = text.chars().collect();
        chars[0] = if chars[0] == '7' { '8' } else { '7' };
        let typo: String = chars.into_iter().collect();
        assert_eq!(RecoveryKey::parse(&typo).err(), Some(VaultError::InvalidRecoveryKey));
        for bad in ["", "short", "!!!!!-!!!!!", &"A".repeat(300), &text[..text.len() - 1]] {
            assert_eq!(RecoveryKey::parse(bad).err(), Some(VaultError::InvalidRecoveryKey));
        }
    }

    #[test]
    fn debug_output_is_redacted() {
        let key = RecoveryKey::generate().unwrap();
        assert_eq!(format!("{key:?}"), "RecoveryKey(<redacted>)");
    }
}

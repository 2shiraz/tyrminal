use crate::kdf::hkdf_key;
use crate::{Id, SecretKey, VaultError};

pub(crate) const LABEL_RECORDS: &[u8] = b"tyrminal.subkey.v1.records";
pub(crate) const LABEL_HEADER_MAC: &[u8] = b"tyrminal.subkey.v1.header-mac";
pub(crate) const LABEL_BACKUP: &[u8] = b"tyrminal.subkey.v1.backup";
pub(crate) const LABEL_LOGS: &[u8] = b"tyrminal.subkey.v1.logs";
pub(crate) const LABEL_KEK_RECOVERY: &[u8] = b"tyrminal.kek.recovery.v1";
pub(crate) const LABEL_KEK_DEVICE: &[u8] = b"tyrminal.kek.device.v1";

/// Derives a purpose-specific subkey from the vault root key (docs/crypto-format.md §2).
pub(crate) fn subkey(root: &SecretKey, vault_id: &Id, label: &[u8]) -> Result<SecretKey, VaultError> {
    hkdf_key(root.expose(), vault_id, label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subkeys_are_separated_by_label_and_vault() {
        let root = SecretKey::from_bytes([9u8; 32]);
        let v1 = [1u8; 16];
        let v2 = [2u8; 16];
        let records = subkey(&root, &v1, LABEL_RECORDS).unwrap();
        let mac = subkey(&root, &v1, LABEL_HEADER_MAC).unwrap();
        let other_vault = subkey(&root, &v2, LABEL_RECORDS).unwrap();
        assert_ne!(records.expose(), mac.expose());
        assert_ne!(records.expose(), other_vault.expose());
        assert_ne!(records.expose(), root.expose());
        let logs = subkey(&root, &v1, LABEL_LOGS).unwrap();
        assert_ne!(logs.expose(), records.expose());
        assert_ne!(logs.expose(), subkey(&root, &v1, LABEL_BACKUP).unwrap().expose());
        // Deterministic for the same inputs.
        assert_eq!(records.expose(), subkey(&root, &v1, LABEL_RECORDS).unwrap().expose());
    }
}

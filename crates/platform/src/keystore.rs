use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use thiserror::Error;
use zeroize::Zeroizing;

/// Secret-store failures. There is deliberately no variant that leads to a plaintext fallback:
/// callers must ask for the passphrase again or explain the failure (BUILD_SPEC §4.3, P-11).
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum KeystoreError {
    #[error("the operating system secret store is not available")]
    Unavailable,
    #[error("the operating system denied access to the secret store")]
    AccessDenied,
    #[error("the account name is not valid for the secret store")]
    InvalidAccount,
    #[error("the secret store operation failed")]
    Failed,
}

/// A place the OS protects on the user's behalf. Accounts are application-chosen identifiers
/// (never user data such as host names).
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError>;
    /// `Ok(None)` when nothing is stored under `account`.
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError>;
    /// Deleting a missing entry succeeds.
    fn delete(&self, account: &str) -> Result<(), KeystoreError>;
}

fn check_account(account: &str) -> Result<(), KeystoreError> {
    let ok = !account.is_empty()
        && account.len() <= 128
        && account.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if ok { Ok(()) } else { Err(KeystoreError::InvalidAccount) }
}

/// The platform secret store: macOS Keychain (login keychain, generic password items) or Windows
/// Credential Manager. Other platforms report `Unavailable`.
///
/// What this is and is not: items are protected by the OS for the logged-in user. On macOS the
/// item's access control is tied to the creating application's code signature; an unsigned
/// development build gets weaker, path-based identity. This is storage for quick-unlock wrapping
/// material, not hardware-backed key protection and not biometric gating.
#[derive(Debug, Clone)]
pub struct OsSecretStore {
    service: String,
}

static STORE_INIT: OnceLock<Result<(), KeystoreError>> = OnceLock::new();

fn init_default_store() -> Result<(), KeystoreError> {
    *STORE_INIT.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            let store = apple_native_keyring_store::keychain::Store::new().map_err(|_| KeystoreError::Unavailable)?;
            keyring_core::set_default_store(store);
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let store = windows_native_keyring_store::Store::new().map_err(|_| KeystoreError::Unavailable)?;
            keyring_core::set_default_store(store);
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err(KeystoreError::Unavailable)
        }
    })
}

fn map_error(err: &keyring_core::Error) -> KeystoreError {
    match err {
        keyring_core::Error::NoStorageAccess(_) => KeystoreError::AccessDenied,
        keyring_core::Error::NoDefaultStore | keyring_core::Error::NotSupportedByStore(_) => KeystoreError::Unavailable,
        keyring_core::Error::Invalid(..) | keyring_core::Error::TooLong(..) => KeystoreError::InvalidAccount,
        _ => KeystoreError::Failed,
    }
}

impl OsSecretStore {
    /// `service` namespaces every item this application stores, e.g. the bundle identifier.
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(&self, account: &str) -> Result<keyring_core::Entry, KeystoreError> {
        check_account(account)?;
        init_default_store()?;
        keyring_core::Entry::new(&self.service, account).map_err(|e| map_error(&e))
    }
}

impl SecretStore for OsSecretStore {
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
        self.entry(account)?.set_secret(secret).map_err(|e| map_error(&e))
    }

    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        match self.entry(account)?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_error(&e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), KeystoreError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_error(&e)),
        }
    }
}

/// A store that always fails, for exercising the "secret store unavailable" paths.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableSecretStore;

impl SecretStore for UnavailableSecretStore {
    fn set(&self, _: &str, _: &[u8]) -> Result<(), KeystoreError> {
        Err(KeystoreError::Unavailable)
    }
    fn get(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Err(KeystoreError::Unavailable)
    }
    fn delete(&self, _: &str) -> Result<(), KeystoreError> {
        Err(KeystoreError::Unavailable)
    }
}

/// Process-memory store for tests. It is not a mock of the OS store's security and must never be
/// wired into an application build; `scripts/check-release.mjs` (Phase 09) scans for that.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    items: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}

impl SecretStore for MemorySecretStore {
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
        check_account(account)?;
        let mut items = self.items.lock().map_err(|_| KeystoreError::Failed)?;
        items.insert(account.to_owned(), Zeroizing::new(secret.to_vec()));
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        check_account(account)?;
        let items = self.items.lock().map_err(|_| KeystoreError::Failed)?;
        Ok(items.get(account).map(|s| Zeroizing::new(s.to_vec())))
    }

    fn delete(&self, account: &str) -> Result<(), KeystoreError> {
        check_account(account)?;
        self.items.lock().map_err(|_| KeystoreError::Failed)?.remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(store: &dyn SecretStore, account: &str) {
        assert_eq!(store.get(account).unwrap(), None);
        store.delete(account).unwrap(); // deleting nothing is fine
        store.set(account, &[1, 2, 3, 0, 255]).unwrap();
        assert_eq!(store.get(account).unwrap().as_deref().map(Vec::as_slice), Some(&[1u8, 2, 3, 0, 255][..]));
        store.set(account, b"replaced").unwrap();
        assert_eq!(store.get(account).unwrap().as_deref().map(Vec::as_slice), Some(&b"replaced"[..]));
        store.delete(account).unwrap();
        assert_eq!(store.get(account).unwrap(), None);
    }

    #[test]
    fn memory_store_round_trips() {
        exercise(&MemorySecretStore::default(), "device-secret.test");
    }

    #[test]
    fn account_names_are_restricted() {
        let store = MemorySecretStore::default();
        for bad in ["", "has space", "slash/inside", "semi;colon", "quote\"", &"a".repeat(129), "ünïcode"] {
            assert_eq!(store.set(bad, b"x"), Err(KeystoreError::InvalidAccount), "{bad:?}");
        }
        let os = OsSecretStore::new("app.tyrminal.desktop.test");
        assert_eq!(os.set("../escape", b"x"), Err(KeystoreError::InvalidAccount));
    }

    #[test]
    fn unavailable_store_fails_every_operation() {
        let store = UnavailableSecretStore;
        assert_eq!(store.set("a", b"x"), Err(KeystoreError::Unavailable));
        assert_eq!(store.get("a"), Err(KeystoreError::Unavailable));
        assert_eq!(store.delete("a"), Err(KeystoreError::Unavailable));
    }

    /// Real OS secret store. Creates, reads, replaces and deletes one item under a random,
    /// test-only account, and touches nothing else in the user's keychain.
    #[test]
    #[ignore = "writes a temporary item to the real OS secret store"]
    fn os_secret_store_round_trips() {
        let mut suffix = [0u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let account = format!("spike-{}", suffix.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let store = OsSecretStore::new("app.tyrminal.desktop.test");
        struct Cleanup<'a>(&'a OsSecretStore, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete(self.1);
            }
        }
        let _cleanup = Cleanup(&store, &account);
        exercise(&store, &account);
    }
}

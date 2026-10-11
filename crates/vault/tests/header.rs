//! Adversarial tests for the vault header and key slots (BUILD_SPEC §9.3 "Vault", INV-11, INV-18).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::LazyLock;

use proptest::prelude::*;
use tyrminal_vault::{
    Credential, MAX_DEVICE_SLOTS, NewVault, PASSPHRASE_MAX_LEN, Passphrase, RecordContext,
    RecoveryKey, SecretKey, SlotKind, VaultError, VaultHeader, create_vault,
};

const PASSPHRASE: &str = "correct horse battery staple";
const PREFIX_LEN: usize = 31;
const SLOT_LEN: usize = 123;

fn pass(text: &str) -> Passphrase {
    Passphrase::new(text.to_owned())
}

/// One vault shared by tests that only read it, so Argon2id runs once.
static VAULT: LazyLock<NewVault> =
    LazyLock::new(|| create_vault(&pass(PASSPHRASE)).expect("create vault"));

fn is_rejection(err: VaultError) -> bool {
    matches!(
        err,
        VaultError::WrongCredential
            | VaultError::HeaderTampered
            | VaultError::MalformedHeader
            | VaultError::UnsupportedVersion
            | VaultError::UnsupportedKdfProfile
            | VaultError::NoSuchSlot
    )
}

#[test]
fn create_encode_decode_unlock_with_passphrase_and_recovery() {
    let bytes = VAULT.header.encode();
    assert_eq!(bytes.len(), PREFIX_LEN + 2 * SLOT_LEN + 32);
    let header = VaultHeader::decode(&bytes).unwrap();
    assert_eq!(header, VAULT.header);
    assert_eq!(header.slot_count(SlotKind::Passphrase), 1);
    assert_eq!(header.slot_count(SlotKind::Recovery), 1);
    assert_eq!(header.slot_count(SlotKind::Device), 0);

    let by_pass = header
        .unlock(&Credential::Passphrase(&pass(PASSPHRASE)))
        .unwrap();
    let by_recovery = header
        .unlock(&Credential::Recovery(&VAULT.recovery_key))
        .unwrap();

    // Both paths yield the same record key: a record sealed by one opens with the other.
    let ctx = RecordContext {
        record_id: [5; 16],
        kind: 1,
        revision: 1,
    };
    let sealed = by_pass.seal(&ctx, b"payload").unwrap();
    assert_eq!(&*by_recovery.open(&ctx, &sealed).unwrap(), b"payload");
}

#[test]
fn wrong_credentials_are_rejected_without_key_material() {
    let header = &VAULT.header;
    assert_eq!(
        header
            .unlock(&Credential::Passphrase(&pass(
                "correct horse battery stapl"
            )))
            .err(),
        Some(VaultError::WrongCredential)
    );
    let other = RecoveryKey::generate().unwrap();
    assert_eq!(
        header.unlock(&Credential::Recovery(&other)).err(),
        Some(VaultError::WrongCredential)
    );
    let device = SecretKey::generate().unwrap();
    assert_eq!(
        header.unlock(&Credential::Device(&device)).err(),
        Some(VaultError::NoSuchSlot)
    );
}

#[test]
fn passphrase_length_bounds_apply_to_create_and_unlock() {
    assert_eq!(
        create_vault(&pass("short7!")).err(),
        Some(VaultError::PassphraseLength)
    );
    assert_eq!(
        create_vault(&pass(&"x".repeat(PASSPHRASE_MAX_LEN + 1))).err(),
        Some(VaultError::PassphraseLength)
    );
    let header = &VAULT.header;
    assert_eq!(
        header.unlock(&Credential::Passphrase(&pass(""))).err(),
        Some(VaultError::PassphraseLength)
    );
    assert_eq!(
        header
            .unlock(&Credential::Passphrase(&pass(
                &"x".repeat(PASSPHRASE_MAX_LEN + 1)
            )))
            .err(),
        Some(VaultError::PassphraseLength)
    );
}

/// Flips every single bit of the header and attempts a (cheap) recovery unlock. No flipped header
/// may unlock: each is rejected as malformed, unsupported, wrong-credential or tampered.
#[test]
fn every_single_bit_flip_in_the_header_is_rejected() {
    let good = VAULT.header.encode();
    let credential = Credential::Recovery(&VAULT.recovery_key);
    for bit in 0..good.len() * 8 {
        let mut bad = good.clone();
        bad[bit / 8] ^= 1 << (bit % 8);
        let outcome = VaultHeader::decode(&bad).and_then(|h| h.unlock(&credential));
        match outcome {
            Ok(_) => panic!("header with bit {bit} flipped unlocked"),
            Err(e) => assert!(is_rejection(e), "bit {bit}: unexpected error {e:?}"),
        }
    }
}

#[test]
fn tampering_with_another_slot_is_caught_by_the_header_mac() {
    // Corrupt the *passphrase* slot's wrapped key, then unlock through the intact recovery slot:
    // the slot opens, but the header as a whole no longer verifies.
    let mut bytes = VAULT.header.encode();
    bytes[PREFIX_LEN + SLOT_LEN - 1] ^= 0x01;
    let header = VaultHeader::decode(&bytes).unwrap();
    assert_eq!(
        header
            .unlock(&Credential::Recovery(&VAULT.recovery_key))
            .err(),
        Some(VaultError::HeaderTampered)
    );
}

#[test]
fn slots_cannot_be_transplanted_between_vaults() {
    // Same passphrase, different vault: the slot AAD binds the vault id, so a transplanted slot
    // does not open even though the passphrase is "right" for both vaults.
    let other = create_vault(&pass(PASSPHRASE)).unwrap();
    let mut franken = VAULT.header.encode();
    let donor = other.header.encode();
    franken[PREFIX_LEN..PREFIX_LEN + SLOT_LEN]
        .copy_from_slice(&donor[PREFIX_LEN..PREFIX_LEN + SLOT_LEN]);
    let header = VaultHeader::decode(&franken).unwrap();
    assert_eq!(
        header
            .unlock(&Credential::Passphrase(&pass(PASSPHRASE)))
            .err(),
        Some(VaultError::WrongCredential)
    );

    // Swapping the whole header in is "valid" for the donor vault but must not verify against
    // the original vault's keys.
    assert_eq!(
        VAULT.unlocked.verify_header(&other.header).err(),
        Some(VaultError::HeaderTampered)
    );
}

#[test]
fn structural_attacks_on_the_header_are_rejected_before_any_kdf_work() {
    let good = VAULT.header.encode();

    let mut version = good.clone();
    version[9] = 2;
    assert_eq!(
        VaultHeader::decode(&version).err(),
        Some(VaultError::UnsupportedVersion)
    );

    let mut magic = good.clone();
    magic[0] = b'X';
    assert_eq!(
        VaultHeader::decode(&magic).err(),
        Some(VaultError::MalformedHeader)
    );

    // An attacker-chosen KDF profile id (e.g. hoping for weaker or absurdly expensive parameters).
    let mut profile = good.clone();
    profile[PREFIX_LEN + 17] = 0x7f;
    assert_eq!(
        VaultHeader::decode(&profile).err(),
        Some(VaultError::UnsupportedKdfProfile)
    );

    // A known profile on the wrong slot kind (HKDF on the passphrase slot).
    let mut mismatched = good.clone();
    mismatched[PREFIX_LEN + 17] = 0x01;
    mismatched[PREFIX_LEN + 18] = 0x00;
    assert_eq!(
        VaultHeader::decode(&mismatched).err(),
        Some(VaultError::MalformedHeader)
    );

    for count in [0u8, 7, 255] {
        let mut slots = good.clone();
        slots[30] = count;
        assert_eq!(
            VaultHeader::decode(&slots).err(),
            Some(VaultError::MalformedHeader),
            "slot_count {count}"
        );
    }

    let mut key_version = good.clone();
    key_version[26..30].copy_from_slice(&[0, 0, 0, 0]);
    assert_eq!(
        VaultHeader::decode(&key_version).err(),
        Some(VaultError::MalformedHeader)
    );

    assert_eq!(
        VaultHeader::decode(&good[..good.len() - 1]).err(),
        Some(VaultError::MalformedHeader)
    );
    let mut extended = good.clone();
    extended.push(0);
    assert_eq!(
        VaultHeader::decode(&extended).err(),
        Some(VaultError::MalformedHeader)
    );
    assert_eq!(
        VaultHeader::decode(&[]).err(),
        Some(VaultError::MalformedHeader)
    );

    // Recovery slot relabelled as a second passphrase slot: exactly one passphrase slot is allowed,
    // so one unlock can never be made to run Argon2id more than once.
    let mut two_pass = good.clone();
    two_pass[PREFIX_LEN + SLOT_LEN] = 1;
    two_pass[PREFIX_LEN + SLOT_LEN + 17] = 0x00;
    two_pass[PREFIX_LEN + SLOT_LEN + 18] = 0x01;
    assert_eq!(
        VaultHeader::decode(&two_pass).err(),
        Some(VaultError::MalformedHeader)
    );

    // Duplicate slot ids.
    let mut duplicate = good;
    let first_id: Vec<u8> = duplicate[PREFIX_LEN + 1..PREFIX_LEN + 17].to_vec();
    duplicate[PREFIX_LEN + SLOT_LEN + 1..PREFIX_LEN + SLOT_LEN + 17].copy_from_slice(&first_id);
    assert_eq!(
        VaultHeader::decode(&duplicate).err(),
        Some(VaultError::MalformedHeader)
    );
}

#[test]
fn changing_the_passphrase_rewraps_without_touching_records() {
    let vault = create_vault(&pass(PASSPHRASE)).unwrap();
    let ctx = RecordContext {
        record_id: [9; 16],
        kind: 2,
        revision: 3,
    };
    let sealed = vault.unlocked.seal(&ctx, b"before").unwrap();

    let new_header = vault
        .unlocked
        .change_passphrase(&vault.header, &pass("a completely new passphrase"))
        .unwrap();
    assert_ne!(new_header, vault.header);
    assert_eq!(new_header.slot_count(SlotKind::Passphrase), 1);
    assert_eq!(new_header.slot_count(SlotKind::Recovery), 1);

    assert_eq!(
        new_header
            .unlock(&Credential::Passphrase(&pass(PASSPHRASE)))
            .err(),
        Some(VaultError::WrongCredential)
    );
    let reopened = new_header
        .unlock(&Credential::Passphrase(&pass(
            "a completely new passphrase",
        )))
        .unwrap();
    assert_eq!(&*reopened.open(&ctx, &sealed).unwrap(), b"before");
    new_header
        .unlock(&Credential::Recovery(&vault.recovery_key))
        .expect("recovery still works");

    assert_eq!(
        vault
            .unlocked
            .change_passphrase(&vault.header, &pass("short"))
            .err(),
        Some(VaultError::PassphraseLength)
    );
}

#[test]
fn rotating_the_recovery_key_invalidates_the_old_one() {
    let vault = create_vault(&pass(PASSPHRASE)).unwrap();
    let (header, new_key) = vault.unlocked.rotate_recovery_key(&vault.header).unwrap();
    assert_eq!(header.slot_count(SlotKind::Recovery), 1);
    assert_eq!(
        header
            .unlock(&Credential::Recovery(&vault.recovery_key))
            .err(),
        Some(VaultError::WrongCredential)
    );
    header
        .unlock(&Credential::Recovery(&new_key))
        .expect("new recovery key unlocks");
}

#[test]
fn device_slots_add_unlock_limit_and_remove() {
    let vault = create_vault(&pass(PASSPHRASE)).unwrap();
    let mut header = vault.header.clone();
    let mut secrets = Vec::new();
    for _ in 0..MAX_DEVICE_SLOTS {
        let secret = SecretKey::generate().unwrap();
        let (next, id) = vault.unlocked.add_device_slot(&header, &secret).unwrap();
        header = next;
        secrets.push((secret, id));
    }
    assert_eq!(header.device_slot_ids().len(), MAX_DEVICE_SLOTS);
    let extra = SecretKey::generate().unwrap();
    assert_eq!(
        vault.unlocked.add_device_slot(&header, &extra).err(),
        Some(VaultError::SlotLimit)
    );

    let header = VaultHeader::decode(&header.encode()).unwrap();
    for (secret, _) in &secrets {
        header
            .unlock(&Credential::Device(secret))
            .expect("each device secret unlocks");
    }
    assert_eq!(
        header.unlock(&Credential::Device(&extra)).err(),
        Some(VaultError::WrongCredential)
    );

    let (removed_secret, removed_id) = &secrets[1];
    let header = vault
        .unlocked
        .remove_device_slot(&header, removed_id)
        .unwrap();
    assert_eq!(
        header.unlock(&Credential::Device(removed_secret)).err(),
        Some(VaultError::WrongCredential)
    );
    header
        .unlock(&Credential::Device(&secrets[0].0))
        .expect("other device slots survive");
    assert_eq!(
        vault.unlocked.remove_device_slot(&header, removed_id).err(),
        Some(VaultError::NoSuchSlot)
    );
}

#[test]
fn header_operations_refuse_a_header_that_does_not_verify() {
    // If a tampered header were accepted here, re-signing would launder the tampering.
    let vault = create_vault(&pass(PASSPHRASE)).unwrap();
    let mut bytes = vault.header.encode();
    bytes[PREFIX_LEN + SLOT_LEN + 40] ^= 0x80; // inside the recovery slot's salt
    let tampered = VaultHeader::decode(&bytes).unwrap();
    let tampered_err = Some(VaultError::HeaderTampered);
    assert_eq!(
        vault
            .unlocked
            .change_passphrase(&tampered, &pass("another passphrase"))
            .err(),
        tampered_err
    );
    assert_eq!(
        vault.unlocked.rotate_recovery_key(&tampered).err(),
        tampered_err
    );
    let secret = SecretKey::generate().unwrap();
    assert_eq!(
        vault.unlocked.add_device_slot(&tampered, &secret).err(),
        tampered_err
    );
}

#[test]
fn secrets_and_errors_never_print_key_material() {
    let secret = SecretKey::from_bytes([0xAB; 32]);
    let rendered = format!(
        "{:?} {:?} {:?} {:?} {:?}",
        secret,
        pass("hunter2-hunter2"),
        VAULT.unlocked,
        VAULT.recovery_key,
        VAULT.header
    );
    assert!(!rendered.contains("hunter2"));
    assert!(!rendered.to_lowercase().contains("abab"));
    assert!(!rendered.contains("171, 171"));
    for err in [
        VaultError::WrongCredential,
        VaultError::HeaderTampered,
        VaultError::RecordAuthentication,
    ] {
        let text = format!("{err} {err:?}");
        assert!(!text.contains(PASSPHRASE));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Arbitrary bytes never panic the parser and never produce a header that the real
    /// credentials unlock.
    #[test]
    fn decoding_arbitrary_bytes_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..1200)) {
        if let Ok(header) = VaultHeader::decode(&bytes) {
            prop_assert!(header.unlock(&Credential::Recovery(&VAULT.recovery_key)).is_err());
        }
    }

    /// Splicing random bytes into a valid header never yields an unlockable header.
    #[test]
    fn splicing_into_a_valid_header_never_unlocks(
        offset in 0usize..309,
        patch in proptest::collection::vec(any::<u8>(), 1..24),
    ) {
        let good = VAULT.header.encode();
        let mut bad = good.clone();
        for (i, b) in patch.iter().enumerate() {
            if let Some(slot) = bad.get_mut(offset + i) { *slot = *b; }
        }
        prop_assume!(bad != good);
        let outcome = VaultHeader::decode(&bad).and_then(|h| h.unlock(&Credential::Recovery(&VAULT.recovery_key)));
        prop_assert!(outcome.is_err());
    }

    #[test]
    fn records_round_trip_and_do_not_open_under_any_other_context(
        payload in proptest::collection::vec(any::<u8>(), 0..2048),
        record_id in any::<[u8; 16]>(),
        kind in any::<u16>(),
        revision in 1u64..,
        other_id in any::<[u8; 16]>(),
        other_kind in any::<u16>(),
        other_revision in 1u64..,
    ) {
        let ctx = RecordContext { record_id, kind, revision };
        let sealed = VAULT.unlocked.seal(&ctx, &payload).unwrap();
        let opened = VAULT.unlocked.open(&ctx, &sealed).unwrap();
        prop_assert_eq!(&*opened, &payload);

        let other = RecordContext { record_id: other_id, kind: other_kind, revision: other_revision };
        prop_assume!(other != ctx);
        prop_assert_eq!(VAULT.unlocked.open(&other, &sealed).err(), Some(VaultError::RecordAuthentication));
    }
}

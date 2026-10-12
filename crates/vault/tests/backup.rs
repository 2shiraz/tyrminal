//! Portable backup format (docs/crypto-format.md §10): round trip and the ways a backup file can be
//! damaged or forged. Negative cases must fail closed with a specific error and never panic.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tyrminal_vault::{
    BACKUP_MAGIC, BackupRecord, Credential, Passphrase, RecordContext, VaultError, create_vault, decode_backup,
    random_id,
};

const PASSPHRASE: &str = "backup fixture passphrase";

struct Fixture {
    vault: tyrminal_vault::NewVault,
    records: Vec<BackupRecord>,
}

fn fixture(count: usize) -> Fixture {
    let vault = create_vault(&Passphrase::new(PASSPHRASE.into())).unwrap();
    let records = (0..count)
        .map(|i| {
            let ctx =
                RecordContext { record_id: random_id().unwrap(), kind: (i % 3 + 1) as u16, revision: i as u64 + 1 };
            let sealed = vault.unlocked.seal(&ctx, format!("payload {i}").as_bytes()).unwrap();
            BackupRecord { record_id: ctx.record_id, kind: ctx.kind, revision: ctx.revision, sealed }
        })
        .collect();
    Fixture { vault, records }
}

fn encode(f: &Fixture) -> Vec<u8> {
    f.vault.unlocked.encode_backup(&f.vault.header, 1_760_000_000, &f.records).unwrap()
}

/// Parse, unlock with the backup's own header, authenticate.
fn restore(bytes: &[u8], passphrase: &str) -> Result<Vec<Vec<u8>>, VaultError> {
    let parsed = decode_backup(bytes)?;
    let pass = Passphrase::new(passphrase.into());
    let unlocked = parsed.header.unlock(&Credential::Passphrase(&pass))?;
    unlocked.verify_backup(&parsed)?;
    parsed
        .records
        .iter()
        .map(|r| {
            let ctx = RecordContext { record_id: r.record_id, kind: r.kind, revision: r.revision };
            unlocked.open(&ctx, &r.sealed).map(|p| p.to_vec())
        })
        .collect()
}

#[test]
fn round_trip_with_passphrase_and_recovery_key() {
    let f = fixture(5);
    let bytes = encode(&f);
    assert_eq!(&bytes[..8], BACKUP_MAGIC);
    let mut payloads = restore(&bytes, PASSPHRASE).unwrap();
    payloads.sort();
    assert_eq!(payloads, (0..5).map(|i| format!("payload {i}").into_bytes()).collect::<Vec<_>>());

    let parsed = decode_backup(&bytes).unwrap();
    assert_eq!(parsed.created_at, 1_760_000_000);
    assert!(parsed.records.windows(2).all(|w| w[0].record_id < w[1].record_id), "sorted by id");
    let unlocked = parsed.header.unlock(&Credential::Recovery(&f.vault.recovery_key)).unwrap();
    unlocked.verify_backup(&parsed).unwrap();
}

#[test]
fn an_empty_vault_backs_up() {
    let f = fixture(0);
    assert_eq!(restore(&encode(&f), PASSPHRASE).unwrap().len(), 0);
}

#[test]
fn wrong_passphrase_is_wrong_credential() {
    let f = fixture(2);
    assert_eq!(restore(&encode(&f), "not the passphrase").unwrap_err(), VaultError::WrongCredential);
}

#[test]
fn every_single_byte_change_is_rejected() {
    let f = fixture(2);
    let bytes = encode(&f);
    // The keys are unlocked once; a changed header is caught by its MAC (which covers every
    // header byte) exactly as it would be after unlocking from the changed copy.
    let check = |copy: &[u8]| -> Result<(), VaultError> {
        let parsed = decode_backup(copy)?;
        f.vault.unlocked.verify_backup(&parsed)?;
        for r in &parsed.records {
            let ctx = RecordContext { record_id: r.record_id, kind: r.kind, revision: r.revision };
            f.vault.unlocked.open(&ctx, &r.sealed)?;
        }
        Ok(())
    };
    check(&bytes).unwrap();
    for at in 0..bytes.len() {
        let mut copy = bytes.clone();
        copy[at] ^= 0x01;
        assert!(check(&copy).is_err(), "flipping byte {at} of {} was accepted", bytes.len());
    }
}

#[test]
fn truncation_and_trailing_bytes_are_rejected() {
    let f = fixture(3);
    let bytes = encode(&f);
    for len in [0, 7, 8, 30, bytes.len() / 2, bytes.len() - 33, bytes.len() - 1] {
        assert!(decode_backup(&bytes[..len]).is_err(), "truncated to {len}");
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert_eq!(decode_backup(&longer).unwrap_err(), VaultError::MalformedBackup);
}

#[test]
fn a_dropped_or_added_record_fails_the_backup_mac() {
    let f = fixture(3);
    let mut fewer = Fixture { vault: f.vault, records: f.records.clone() };
    let full = encode(&fewer);
    // Rebuild the file without its last record but with the original MAC: authentication fails.
    let parsed = decode_backup(&full).unwrap();
    let last = parsed.records.last().unwrap().clone();
    fewer.records.retain(|r| r.record_id != last.record_id);
    let shorter = encode(&fewer);
    let mut forged = shorter[..shorter.len() - 32].to_vec();
    forged.extend_from_slice(&full[full.len() - 32..]);
    assert_eq!(restore(&forged, PASSPHRASE).unwrap_err(), VaultError::BackupTampered);
}

#[test]
fn another_vaults_backup_key_cannot_sign_this_header() {
    // A backup made by vault B, with vault A's header spliced in, fails: A's keys check B's MAC.
    let a = fixture(1);
    let b = fixture(1);
    let from_b = encode(&b);
    let header_a = a.vault.header.encode();
    let header_b = b.vault.header.encode();
    let at = 8 + 2 + 8 + 4;
    assert_eq!(&from_b[at..at + header_b.len()], &header_b[..]);
    let mut spliced = from_b.clone();
    spliced[at..at + header_a.len()].copy_from_slice(&header_a);
    let parsed = decode_backup(&spliced).unwrap();
    let unlocked = parsed.header.unlock(&Credential::Passphrase(&Passphrase::new(PASSPHRASE.into()))).unwrap();
    assert_eq!(unlocked.verify_backup(&parsed).unwrap_err(), VaultError::BackupTampered);
}

#[test]
fn duplicate_or_unsorted_records_are_malformed() {
    let f = fixture(2);
    let bytes = encode(&f);
    let parsed = decode_backup(&bytes).unwrap();
    let header_len = f.vault.header.encode().len();
    let first = 8 + 2 + 8 + 4 + header_len + 4;
    let record_len = |r: &BackupRecord| 16 + 2 + 8 + 4 + 24 + 4 + r.sealed.ciphertext.len();
    let one = &bytes[first..first + record_len(&parsed.records[0])];
    let two = &bytes[first + one.len()..first + one.len() + record_len(&parsed.records[1])];
    let mac = &bytes[bytes.len() - 32..];
    let rebuild = |a: &[u8], b: &[u8]| {
        let mut out = bytes[..first].to_vec();
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out.extend_from_slice(mac);
        out
    };
    assert_eq!(decode_backup(&rebuild(two, one)).unwrap_err(), VaultError::MalformedBackup);
    assert_eq!(decode_backup(&rebuild(one, one)).unwrap_err(), VaultError::MalformedBackup);
}

#[test]
fn hostile_counts_and_lengths_fail_before_allocating() {
    let f = fixture(1);
    let bytes = encode(&f);
    let header_len = f.vault.header.encode().len();
    let count_at = 8 + 2 + 8 + 4 + header_len;
    let mut huge_count = bytes.clone();
    huge_count[count_at..count_at + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(decode_backup(&huge_count).unwrap_err(), VaultError::MalformedBackup);
    let mut huge_header = bytes.clone();
    huge_header[18..22].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(decode_backup(&huge_header).unwrap_err(), VaultError::MalformedBackup);
    let len_at = count_at + 4 + 16 + 2 + 8 + 4 + 24;
    let mut huge_record = bytes.clone();
    huge_record[len_at..len_at + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(decode_backup(&huge_record).unwrap_err(), VaultError::MalformedBackup);
}

#[test]
fn a_newer_backup_version_is_refused() {
    let f = fixture(1);
    let mut bytes = encode(&f);
    bytes[8..10].copy_from_slice(&2u16.to_be_bytes());
    assert_eq!(decode_backup(&bytes).unwrap_err(), VaultError::UnsupportedBackupVersion);
}

#[test]
fn records_from_another_key_generation_are_not_written() {
    let mut f = fixture(1);
    f.records[0].sealed.key_version += 1;
    assert_eq!(
        f.vault.unlocked.encode_backup(&f.vault.header, 0, &f.records).unwrap_err(),
        VaultError::KeyVersionMismatch
    );
}

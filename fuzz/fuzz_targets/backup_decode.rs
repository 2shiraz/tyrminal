//! A backup file is chosen by the user and may come from anywhere: it is parsed before anything
//! is authenticated. Malformed or hostile input must be rejected without panicking or allocating
//! by an attacker-controlled count; whatever decodes keeps its records strictly ordered.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tyrminal_vault::decode_backup;

fuzz_target!(|data: &[u8]| {
    if let Ok(backup) = decode_backup(data) {
        assert!(backup.records.windows(2).all(|w| w[0].record_id < w[1].record_id));
        assert!(backup.records.iter().all(|r| r.revision >= 1));
    }
});

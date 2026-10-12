//! The vault header is read from disk before anything is authenticated: a malicious or corrupted
//! file must be rejected without panicking, unbounded allocation or KDF work. Whatever decodes
//! must re-encode to exactly the same bytes (the format is canonical).
#![no_main]

use libfuzzer_sys::fuzz_target;
use tyrminal_vault::VaultHeader;

fuzz_target!(|data: &[u8]| {
    if let Ok(header) = VaultHeader::decode(data) {
        assert_eq!(header.encode(), data, "header encoding is not canonical");
    }
});

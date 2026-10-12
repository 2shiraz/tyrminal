//! Recovery keys are typed or pasted by the user; parsing must never panic on arbitrary text.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tyrminal_vault::RecoveryKey;

fuzz_target!(|data: &[u8]| {
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = RecoveryKey::parse(text);
    }
});

//! Central application limits (BUILD_SPEC §6.2 and §13). These are initial defaults to benchmark,
//! not protocol maxima. Changing one needs a measured workload and an abuse test.

/// Display labels (host names, key names), in bytes.
pub const MAX_LABEL_LEN: usize = 256;
/// DNS host name or IP literal, in bytes.
pub const MAX_ADDRESS_LEN: usize = 253;
/// SSH user name, in bytes.
pub const MAX_USERNAME_LEN: usize = 255;
/// A typed or stored password/passphrase, in bytes.
pub const MAX_SECRET_LEN: usize = 1024;
/// Imported private key text.
pub const MAX_KEY_TEXT_LEN: usize = 1024 * 1024;
/// Free-text reason recorded when host trust is removed.
pub const MAX_REASON_LEN: usize = 500;

/// One terminal input message from the renderer.
pub const MAX_TERMINAL_INPUT_CHUNK: usize = 64 * 1024;
/// Output bytes coalesced into one message to the renderer.
pub const TERMINAL_OUTPUT_BATCH: usize = 64 * 1024;
/// Output sent to the renderer but not yet acknowledged before the core stops reading from the
/// transport. This is the per-session queued-output ceiling.
pub const MAX_UNACKED_OUTPUT: usize = 1024 * 1024;
/// Terminal dimensions accepted from the renderer.
pub const MAX_TERMINAL_DIMENSION: u16 = 1000;

/// Concurrent sessions (SSH and local together).
pub const MAX_SESSIONS: usize = 32;
/// Sessions that may be in the connect/authenticate phase at once.
pub const MAX_CONCURRENT_CONNECTS: usize = 4;
/// Records of each kind in one vault.
pub const MAX_RECORDS_PER_KIND: usize = 10_000;

/// How long a host-trust prompt waits for the user before the connection is abandoned.
pub const TRUST_PROMPT_TIMEOUT_SECS: u64 = 120;
/// How long a password/passphrase prompt waits.
pub const AUTH_PROMPT_TIMEOUT_SECS: u64 = 120;
/// Interactive authentication attempts per connection.
pub const MAX_AUTH_ATTEMPTS: u32 = 3;

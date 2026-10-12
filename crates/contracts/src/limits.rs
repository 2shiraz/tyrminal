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

/// Snippet command text, in bytes.
pub const MAX_SNIPPET_LEN: usize = 64 * 1024;
/// Snippet folder path, in bytes.
pub const MAX_FOLDER_LEN: usize = 256;
/// A URL the user asked to open from terminal output, in bytes.
pub const MAX_LINK_LEN: usize = 2048;
/// Terminal scrollback lines a user may configure.
pub const MAX_SCROLLBACK_LINES: u32 = 100_000;
/// Hosts kept in the recent-connections list on the home view.
pub const MAX_RECENT_HOSTS: usize = 12;

/// Group nesting depth (a group and its ancestors).
pub const MAX_GROUP_DEPTH: usize = 16;
/// Tags on one host, and the length of one tag in bytes.
pub const MAX_TAGS_PER_HOST: usize = 16;
pub const MAX_TAG_LEN: usize = 32;
/// Hosts changed by one bulk action.
pub const MAX_BULK_HOSTS: usize = 10_000;
/// An import source (OpenSSH config or CSV), in bytes, and one line of it.
pub const MAX_IMPORT_LEN: usize = 1024 * 1024;
pub const MAX_IMPORT_LINE_LEN: usize = 4096;
/// Hosts created by one import.
pub const MAX_IMPORT_HOSTS: usize = 10_000;
/// Search query, in bytes.
pub const MAX_SEARCH_LEN: usize = 256;

/// A remote path, and one name in it, in bytes.
pub const MAX_REMOTE_PATH_LEN: usize = 4096;
pub const MAX_FILE_NAME_LEN: usize = 255;
/// Entries returned for one remote folder; the listing says when there were more.
pub const MAX_DIR_ENTRIES: usize = 20_000;
/// File transfers running at once.
pub const MAX_TRANSFERS: usize = 8;
/// Entries (files and folders) and nesting depth of one folder transfer.
pub const MAX_TREE_ENTRIES: usize = 100_000;
pub const MAX_TREE_DEPTH: usize = 32;

// agent B: tunnels and history
/// Simultaneous connections through one forward; further ones are refused and counted.
pub const MAX_TUNNEL_CONNECTIONS: u32 = 64;
/// Forwards running at once across all sessions.
pub const MAX_ACTIVE_TUNNELS: usize = 32;
/// Ended forwards kept in the active list so their outcome stays visible.
pub const MAX_ENDED_TUNNELS: usize = 32;
/// Hosts in one connection chain, the destination included.
pub const MAX_CHAIN_HOPS: usize = 8;
// agent C: workspaces
/// Panes in one layout template (the same limit as open panes).
pub const MAX_LAYOUT_PANES: usize = 16;
/// A custom tab name in a layout template, in characters.
pub const MAX_TAB_TITLE_LEN: usize = 80;
// terminal input: highlight patterns
/// Highlight rules that are regular expressions (of `MAX_HIGHLIGHT_KEYWORDS` rules in all).
pub const MAX_HIGHLIGHT_PATTERNS: usize = 8;
/// A highlight pattern's length, in characters.
pub const MAX_HIGHLIGHT_PATTERN_LEN: usize = 128;
/// Unbounded repetitions (`*`, `+`, `{n,}`) in one highlight pattern.
pub const MAX_PATTERN_UNBOUNDED: usize = 3;
/// The largest count in a bounded repetition (`{n,m}`) of a highlight pattern.
pub const MAX_PATTERN_REPEAT: u32 = 256;

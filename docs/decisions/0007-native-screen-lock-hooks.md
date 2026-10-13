# ADR 0007: Native screen-lock hooks in one isolated crate

Status: accepted (agent A), 2026-10-12

## Context

Spec Phase 02 requires the vault to lock when the operating system locks the screen
(matrix row P-10). Every crate forbids `unsafe` (CONTRIBUTING.md: unless an ADR
isolates platform FFI). Linux exposes screen locks as D-Bus signals, reachable from safe Rust
through `zbus` (already in the tree via the Secret Service store). macOS and Windows only expose
them through native APIs, which need `unsafe` calls.

## Decision

- Linux: `crates/platform/src/screen_lock.rs` listens, in safe Rust, for `ActiveChanged(true)` from
  `org.freedesktop.ScreenSaver` and `org.gnome.ScreenSaver` on the session bus and for `Lock` from
  `org.freedesktop.login1.Session` on the system bus.
- macOS and Windows: a new crate, `crates/os-hooks` (`tyrminal-os-hooks`), is the **only** crate whose
  lints deny instead of forbid `unsafe`. It contains exactly two modules that allow it:
  - macOS: `NSDistributedNotificationCenter` observer for `com.apple.screenIsLocked`
    (`objc2-foundation` 0.3.2 and `block2` 0.6.2, both already in the tree through Tauri; MIT/Apache-2.0
    or Zlib).
  - Windows: a message-only window registered with `WTSRegisterSessionNotification`; the window
    procedure reacts to `WM_WTSSESSION_CHANGE` with `WTS_SESSION_LOCK` (`windows-sys` 0.61.2, already in
    the tree; MIT/Apache-2.0).
- Every `unsafe` block carries a `SAFETY:` comment (`clippy::undocumented_unsafe_blocks` is denied in
  that crate). `scripts/check-release.mjs` fails if any other crate relaxes the workspace lint.
- The callback can only lock the vault. A forged or spurious signal (any process on the same session
  bus can emit one on Linux) costs the user an unlock; it can never unlock or delay a lock.

## Consequences

- No new third-party crates; three existing ones gain a direct dependency edge.
- Verification: the Linux path has a test that emits the signals on a private session bus. The macOS
  and Windows paths compile and lint in CI on their platforms, but CI runners cannot lock their
  screens, so their behaviour stays IMPLEMENTED_UNVERIFIED until checked on a real desktop.

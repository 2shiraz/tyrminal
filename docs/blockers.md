# Blockers

Concrete external blockers. Each lists the evidence, what it blocks, and what still proceeds.
A blocked check is never counted as passing.

| ID | Blocker | Evidence (2026-10-12) | Blocks | Unblocked work |
|---|---|---|---|---|
| B-01 | No Windows machine or runner | `pnpm doctor`: `native Windows app BLOCKED` (host is darwin/arm64) | Every Windows gate: WebView2 validation, ConPTY, Windows ACLs, Credential Manager, installer, native E2E. No Windows support may be claimed. | All core code is written portable; Windows-specific adapters are implemented but stay IMPLEMENTED_UNVERIFIED |
| B-02 | Full Xcode not installed | `xcodebuild -version` → "requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance" | iOS/iPadOS builds, simulators, Secure Enclave tests (Phase 14) | macOS desktop builds need only the Command Line Tools |
| B-03 | No Android SDK/NDK | `ANDROID_HOME`/`ANDROID_SDK_ROOT` unset, `adb` missing | Android builds and device tests (Phase 14) | — |
| B-04 | No production signing identity or notarization credentials | None provided; spec forbids inventing them | Signed/notarized release artifacts, updater trust root (Phase 09/15) | Unsigned local packaging |
| B-05 | No independent security reviewer | Requires a human third party | Public stable release of vault crypto, sync authorization, live sharing | Implementation, self-tests and the review packet |
| B-06 | cargo-deny / cargo-fuzz not installed | `pnpm doctor` | Advisory/license scan and fuzz gates | Install is a routine permitted step; scheduled for the Phase 02 security pass |
| B-07 | No hardware security keys, serial adapters or Intel Mac | Not present on this machine | FIDO2 (KEY-08..10), serial hardware (CON-06/07), Intel macOS | Software-key paths |

Resolved blockers are moved to the phase report that resolved them rather than deleted silently.

# Blockers

Concrete external blockers. Each lists the evidence, what it blocks, and what still proceeds.
A blocked check is never counted as passing.

| ID | Blocker | Evidence (2026-10-12) | Blocks | Unblocked work |
|---|---|---|---|---|
| B-01 | No local Windows machine (partly resolved: GitHub `windows-2025` runner in CI) | 2026-10-12: Windows CI runs verify:fast green; lab and native suites in progress | Windows claims rest on CI evidence only | Windows gates run in `native.yml` |
| B-02 | Full Xcode not installed | `xcodebuild -version` → "requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance" | iOS/iPadOS builds, simulators, Secure Enclave tests (Phase 14) | macOS desktop builds need only the Command Line Tools |
| B-03 | No Android SDK/NDK | `ANDROID_HOME`/`ANDROID_SDK_ROOT` unset, `adb` missing | Android builds and device tests (Phase 14) | — |
| B-04 | No production signing identity or notarization credentials | None provided; spec forbids inventing them | Signed/notarized release artifacts, updater trust root (Phase 09/15) | Unsigned local packaging |
| B-05 | No independent security reviewer | Requires a human third party | Public stable release of vault crypto, sync authorization, live sharing | Implementation, self-tests and the review packet |
| B-06 | ~~cargo-deny / cargo-fuzz not installed~~ resolved 2026-10-12 | Installed in CI (`security.yml`, ADR 0003) | — | — |
| B-08 | Windows lab server limits | Win32-OpenSSH + Git Bash has no tmux, htop, mc or PAM | Native TUI tests and keyboard-interactive on Windows report BLOCKED | Same client tests pass against Linux/macOS servers; WSL1 lab is a possible remedy |
| B-09 | No IPv6 loopback in the Linux development sandbox | `ipv6_loopback_endpoint…` fails only there | IPv6 lab test in that sandbox | Runs in CI |
| B-07 | No hardware security keys, serial adapters or Intel Mac | Not present on this machine | FIDO2 (KEY-08..10), serial hardware (CON-06/07), Intel macOS | Software-key paths |
| B-10 | No container engine for the lab user in the CI labs | The lab images and the WSL/macOS labs have neither Docker nor Podman for the lab user; `containers_lab` reports BLOCKED without `TYRMINAL_LAB_CONTAINERS=1` | P-33 real-engine test (shells in a running container, nothing left after close or lock) on CI | Passes in the Linux sandbox with Docker usable by the lab user; listing, ID refusal and the PTY channel run in `inventory_lab` everywhere |

Resolved blockers are moved to the phase report that resolved them rather than deleted silently.

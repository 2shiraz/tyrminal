# Phase 01 — Technical feasibility spikes

Date: 2026-10-12 · Host: macOS 27.0.1, Apple M5, 10 cores, 24 GiB, WKWebView (AppleWebKit 605.1.15)
Verdict: **gate met on macOS; open for Windows and mobile** (B-01, B-02, B-03)

The spikes were built as the first version of the real crates rather than as throwaway code.
Exact versions, licenses and limitations: `docs/decisions/0002-stack-versions-and-limitations.md`.

## Spikes

| Spike | Result | Evidence |
|---|---|---|
| Real Tauri window | Works; 24 commands behind an explicit manifest and one capability | native suite |
| One xterm terminal | Works; lazy-loaded chunk | native suite, screenshot `07-terminal` |
| Rust → renderer binary stream | Raw-byte channel per session, acknowledged after xterm parses | `unacknowledged_output_is_capped_then_resumes_without_loss` |
| SSH session to disposable OpenSSH | Works through russh 0.64.1 | 17 lab tests |
| Local PTY | Works on macOS; ConPTY untested | 9 PTY tests |
| OS secret store | macOS Keychain round trip works; nothing left behind | `os_secret_store_round_trips` |
| SQLite encrypted records | Works; no plaintext in DB or WAL | `no_plaintext_canary_reaches_any_file_on_disk` |
| Mobile compilation | **Not attempted** | B-02, B-03 |

## Required tests

| Test | Result |
|---|---|
| Host-key mismatch rejection | Pass (adapter, core and native app) |
| Password and Ed25519 authentication | Pass; also RSA 3072, ECDSA P-256, passphrase-protected Ed25519 |
| Terminal resize | Pass over SSH and locally |
| Large-output backpressure | Pass: 3,000,000 lines through a stalled consumer, in order; 1 MiB unacknowledged ceiling holds |
| Native file dialog | **Not done**: no dialog plugin is integrated yet (needed for key file import, Phase 04) |
| Lock cleanup | Pass: sessions closed, handles dead, nothing decrypted on screen |
| Production build with test hooks absent | Pass: `scripts/check-release.mjs --require-binary` on the 11.0 MiB release binary |
| macOS native test tooling on pinned versions | Pass: embedded WebDriver plugin 1.4.0 with Tauri 2.12.1; 25 consecutive runs |

## Measurements

Binary: release profile with the `e2e` feature (needed to observe the UI), so launch figures
include starting the automation server and are upper bounds for the shipping binary. Raw samples:
`docs/reports/raw/performance.json` (git-ignored; regenerate with
`node scripts/build-e2e.mjs --release && node tests/performance/measure.mjs`).

| Metric | Target | Measured | Status |
|---|---|---|---|
| Warm launch to locked screen | p95 ≤ 1 s | median 317 ms, p95 367 ms (n = 20) | Met |
| Cold launch | p95 ≤ 2 s | **Not measured**: the file cache cannot be flushed without elevated rights. First launch of a fresh binary took 1,090 ms in one run and 300 ms in another. | Open |
| Idle CPU, unlocked home, 60 s | mean < 1% of a core | mean 0.5% and 0.9% in two runs; p95 4.9–6.4% | Met, with little margin |
| Idle process-tree memory | ≤ 200 MiB | median 212 MiB and 278 MiB in two runs, summed RSS over 4 processes (app + 3 WebKit helpers) | **Missed** |
| Unlock (Argon2id + load) through the UI | 250–750 ms | median 113 ms (n = 5) | **Below the range** |
| Terminal stream | sustain 5 MiB/s for 60 s | 75.8 MiB/s over 640 MB; the workload finished in 8.05 s | Rate exceeded; 60 s duration not exercised |
| Frontend initial JS | ≤ 500 KiB compressed | 80.4 KiB gzip; terminal chunk 86.5 KiB, loaded on first session | Met |
| Desktop distributable | ≤ 40 MiB compressed | 11 MiB uncompressed `.app` | Met |

Notes on the misses:

- **Idle memory.** Summed RSS double-counts pages shared between the WebKit helper processes, so
  the true figure is lower, but this methodology shows 212–278 MiB against a 200 MiB target. No
  profile has been taken yet. The target is kept; the next step is a per-process footprint
  breakdown (`footprint`/`vmmap`) before deciding whether the budget or the app needs to change.
- **Unlock time.** The 64 MiB / 3-iteration Argon2id profile takes about 0.1 s on this CPU, below
  the 250–750 ms aim. The security floor from the spec is unchanged. A stronger allowlisted profile
  needs benchmarks on the baseline hardware, including the Windows machine that does not exist yet,
  so no change was made.
- **Stream memory.** Process-tree RSS rose from 298 MiB to 482 MiB during the 640 MB flood. It is
  bounded (far below the data volume) but whether it is released afterwards was not measured.

Not measured: input-to-echo latency, frame delivery, ten idle terminals, SFTP, cancellation
latency, host search at 10,000 records, soak/leak.

## Findings

Recorded in ADR 0002 ("Limitations found") and `docs/progress.md` ("Findings worth keeping").
The ones that changed code: russh's dropped-link-as-auth-failure, macOS discarding unread PTY
output on last slave close, readline overwriting a resize, OpenSSH per-source penalties in the
lab, and xterm.js being incompatible with a frozen `Object.prototype`.

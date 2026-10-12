# 0002 — Stack versions and limitations found in the feasibility spikes

Status: accepted · Date: 2026-10-12 · Evidence: `docs/reports/phase-01.md`

Exact versions are in `Cargo.lock` and `pnpm-lock.yaml`, which are committed. This record explains
the choices and what the spikes found. Everything below was exercised on macOS 27.0.1 (Apple M5)
only; nothing has been built or run on Windows (blocker B-01).

## Pinned components

| Layer | Component | Version | License | Notes |
|---|---|---|---|---|
| Toolchain | Rust | 1.98.1 | MIT/Apache-2.0 | `rust-toolchain.toml`; edition 2024 |
| Shell | `tauri` / `tauri-build` / `@tauri-apps/cli` / `@tauri-apps/api` | 2.12.1 / 2.7.1 / 2.12.1 / 2.12.1 | MIT/Apache-2.0 | Exact pins. 2.12.3 existed (2 days old); its notes list bug fixes, not security fixes. Re-evaluate before a release candidate. |
| SSH | `russh` | 0.64.1 | Apache-2.0 | Default `aws-lc-rs` crypto backend. Behind `tyrminal-ssh`. |
| Local PTY | `portable-pty` | 0.9.0 | MIT | Behind `tyrminal-pty`. |
| Storage | `rusqlite` (bundled SQLite 3.53.2) | 0.40.2 | MIT | One connection on a dedicated worker thread. |
| AEAD | `chacha20poly1305` | 0.11.0 | MIT/Apache-2.0 | XChaCha20-Poly1305 |
| KDF | `argon2`, `hkdf`, `sha2`, `hmac` | 0.6.0, 0.13.0, 0.11.0, 0.13.0 | MIT/Apache-2.0 | |
| OS secrets | `keyring-core` + `apple-native-keyring-store` / `windows-native-keyring-store` | 1.0.0 + 1.0.2 / 1.1.0 | MIT/Apache-2.0 | The stores are used directly, as the `keyring` 4 documentation recommends for applications. |
| Contracts | `ts-rs` | 12.0.1 | MIT | Rust → TypeScript types |
| UI | React, Vite, TypeScript | 19.3.0, 8.3.3, 7.0.2 | MIT, MIT, Apache-2.0 | 30 npm packages in total |
| Terminal | `@xterm/xterm`, `@xterm/addon-fit` | 6.0.0, 0.11.0 | MIT | No WebGL, clipboard or web-links addon is loaded. |
| Native E2E | `tauri-plugin-wdio-webdriver` | 1.5.0 | MIT | Optional, non-default `e2e` feature only. 1.4.0 did not compile on Windows against Tauri 2.12 (webview2-com 0.38 vs 0.39); 1.5.0 matches |

## Supply-chain policy

- npm: `minimumReleaseAge` of 7 days in `pnpm-workspace.yaml`; no dependency may run install
  scripts (`onlyBuiltDependencies: []`). One exception: Vite 8.3.3 (6 days old at the time) for
  its dev-server `fs.serve` check.
- Cargo has no equivalent setting. Direct security-relevant dependencies are pinned and were
  chosen to be at least a week old where a choice existed; transitive crates resolve to whatever
  was current when `Cargo.lock` was written. `cargo-deny` (advisories, licenses, sources) is not
  installed yet (blocker B-06), so **no advisory or license scan has been run**.

## SSH algorithm offer

Written out explicitly in `crates/ssh/src/algorithms.rs` and asserted by a unit test, so a library
upgrade cannot silently widen it:

- Key exchange: `mlkem768x25519-sha256`, `curve25519-sha256`, `curve25519-sha256@libssh.org`,
  `diffie-hellman-group-exchange-sha256`, `diffie-hellman-group16-sha512`,
  `diffie-hellman-group14-sha256`, plus the strict-KEX and extension-info markers.
- Host keys: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, `rsa-sha2-512`, `rsa-sha2-256`.
- Ciphers: `chacha20-poly1305@openssh.com`, `aes256-gcm@openssh.com`, `aes256/192/128-ctr`.
- MACs: `hmac-sha2-512/256-etm@openssh.com`, `hmac-sha2-512/256`.
- Compression: none.

Not offered: SHA-1 `ssh-rsa` host keys or signatures, DSA, CBC ciphers, 3DES, arcfour, group1,
SHA-1/MD5 MACs. There is no legacy fallback and no retry path that widens the offer. Which
algorithm a given server actually negotiated is not surfaced yet. The hybrid post-quantum key
exchange is offered because the library implements it; it has only been exercised against
OpenSSH 10.0p1.

## Limitations found

1. **russh reports a link that drops while waiting for an authentication reply as an
   authentication failure** with an empty method list. The adapter maps this to a disconnect.
2. **russh copies passwords into its own `String`**, which is not zeroized. The vault's copy is.
3. **Host certificates are rejected** (`CertificateUnsupported`). Validation of CA, principals,
   validity and critical options is Phase 07; until then a certificate is never accepted merely
   for being signed.
4. **No IDNA mapping** in host canonicalization: a Unicode name and its punycode form are
   distinct trust entries. This fails closed.
5. **`freezePrototype` is disabled.** xterm.js 6 assigns `toString` on a plain object while its
   module loads, which throws once `Object.prototype` is frozen. This removes one
   defense-in-depth measure against prototype pollution in the renderer. The CSP, the command
   allowlist and the no-remote-content rule are unaffected and are tested.
6. **`style-src` allows `'unsafe-inline'`.** xterm.js creates style elements at runtime, and
   Tauri's nonce injection for styles is disabled so that allowance takes effect. Scripts remain
   `'self'` only.
7. **macOS discards unread PTY output when the last slave descriptor closes.** `tyrminal-pty`
   keeps the slave open until the child has exited and the reader has drained, detecting "drained"
   as 15 ms of quiet in one read call. This is a heuristic, verified over 9,600 short-lived
   processes.
8. **GNU readline can overwrite a window resize** (non-atomic get-then-set). The session layer
   re-checks the size 150 ms after a resize and re-applies it.
9. **The embedded WebDriver server has no authentication.** The spec asks for per-run credentials
   on test automation interfaces; W3C WebDriver has none. Mitigations: loopback only, a random
   port per run, a separate bundle identifier and target directory, and release checks that fail
   if the plugin is in the default feature graph or the release binary. Any local process can
   drive a test build while it runs, so test builds must only ever hold synthetic data.
10. **Native tests use a small W3C WebDriver client** (`tests/native/webdriver.mjs`) against that
    embedded server rather than the WebdriverIO service, to avoid adding several hundred npm
    packages to the repository. The server and protocol are the ones WebdriverIO would use.
11. **Screen capture is not available** to the build agent on this machine (no Screen Recording
    permission). Screenshots are WebView snapshots taken through WebDriver; native window chrome
    is not captured.
12. **The idle lock is enforced in the core** (`VaultService::run_idle_lock`); the renderer only
    reports activity. A compromised renderer can report fake activity and keep the vault open,
    which is within the stated limits for an unlocked, compromised renderer. OS lock and suspend
    are not hooked yet.
13. **Single instance is not enforced.** Two instances on one data directory are kept consistent
    by SQLite and optimistic concurrency, but each has its own in-memory index.
14. **Mobile compilation has not been attempted** (no Xcode, no Android SDK: B-02, B-03).

## Alternatives considered

- *WebdriverIO service* for native tests: more features, far larger dependency tree. Can be added
  later on top of the same embedded server.
- *Patching xterm.js* to keep `freezePrototype`: rejected for now; a patch against a minified
  bundle is fragile.
- *`ring` instead of `aws-lc-rs`* for russh: simpler Windows builds, fewer algorithms. Revisit
  when a Windows runner exists.
- *SQLCipher*: not needed; records are encrypted before they reach SQLite and a test scans the
  database and WAL for plaintext.

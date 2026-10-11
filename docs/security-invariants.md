# Security invariants and their tests

Each invariant from BUILD_SPEC §4.2 with the tests that currently exercise it. "Covered" means
real-backend tests exist and pass on macOS; it does not mean the invariant is proven, and nothing
here has been independently reviewed. Windows has no coverage at all (blocker B-01).

Test locations: `V` = `crates/vault/tests`, `S` = `crates/storage/tests/database.rs`,
`C` = `crates/core/tests/vault_service.rs`, `L` = `crates/ssh/tests/lab.rs`,
`X` = `crates/core/tests/sessions_lab.rs`, `N` = `tests/native/app.test.mjs`,
`R` = `scripts/check-release.mjs`.

| ID | Invariant | State | Tests |
|---|---|---|---|
| INV-01 | No account/vendor request is needed for local operation | Partly covered | `N` first launch needs no account; `R` no HTTP client in the default dependency graph, no remote URL in UI sources, CSP without remote origins. **Gap:** no packet-level capture of a fresh run yet. |
| INV-02 | No credential or signing operation before host trust succeeds | Covered | Type-level: authentication exists only on `VerifiedConnection`. `L` `declining_an_unknown_host_key_sends_no_credentials` (server auth log unchanged); `X` and `N` changed-key tests with a stored password/key and the impostor's auth log unchanged. |
| INV-03 | Changed host keys fail closed; no silent replacement | Covered | `L` `changed_host_key_at_the_same_endpoint_blocks_before_credentials`; `X` `changed_host_key_is_blocked_and_trust_is_replaced_only_explicitly`; `N` changed-key and replace-trust tests. |
| INV-04 | Sensitive contents never reach SQLite pages, WAL, temp files or logs in plaintext | Covered for DB/WAL | `C` `no_plaintext_canary_reaches_any_file_on_disk` (unlocked with live WAL, locked, after shutdown); `N` restart test scans the data directory. **Gap:** diagnostic logs do not exist yet; nothing to scan. |
| INV-05 | Production builds expose no test server, debug IPC, test auth or mock secret store | Covered | `R` default feature graph and the release binary contain no WebDriver plugin or test markers; capability set is exactly `main`. |
| INV-06 | Renderer commands need window permission and resource ownership | Covered | `X` `another_window_cannot_use_or_probe_a_session`; `N` ungranted and nonexistent commands are refused by the runtime; `R` declared commands equal granted permissions. |
| INV-07 | Lock invalidates handles and stops secret-backed work; races cannot bypass it | Covered | `C` lock wins over an unlock in flight, writes racing a lock are atomic, the core locks after inactivity and re-arms; `X` `locking_the_vault_closes_sessions_and_invalidates_handles`; `N` nothing decrypted remains on screen after lock. |
| INV-08 | Remote output never becomes executable HTML/JS or an implicit local action | Partly covered | Terminal bytes go only to xterm; titles are sanitized and rendered as text; links are inert; no clipboard addon; `R` forbids `innerHTML`/`eval` in UI sources; `L` hostile TERM/dimensions are filtered. **Gap:** no malformed-escape-sequence corpus or fuzzing yet (Phase 05). |
| INV-09 | Sync and AI are opt-in; disabling stops traffic | Not applicable yet | Neither exists. `R` fails if an HTTP client or updater endpoint appears. |
| INV-10 | Sync authorization on every object | Not applicable yet | Phase 10. |
| INV-11 | Tampering or unsupported versions fail without partial application | Covered | `V` every header bit flip, slot transplant, structural attacks, property tests; `C` seven record-tampering attacks, cross-vault rows, future format version; `S` newer schema refused untouched. |
| INV-12 | Queues, parsers, files, histories and logs have enforced limits | Partly covered | `X` `unacknowledged_output_is_capped_then_resumes_without_loss`; `L` and PTY stalled-consumer tests; bounded storage queue; input-size and dimension limits. **Gap:** no reconnect-storm or import limits yet (features not built). |
| INV-13 | Untrusted strings never become local shell syntax | Covered for what exists | PTY `arguments_are_argv_not_shell_syntax`; address/username validation rejects option- and shell-like input (`validate.rs` tests). |
| INV-14 | Updates need trusted artifact verification | Not applicable yet | No updater. `R` fails if an updater endpoint is configured. |
| INV-15 | Revocation prevents future access | Not applicable yet | Phase 10–11. |
| INV-16 | Backups and migrations are atomic and recoverable | Partly covered | `S` atomic batches, header compare-and-swap, snapshot never overwrites; migrations run one transaction per version. **Gap:** no forced-termination test and no portable backup/restore yet. |
| INV-17 | Feature availability is honest | Process | `scripts/feature-matrix.mjs --check` refuses VERIFIED without tests, platforms and a commit; `scripts/verify.mjs` fails a suite on any BLOCKED step. |
| INV-18 | No secret leaks through errors, panics, traces or artifacts | Partly covered | Fixed-text error enums at every layer; redacted `Debug` for secret types (`V`, contracts tests); `C` import errors do not echo input. **Gap:** no canary sweep of panic output and test artifacts yet. |

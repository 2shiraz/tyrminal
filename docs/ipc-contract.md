# IPC contract

The React UI talks to the native side only through `apps/desktop/src/lib/ipc.ts`. That module is
the single place that calls Tauri `invoke`/`Channel`; components never import `@tauri-apps/api`
directly (`pnpm check:release` enforces it). Every request and response type is generated from
Rust (`crates/contracts`, ts-rs) by `pnpm contracts`; `pnpm contracts:check` fails when the
generated files are stale.

## Trust model

- The WebView is treated as untrusted input. The native side validates every argument
  (`crates/core/src/validate.rs`) and enforces limits (`crates/contracts/src/limits.rs`) before
  touching the vault, storage or a transport.
- One capability file (`apps/desktop/src-tauri/capabilities/main.json`) grants the `main` window
  exactly the commands below plus event listen/unlisten. No filesystem, shell, HTTP, process,
  clipboard or opener plugin is granted.
- Secrets travel UI → native only (passphrases, passwords, private keys being imported). No
  command returns a secret: key and host summaries carry flags such as `passphrase_stored`, never
  the material.
- Session output and session events flow over a `Channel` created by the invocation that opened
  the session, so only that window receives them. Nothing about a session is broadcast.
- Every session command carries the calling window's label as the owner; a session can be written
  to, resized, answered or closed only by its owner (`ACCESS_DENIED` otherwise). Snippet sends are
  authorized the same way before the snippet is read.
- Locking the vault bumps a generation counter. Sessions, prompts and pending writes from an
  older generation are refused or closed.

## Errors

Commands reject with `IpcError { code: ErrorCode, message }`. `message` is user-facing,
already-redacted text. Codes include `VAULT_LOCKED`, `ACCESS_DENIED`, `NOT_FOUND`, `CONFLICT`,
`INVALID_INPUT`, `AUTH_FAILED`, `HOST_KEY_CHANGED`, `CANCELLED`, `IO_ERROR`, `NEEDS_SIGN_IN`; see
`crates/contracts/bindings/ErrorCode.ts` for the full list.

## Commands

| Command | Request | Response | Notes |
|---|---|---|---|
| `vault_status` | — | `VaultStatus` | Also pushed as the `vault-status` event on change |
| `vault_create` | passphrase | recovery key (shown once) | Argon2id; recovery key confirmed in the UI |
| `vault_unlock` / `vault_unlock_recovery` | passphrase / recovery key | `VaultStatus` | |
| `vault_lock` | — | — | Closes every session, clears prompts |
| `vault_change_passphrase` | old, new | — | Header swap is atomic |
| `vault_rotate_recovery_key` | passphrase | new recovery key | |
| `vault_activity` | — | — | Resets the idle auto-lock timer |
| `host_list` / `host_recent` | — | `HostSummary[]` | Recent: by `last_connected_at`, at most 12 |
| `host_save` / `host_delete` | `HostInput` / id | `HostSummary` / — | Optimistic concurrency per record. Empty user name, `null` port or `inherit` auth: taken from the group chain |
| `host_search` | query (≤ 256 bytes) | `HostSummary[]` | Every term must match; `tag:x`, `group:x`; runs in the core |
| `host_duplicate` | id | `HostSummary` | Full copy including a stored password; never connected |
| `host_bulk` | ids (≤ 10,000), `BulkHostChange` | count | One transaction: every host changes or none does |
| `group_list` / `group_save` / `group_delete` | — / `GroupInput` / id | `GroupSummary[]` / `GroupSummary` / — | No cycles, depth ≤ 16, parent and key must exist; delete refused while not empty |
| `import_preview` | `ImportFormat`, text (≤ 1 MiB) | `ImportPreview` | Parses only; nothing is executed, included or written |
| `import_hosts` | `ImportHost[]`, target group or null | count | Re-validated; hosts and missing groups created in one transaction |
| `key_list` | — | `KeySummary[]` | Never includes key material |
| `key_import` / `key_generate` / `key_delete` | `KeyImportInput` / `KeyGenerateInput` / id | `KeySummary` / — | |
| `key_deploy_preview` / `key_deploy` | session id, key id | `KeyDeployPreview` | Owned, connected SSH session only; fixed remote commands, key line on stdin, append-only to `~/.ssh/authorized_keys` |
| `known_host_list` / `known_host_remove` | — / id + reason | `KnownHostSummary[]` / — | Removal requires a reason |
| `session_open_ssh` | host id, size, output channel, event channel | session id | Host-key trust and auth prompts arrive as events |
| `session_open_local` | size, optional `startIn` folder, channels | session id | Local PTY; `startIn` used only if absolute, existing and free of control characters, else home |
| `session_open_exec` | host id, `interactive`, event channel | session id | SSH hosts only, for snippet runs on hosts without an open session (SNP-05): same trust and auth prompts, then nothing but the exec channels `snippet_exec` opens (no shell, PTY or SFTP); with `interactive` false a needed sign-in answer is not asked and the session closes with `NEEDS_SIGN_IN`; `session_close` ends it |
| `session_open_files` | host id, event channel | session id | SSH hosts only: same trust and auth prompts, then the SFTP subsystem and no shell or PTY; `session_write`/`session_resize` refuse it; `files_*` commands take its id; `session_close` ends it |
| `files_local_mkdir` / `files_local_rename` / `files_local_remove` / `files_local_chmod` | grant token, names below it, name(s) / mode | — | Inside a folder the user chose natively only: single-component names, no link in any step, rename never replaces, delete removes files, links (not their targets) and empty folders only |
| `session_write` | session id, bytes | — | Chunked; at most `MAX_TERMINAL_INPUT_CHUNK` per call |
| `session_resize` / `session_ack` / `session_close` | session id, … | — | `ack` is output flow control |
| `session_trust_answer` | prompt id, `TrustDecision` | — | `once`, `always`, `cancel` |
| `session_auth_answer` | prompt id, secret or none | — | None cancels |
| `session_handoff_offer` | session id, target window label | single-use token | Owner only; one offer per session; lapses after 30 s or when the target window closes, and held output returns to the owner |
| `session_attach` | token, output and event channels | session id | Target window only; switches owner and sink atomically; the old window is denied from then on |
| `snippet_list` | — | `SnippetSummary[]` | Name, folder, text, line count |
| `snippet_save` / `snippet_delete` | `SnippetInput` / id | `SnippetSummary` / — | Text ≤ 64 KiB, no control characters except tab/newline |
| `snippet_send` | snippet id, session id, `SnippetSendMode`, bracketed | — | Text is read from the vault by the core, never from the UI |
| `prefs_get` / `prefs_set` | — / `Preferences` | `Preferences` | Non-secret; sanitized and clamped; stored next to the vault |
| `link_open` | URL | — | http/https only, re-validated natively, opened by the OS |
| `app_info` | — | `AppInfo` | Static build and platform facts (commit, build date, OS, architecture, Tauri and WebView versions); nothing about the user or the vault |
| `layout_list` / `layout_save` / `layout_delete` | — / `LayoutTemplateInput` / id | `LayoutTemplateSummary[]` / `LayoutTemplateSummary` / — | Agent C. Saved only on request. Each split tree names each pane once, ratios are 0.15–0.85, at most 16 panes, SSH targets must be saved hosts. No commands, output or secrets are stored. A restored pane connects only on Connect |
| `discovery_networks` | — | interfaces (name, addresses) | Local interface table only; sends nothing (HST-14, ADR 0009) |
| `discovery_start` | network id | discovery status | Vault unlocked; id must be a listed interface; browses `_ssh._tcp` there for 30 s |
| `discovery_status` | — | running, seconds left, found (cleaned, ≤ 64), truncated | This window's browse |
| `discovery_stop` | — | discovery status | Ends this window's browse; results stay readable |
| `security_review` | — | `SecurityReview` | Vault unlocked; read-only, on the device, no network. Findings name records (ids, labels, endpoints, fingerprints) and never carry a secret (P-27, ADR 0011) |

## Events

| Event | Payload | Delivery |
|---|---|---|
| `vault-status` | `VaultStatus` | Emitted to the `main` window only |
| Session output | raw bytes | Per-session `Channel` |
| Session events | `SessionEvent` (state, trust prompt, auth prompt, title, closed) | Per-session `Channel` |

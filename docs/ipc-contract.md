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
`INVALID_INPUT`, `AUTH_FAILED`, `HOST_KEY_CHANGED`, `CANCELLED`, `IO_ERROR`; see
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
| `session_open_local` | size, channels | session id | Local PTY |
| `session_write` | session id, bytes | — | Chunked; at most `MAX_TERMINAL_INPUT_CHUNK` per call |
| `session_resize` / `session_ack` / `session_close` | session id, … | — | `ack` is output flow control |
| `session_trust_answer` | prompt id, `TrustDecision` | — | `once`, `always`, `cancel` |
| `session_auth_answer` | prompt id, secret or none | — | None cancels |
| `snippet_list` | — | `SnippetSummary[]` | Name, folder, text, line count |
| `snippet_save` / `snippet_delete` | `SnippetInput` / id | `SnippetSummary` / — | Text ≤ 64 KiB, no control characters except tab/newline |
| `snippet_send` | snippet id, session id, `SnippetSendMode`, bracketed | — | Text is read from the vault by the core, never from the UI |
| `prefs_get` / `prefs_set` | — / `Preferences` | `Preferences` | Non-secret; sanitized and clamped; stored next to the vault |
| `link_open` | URL | — | http/https only, re-validated natively, opened by the OS |
| `layout_list` / `layout_save` / `layout_delete` | — / `LayoutTemplateInput` / id | `LayoutTemplateSummary[]` / `LayoutTemplateSummary` / — | Agent C. Saved only on request. Each split tree names each pane once, ratios are 0.15–0.85, at most 16 panes, SSH targets must be saved hosts. No commands, output or secrets are stored. A restored pane connects only on Connect |

## Events

| Event | Payload | Delivery |
|---|---|---|
| `vault-status` | `VaultStatus` | Emitted to the `main` window only |
| Session output | raw bytes | Per-session `Channel` |
| Session events | `SessionEvent` (state, trust prompt, auth prompt, title, closed) | Per-session `Channel` |

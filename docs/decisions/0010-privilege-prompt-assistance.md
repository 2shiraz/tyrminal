# ADR 0010: User-invoked identity password insertion (KEY-18) and identity deletion safety

Status: accepted, 2026-10-12

## Context

Matrix row KEY-18 asks for identity password "autofill" at sudo prompts; AUT-05 records the
changed scope: user-invoked insertion only, no spoofable prompt-based auto-submit. Spec §4.5:
"Never auto-submit stored passwords solely because terminal text resembles a sudo/password prompt.
Offer an explicit user action; banners can spoof prompts." Identities (KEY-15..17) are agent D's
model (ADR 0006): a host's own identity wins, else the nearest group's when the host inherits its
sign-in method.

## Decision

1. **Explicit and confirmed.** The command palette entry or its shortcut (Cmd/Ctrl+Shift+P)
   opens a confirmation that names the identity and the host. Cancel has focus, so Enter in the
   dialog types nothing; the password is typed only by clicking (or tabbing to) "Type password".
   Nothing in the core or the UI reads terminal output to detect prompts.
2. **Inside the core.** The renderer sends the session id and the identity id it showed. The
   core resolves the identity the session's host uses *now* (agent D's `identity_for_host`) and
   refuses with `CONFLICT` unless it is that identity, so a change in between never types a
   different identity's password. The password is read under the session's vault generation
   (nothing after a lock) and never returned to the renderer.
3. **No Enter, no control characters.** The password is written without a line ending; the user
   checks the prompt and presses Enter. A password containing control characters is refused
   (they would be keystrokes such as Enter, Ctrl-C or an escape sequence), and the error never
   contains it.
4. **Zeroizing input path.** The bytes travel to the session task in a zeroizing buffer
   (`Input::Secret`); the transport's own buffers are outside our control.

## Consequences

- No new dependency, record kind or stored field.
- The feature only covers SSH sessions to saved hosts that use an identity with a password.

## Addendum: deleting an identity that is in use (spec §10.2)

The first identity implementation (ADR 0006) cleared an identity's references when it was
deleted, so a host could fall back to its own stored password without the user choosing it.
§10.2 requires "prompts for reassignment or explicit removal, never fallback to a different
secret". Now:

- `identity_delete(id, references)` is refused with `IN_USE` while any host or group names the
  identity, unless `references` is `reassign { identityId }` (another existing identity, written
  in the same transaction) or `remove`.
- `identity_usage(id)` lists every host and group the identity applies to (directly or through
  a group) and, for each host, how it would sign in without it: another identity from a group
  further up, a key, its own stored password, or asking. The delete dialog shows this list and
  enables Delete only after the user picks reassignment or removal; Cancel has focus.

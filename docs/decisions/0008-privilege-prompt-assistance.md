# ADR 0008: User-invoked identity password insertion (KEY-18)

Status: accepted, 2026-10-12

## Context

Matrix row KEY-18 asks for identity password "autofill" at sudo prompts; AUT-05 records the
changed scope: user-invoked insertion only, no spoofable prompt-based auto-submit. BUILD_SPEC §4.5:
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

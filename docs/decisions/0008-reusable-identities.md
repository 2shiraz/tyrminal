# ADR 0008: Reusable identities and user-invoked password insertion

Status: accepted, 2026-10-12

## Context

BUILD_SPEC §10.1 lists an Identity entity ("ID, username and references to encrypted
authentication material"). Matrix rows KEY-15..17 ask for identities that hosts and groups
reference and follow, and KEY-18 (with AUT-05, scope "changed") for help with sudo-style password
prompts. §4.5 forbids auto-submitting stored passwords because terminal text that resembles a
prompt can be printed by the server. §10.2 forbids falling back to a different secret when a
referenced identity is deleted.

## Decision

1. **Record.** Identities are vault record kind 210 (`IdentityRecord`: label, optional user name,
   optional password in a zeroizing buffer, optional key id). Kinds 200..=209 stay with the
   inventory/snippets branch. The password is write-only across IPC: `IdentitySummary` says only
   whether one is stored, and saving takes `Keep`, `Clear` or `Set`.
2. **References, not copies.** Hosts store `StoredAuth::Identity { identity_id }`; groups store
   `identity_id` (mutually exclusive with the group key). Effective values are resolved when a
   summary is built or a session connects, so an edit to an identity applies to every user at
   once (KEY-16). Resolution, nearest wins:
   - user name: the host's own; else its own identity's; else for each group up the chain, the
     group's own user name, else the group identity's;
   - sign-in: the host's own method; for "inherit", the nearest group with a key or an identity;
   - an identity signs in with its key if it has one (the key's attached certificate goes with
     it), else its password, else the password is asked.
3. **No dangling references.** Saving a host, group or identity checks that every referenced id
   exists. Deleting an identity that any host or group uses is refused (`IN_USE`), and so is
   deleting a key an identity uses. Nothing falls back to another credential.
4. **Password insertion (KEY-18).** Only an explicit user action types a password: the palette
   command or its shortcut (Cmd/Ctrl+Shift+P) opens a confirmation naming the identity and host;
   the click on "Type password" sends the request. The core:
   - looks up the session's host and the identity it uses *now*, and refuses (`CONFLICT`) unless
     it is the identity the user was shown, so a concurrent edit can never send a different
     identity's password;
   - reads the password under the session's vault generation (nothing after a lock);
   - refuses a password containing control characters (they would be keystrokes such as Enter
     or Ctrl-C in a terminal), without echoing it in the error;
   - writes it to the session as a zeroizing input buffer, without Enter. The user checks the
     prompt and presses Enter.
   Nothing in the core or the UI reads terminal output to detect prompts. The password never
   reaches the renderer.

## Consequences

- No new dependency.
- A vault holding identities, or a host or group that references one, cannot be opened by an
  older build: the new record kind is refused as "from a newer version", and an older build
  reports a host with the new sign-in variant as damaged. Acceptable before the first stable
  release; a schema version bump is the follow-up if this ships after one.
- Identities are local to one vault; choosing identities "from accessible vaults" (KEY-17 wording)
  needs shared vaults, which do not exist yet.

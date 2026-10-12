# Interaction polish: fewer buttons, autosave, instant feedback

Owner request (2026-10-12): the app feels a little sluggish. Make it simpler and faster to use,
the way Termius is: no Connect button on host rows, double-click to connect, autosave wherever
possible, and motion that makes changes feel immediate.

This plan works within `docs/design/overhaul.md`, which sets the tokens and motion limits:
- motion lasts 100 to 220 ms;
- only transform and opacity animate;
- no motion under reduced motion.

AGENTS.md and BUILD_SPEC §0.1 still hold. In particular, nothing here may weaken host-key trust,
send a secret by surprise, or connect without the normal prompts.

## 1. Speed you can feel (perceived performance)

Target: every click, key press or drag changes the screen within 100 ms. Slow work comes after
that first change, never before it.

- **Pressed state at once.** Buttons, rows and menu items show a pressed state on pointer down
  with no transition, as #18 does for file rows. Hover appears in 0 ms and fades out in 120 ms.
- **Optimistic UI** for local, reversible vault edits: rename, tag, move to group, favourite,
  reorder. The list updates immediately and the IPC call runs behind it. On error the list rolls
  back and shows an inline error. Never optimistic: connecting, trust decisions, secrets,
  deletes.
- **Skeletons, not spinners.** A skeleton appears only when a wait passes 150 ms, so fast loads
  never flash. Lists keep their height while they reload.
- **Fewer round trips.**
  - Hosts, groups, keys and identities load once per unlock and are then updated from change
    events, not re-listed on every view switch.
  - Host details read from that cache.
  - Remove the 1 s polling timers (for example in MultiRunDialog) in favour of session events.
- **Large lists.** Hosts, files and known hosts are windowed above about 200 rows.
- **Measure, don't guess.**
  - Add a UI perf spec that records click-to-paint for: open host, switch tab, open settings,
    open palette, expand group, select a file.
  - It fails if a median goes over 100 ms on the mock backend.
  - Profile with the React profiler and fix the three slowest renders first.

## 2. Hosts: no Connect button, double-click to connect

This merges with the multi-select work already assigned (HST-13).

- **Remove Connect buttons from host rows and cards.**
  - Double-click a host, or press Enter on the selection, to connect.
  - A single click selects the host and shows it in the Host details panel if the panel is open.
  - The row's "…" menu and right-click menu keep "Connect", "Connect in split", "Open in SFTP"
    and the rest.
- **Hover hint.** A small "Double-click to connect" tooltip appears the first few times, then
  stops showing. The Host details panel keeps a primary Connect button, so the action is always
  discoverable.
- **Same pattern in other lists.** Recent connections on Home, the palette, and group rows
  (double-click a group to expand or collapse it; "Connect all" lives in the group's menu).
- **Keyboard first.**
  - Type to filter in the Hosts list.
  - Arrow keys move the selection; Enter connects; Space toggles selection.
  - Cmd/Ctrl+Enter opens the host in a split; Shift+Enter opens it in SFTP.

## 3. Autosave, Termius style

Explicit Save/Cancel goes away wherever an edit is safe to keep on its own.

### Host details panel and group editor

- Non-secret fields save automatically 400 ms after the last change, or at once on blur:
  - name, address, port, user, group, tags, protocol;
  - the sign-in method choice, the key or identity choice;
  - encoding, terminal type, agent forwarding, jump host, proxy (non-secret parts);
  - environment variables, paste settings, notes.
- **Validation per field.** An invalid field shows its error inline and is not saved. The other
  fields still save.
- **A small status in the panel header:** "Saving…", then "Saved", then nothing. On error it
  shows "Couldn't save – Retry".
- **Undo.** Every autosave can be undone for 10 s: Cmd/Ctrl+Z in the panel, or "Undo" in the
  status. Undo restores the previous record exactly.
- **Secrets never autosave.**
  - A password or passphrase field has its own "Set password" button. Enter in the field also
    sets it.
  - The value is written once and then cleared from the DOM, as today.
  - Leaving a typed but unset secret asks: "Discard the password you typed?"
- **Multi-field orders.** A chain or route that must be saved in a set order (jump host plus
  proxy) is saved as one unit, once all its parts are valid.
- **New host.** The host is created on the first valid address and is then autosaved like any
  other. Closing the panel with nothing but an empty or invalid address creates nothing.
- **Connect.** The primary button is always "Connect". There is no "Save and connect", because
  everything valid is already saved.

### Settings

Every setting applies and saves as it changes. This is already true for most; remove the
remaining Save buttons (for example the Keyboard shortcuts reset flow keeps its confirmation, but
binding changes save at once).

### Still explicit, on purpose

- Vault passphrase change.
- Restore from backup.
- Deletes: they confirm, and a single-item delete gets a 10 s Undo instead of a dialog where that
  is safe.
- Trust decisions.
- Anything that sends input to a session.

## 4. Motion that explains change

All motion uses the overhaul tokens: about 140 ms for enter, 100 ms for exit, and standard
easing. Transform and opacity only, and nothing under reduced motion.

- **Panels and sheets.** The Host details panel, side panels and the transfers drawer slide and
  fade in (8 px, 160 ms).
- **Lists.**
  - Added or removed rows fade and collapse their height with a FLIP transform, not a height
    animation.
  - A reordered row moves to its new place.
  - A row that just autosaved flashes a 400 ms tint, once.
- **Tabs.**
  - A new tab grows in from the + button.
  - A closing tab shrinks out.
  - The active tab indicator slides between tabs.
- **Menus, palette and tooltips.** Scale 0.98→1 plus fade, 120 ms, from the anchor point.
- **Feedback.** Toasts slide up from the status bar edge. Inline "Saved" fades.
- **Connection sheet (#36).** Steps reveal one by one as events arrive. No idle animation.
- **Never.** No bounce, no parallax, no animation on page load other than the single onboarding
  moment, nothing longer than 220 ms.

## 5. Delivery

Small PRs, each with UI specs and re-recorded baselines in the pinned container:

1. This plan (docs only).
2. Hosts interactions (section 2), together with multi-select (HST-13).
3. Autosave for the host panel and group editor (section 3), with negative tests:
   - a secret is never sent by autosave;
   - an invalid field is never stored;
   - undo restores exactly;
   - the save order of route parts is kept.
4. Perceived-performance pass (section 1), with the perf spec. It lands first if it finds
   something big.
5. Motion pass (section 4), after the overhaul PRs #26 and #34–36.

Done means:
- the perf spec passes;
- no host row has a Connect button;
- the host panel has no Save button;
- reduced motion turns every animation off;
- all existing security tests still pass unchanged.

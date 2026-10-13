# 001 — Make shared motion interruption clean

- **Status**: DONE (2026-10-14; exit cancellation corrected, see docs/redesign/PROGRESS.md)
- **Commit**: 8b8da8ae
- **Severity**: HIGH
- **Category**: Interruptibility and purpose/frequency
- **Estimated scope**: shared motion helpers, motion CSS, one browser test file

## Problem

`apps/desktop/src/lib/useGlide.ts:34–36` currently returns before cancelling an active glide:

```ts
if (!item || !was || was.item === item) return;
const ms = motionMs("--duration-glide");
if (ms <= 0 || openedBy() !== "pointer" || typeof root.animate !== "function") return;
```

A pointer glide can continue after a keyboard selection while the current item is visually suppressed. `lib/exitGhost.ts:53` starts outgoing copies at a fresh presentation state and `useExit` does not remove them when the same surface reopens. `lib/motion.ts:105` staggers libraries on pointer navigation.

## Target

Keep 140 ms pointer glides, strong ease-out `cubic-bezier(0.23, 1, 0.32, 1)`, opacity/transform only. New keyboard actions remove running glides immediately. Motion-preference changes remove glides without another navigation action. Unmount removes both marker and transient attribute. Pointer retargets start from measured presentation position.

Exits last shared `--duration-exit` (approved 100 ms). Start from computed opacity/transform, preserving transform origin; cancel same-surface ghosts on reattach. Ghosts are inert and accessibility-hidden. Skip form, password-input, dialog/alertdialog, and terminal-containing surfaces; never clone security or terminal content for decoration. Keep existing lock-before-paint cleanup and bounded timeout.

Libraries appear immediately; no initial stagger. Small occasional structural FLIP remains 140 ms, new rows 140 ms and 4 px maximum; keyboard typing and reduced motion stay instant.

## Conventions

Use existing CSS token names and `inputModality.ts` utilities. `styles/motion.css:161` protects terminal descendants. CSS `@starting-style` handles entries. WAAPI handles only dynamic positions/exits. No libraries needed.

## Steps

1. Update `lib/useGlide.ts`: one idempotent clear function; clear before instant-action early returns, on media/root preference change, on keyboard capture, on unmount. Pointer retarget reads live marker box before cancelling.
2. Update `lib/exitGhost.ts`: use live styles; skip sensitive surfaces; each `useExit` instance tracks its own outgoing copy and cancels it on reattachment. Public direct exits retain their API. Never alter form/auth state.
3. Update `lib/motion.ts`: disable initial library stagger while retaining structural FLIP API compatibility.
4. Keep reduced-motion CSS overrides and terminal-safe selectors; remove obsolete shake commentary only.
5. Add `tests/ui/redesign-motion.spec.ts` with synthetic fixtures and animation pausing to test true mid-flight pointer-to-keyboard cleanup, immediate reopen cleanup, focus return, and both reduced-motion sources.

## Boundaries

Do not edit tokens/global CSS, transport, crypto, auth rules, capabilities or backend. Do not animate terminal ancestors or use layout property transitions. No dependencies. Stop and report meaningful file drift before incompatible edits.

## Verification

- Run desktop typecheck and formatter/lint through the existing package commands.
- Build frontend; run `pnpm --filter @tyrminal/ui-tests test redesign-motion.spec.ts --project=chromium --workers=1 --trace=on`.
- Record a real-clock synthetic flow; review normal-speed clip and sample frames through interrupted menu/panel exit. Attach measured requestAnimationFrame intervals and a browser trace, describing environment limits.
- Done when paused pointer glide disappears immediately on keyboard/reduced-motion signal, reopened surface has no older exit copy, no invisible interactive ghost remains, and terminal geometry/transform stays stable.

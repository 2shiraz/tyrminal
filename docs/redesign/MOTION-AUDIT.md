# Tyrminal motion audit

Audit checkpoint: `8b8da8ae`, 2026-10-14. Read-only source review before the redesign baseline gate. Consulted improve-animations (including AUDIT.md and PLAN-TEMPLATE.md), find-animation-opportunities, animate, review-animations, animation-performance, animation-vocabulary, and apple-design. The master redesign specification and Quiet Precision direction take precedence over optional skill suggestions.

## Existing system

React 19, native CSS transitions with `@starting-style`, and WAAPI; no motion dependency is necessary. The shared system already uses strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`), a drawer curve, short 140/180/220 ms entries, 100 ms exits, input-modality gates, and reduced-motion tokens. Terminal descendants explicitly exclude application transitions while respecting the terminal cursor preference (`styles/motion.css:161`). Browser tests use synthetic transport only. Existing motion tests generally cover settled behavior, not mixed pointer/keyboard interruption or reopen during exit.

## Vetted findings

| Priority | Severity | Category | Evidence | Recommended result |
| --- | --- | --- | --- | --- |
| 1 | HIGH | Interruptibility | `apps/desktop/src/lib/useGlide.ts:34–36` returns for keyboard/reduced-motion changes before cancelling a previous pointer animation; the active item's fill remains suppressed by `data-gliding`. | Cancel and remove stale glides on instant navigation, on unmount, and when motion preferences change. Preserve presentation position only for pointer-to-pointer retargets. |
| 2 | MEDIUM | Interruptibility | `apps/desktop/src/lib/exitGhost.ts:24–53` clones the outgoing surface, always starts it at opacity 1/transform none, and has no reopen cleanup. | Capture live presentation opacity/transform; cancel a previous same-surface ghost on reattach. Skip forms, secret inputs, and terminal-containing surfaces instead of extending their lifetime. Preserve lock cleanup. |
| 3 | MEDIUM | Purpose/cohesion | `apps/desktop/src/features/terminal/connect-track.css:55,116,183` runs rotating arc, travelling segment, and expanding pulse together; `:195,262` shakes failure and overshoots success. | Keep one truthful connecting arc; static reached track and current ring. Remove travel, pulse, shake, and success scale. No new timer or synthetic connection progress. |
| 4 | MEDIUM | Purpose/frequency | `apps/desktop/src/features/vault/VaultScreens.tsx:225–234` shakes the whole unlock form after an error. | Retain focus restoration and inline error; remove spatial error animation. Authentication semantics are untouched. |
| 5 | LOW | Cohesion/frequency | `apps/desktop/src/lib/motion.ts:105–118` staggers the first six library rows; it is gated to pointer but repeated whenever a list remounts. | Libraries appear immediately. Keep small FLIP changes only for occasional structural edits, never typing. |

These are code-confirmed findings, not measured dropped frames. No whole-terminal transforms, transition-all, or spring dependency were found in the shared system. Geometry measurements in FLIP are synchronous and bounded at 300 entries; actual trace work remains required before making performance claims.

## Opportunities that passed the gate

| Surface | Frequency/purpose | Recipe |
| --- | --- | --- |
| Menus and contextual panels already animating | Occasional; spatial consistency | Retain origin-aware CSS entry, make exit presentation-aware and cancellable. Shared 140/180 ms entries, 100 ms exit, strong ease-out; instant keyboard/reduced-motion variant. |
| Notifications already animating | Occasional; prevent jarring change | Retain compositor-only arrival and small stack FLIP. Exits remain inert, nonblocking and same-edge; no bouncing stack or delayed command. |

## Rejected additions

- Palette entry/exit and keyboard tab traversal: high frequency; must be instant.
- Terminal canvas, output, selection, and split resize: functional data and direct manipulation; cannot move or blur for decoration.
- Search-result cascades: typing frequency; immediate results preserve orientation better.
- Fingerprint content and changed-key warning: stability and legibility outweigh motion.
- Transfer progress smoothing beyond actual values: would misrepresent remote I/O. Retargeting may approach actual progress, never advance ahead.

## Plan and verification

Execution details live in `animation-plans/`. Source edits wait for the parent baseline gate. Tests will exercise pointer-to-keyboard interruption, reopen during exit, reduced-motion interruption, stable security errors, and stationary terminal glyphs. Recording, slowed animation frames, and a browser frame timeline must be inspected; until then rendered motion feel and hardware frame-rate behavior are UNVERIFIED. macOS/Windows/Linux native motion behavior is not established by Chromium mock tests.

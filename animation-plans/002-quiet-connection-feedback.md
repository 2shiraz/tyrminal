# 002 — Keep security and connection feedback quiet

- **Status**: DONE (2026-10-14)
- **Commit**: 8b8da8ae
- **Severity**: MEDIUM
- **Category**: Purpose/frequency and cohesion
- **Estimated scope**: two source files, browser assertions

## Problem

`apps/desktop/src/features/terminal/connect-track.css:55,116,183` combines three continuous effects. Failure `:195` shakes a dot and success `:262` grows to `scale(1.12)`. `features/vault/VaultScreens.tsx:225–234` moves the whole form on wrong passphrase:

```ts
form.animate([
  { transform: "none" },
  { transform: "translateX(-6px)", offset: 0.2 },
  { transform: "translateX(5px)", offset: 0.45 },
  { transform: "translateX(-3px)", offset: 0.7 },
  { transform: "none" },
], { duration: ms, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
```

## Target

One connecting arc rotates 0.9 s linear only during actual reported in-flight work. Reached fill stays event-driven; current/waiting rings remain static. No segment travelling loop, pulse, shake, or settle overshoot. Success remains understated color/icon change with shell input available immediately. Wrong passphrase retains readable inline error and immediate field focus, no form transform.

## Conventions and steps

1. Remove track-travel, track-pulse, track-shake, and track-settle animation declarations/keyframes from `connect-track.css`; hide the travel decoration. Preserve stage data, border/status semantics, reduced-motion arc stop, and connected layer exit.
2. Remove only WAAPI animation from `VaultScreens.tsx` failure effect; keep input focus, error state, all vault calls and validation.
3. Add synthetic assertions to `redesign-motion.spec.ts` for quiet failure and truthful connecting arc. Keep existing connection event tests unchanged unless exact semantics require updated motion expectations.

## Boundaries

No auth semantics, no security warning text or automatic acceptance, no transport changes, no timers, no dependency additions. Do not touch global/tokens CSS. Do not animate terminal or fingerprint contents.

## Verification

Run frontend build/typecheck/lint and `connect-track.spec.ts`, new redesign-motion tests. Review recording of connecting → verification prompt → auth failure; check one ongoing loop only, stable warning, instant cancel, no terminal transforms. Reduced motion shows the same text/state with zero spatial movement. Native platforms remain unverified unless separately executed.

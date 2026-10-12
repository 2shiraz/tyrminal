# ADR 0013: Afterglow, an experimental UI behind a build-time switch

Status: accepted for the branch `claude/experimental-ui` only. Nothing here reaches main without the
owner's written approval. 2026-10-12

## Context

The owner asked for an experimental redesign ("Afterglow", `docs/experimental/afterglow-plan.md`):
rounded, tactile, with springs and a few signature moments, built so main's UI stays untouched and
the branch rebases on main with conflicts only in new files.

## Decision

1. **Build-time switch.** `TYRMINAL_UI=experimental` (`pnpm dev:exp`, `pnpm build:exp`,
   `pnpm test:ui:exp`, `pnpm capture:exp`; `scripts/exp/run.mjs`). Without it, `expPlugins()` in
   `apps/desktop/vite.exp.mjs` returns nothing and main's build is unchanged. The only edit to an
   existing main source file is the plugin wiring in `apps/desktop/vite.config.ts` (an import and
   one spread in `plugins`). Preferences and `crates/contracts` are not touched.
2. **One Vite plugin** swaps a whitelist of presentational modules for replacements under
   `apps/desktop/src/exp/`, appends the Afterglow entry after `main.tsx`'s imports (so its CSS
   loads after main's), marks the document `data-ui="afterglow"` and writes to `dist-exp/`.
   Every Afterglow rule is scoped under `:root[data-ui="afterglow"]`.
3. **Security rules unchanged.** Same CSP (fonts are bundled, nothing is fetched at run time), no
   new IPC, capabilities or permissions, no change to domain, vault, ssh or storage crates.
   Secrets never go into animation state, `layoutId` keys, data attributes or logs. Lock clears
   content before any fade, exactly as main.
4. **Tests.** The role-based UI specs run unchanged against the experimental build
   (`tests/ui/playwright.exp.config.ts`). Its visual baselines live in
   `tests/ui/__screenshots__/afterglow/`; main's baselines never change. Afterglow-only specs are
   named `*.exp.ts`, which main's config does not match.

## Dependencies (experimental build only)

| Component | Version | Licence | How it is used | Reason | Alternatives |
|---|---|---|---|---|---|
| Geist Sans (variable, latin + latin-ext) | 1.x via `@fontsource-variable/geist` 5.3.0 | OFL-1.1 | Two woff2 files vendored in `apps/desktop/src/exp/fonts/` (46 KB); Vite bundles them into `dist-exp` only; no package dependency, no runtime fetch | A UI face built for small sizes with tabular figures and round terminals that suit the rounded language | System UI faces (main's choice), Inter (the default tell the plan rejects) |
| motion | 13.4.4 (pinned; published 2026-09-25, past the 7-day cool-down; 14.x avoided until it has aged) | MIT | `apps/desktop` dependency imported only from `src/exp/` (added in M2) | Interruptible springs, layout and exit animations, gesture velocity | CSS-only (no exit or layout animation), react-spring (no exit/layout story) |
| Phosphor icons | `@phosphor-icons/core` 2.1.1 (pinned; 2024-03-29) | MIT | `apps/desktop` devDependency, build-time only: `scripts/exp/gen-icons.mjs` inlines the regular and duotone paths into `src/exp/ui/icons.tsx` (M1), swapped in for main's Lucide set under the same export names | A softer, rounder icon family matching the shape language; main's Lucide set stays | Lucide (main's set) |

Licences and versions are recorded in `NOTICE` when each lands; lockfiles stay committed.
`scripts/check-release.mjs` on main is not changed; the branch's `scripts/exp/check-isolation.mjs`
asserts that main's `dist/` holds no Afterglow code and no Geist font.

# Design system

Everything visual is built from tokens in `apps/desktop/src/styles/tokens.css` and the component
layer in `apps/desktop/src/styles/global.css`. Components use variables only; raw colors outside
`tokens.css` and the terminal schemes are a review finding. No remote assets: fonts and icons are
bundled, and the CSP forbids loading anything from the network.

## Themes

- Dark (default), light, and system (follows `prefers-color-scheme`), chosen in Settings →
  Appearance and applied as `data-theme` on the root element.
- Contrast: `node scripts/check-contrast.mjs` checks every text/surface pair in both themes and
  every terminal scheme against WCAG 2.2 AA (4.5:1 text, 3:1 large text, icons and control
  boundaries). It runs in CI.
- The terminal palette is independent of the app theme (`features/terminal/schemes.ts`,
  14 schemes, each with a live preview in Settings).

## Tokens

| Group | Tokens |
|---|---|
| Type | `--font-ui` (system UI stack), `--font-mono` (bundled JetBrains Mono + Symbols Nerd Font Mono); sizes `--text-2xs` 11 → `--text-2xl` 26 px; weights 450/550/620/680 |
| Space | `--space-1` 4 px … `--space-7` 48 px (4-px base) |
| Radius | `--radius-xs` 4, `--radius-sm` 6, `--radius-control` 8, `--radius-panel` 12, `--radius-dialog` 16, `--radius-pill` |
| Layout | `--control-height` 34, `--control-height-sm` 28, `--sidebar-width` 240 / collapsed 60, `--tabstrip-height` 42, `--statusbar-height` 28, `--panel-width` 340 |
| Motion | `--motion-fast` 120 ms, `--motion-base` 180 ms, `--motion-slow` 260 ms; `--ease-out`, `--ease-spring` |
| Color | Surfaces `--bg-app`, `--bg-sidebar`, `--bg-surface`, `--bg-raised(-hover)`; text, border, accent and status tones (`ok`, `warning`, `danger`, `info`) per theme |

## Motion

Transitions use the motion tokens. Under `prefers-reduced-motion: reduce`, or the in-app
"Reduce motion" preference, the motion tokens become 0 ms and looping animations (busy dots,
skeletons, spinners) stop. The browser UI tests run with reduced motion and disabled
animations.

## Icons

A generated subset of Lucide (ISC license, `lucide-static` 1.47.0) in
`components/ui/icons.tsx`, produced by `scripts/gen-icons.py` from `icons.list`. Icons are
`aria-hidden`; the control that contains one carries the accessible name.

## Components

`components/ui/controls.tsx`: `TextField`, `SecretField`, `TextArea`, `Switch`, `Segmented`,
`RangeField`, `SettingRow`, `IconButton` (requires a label; shows it as a tooltip), `Shortcut`
and `Keys` (platform-aware key caps), `Avatar`, `EmptyState`, `SkeletonRows`, `ErrorNotice`,
`Notice`. `Dialog.tsx` (native `<dialog>`, focus trap, `data-autofocus`), `Menu.tsx`,
`Toasts.tsx` (polite live region; cleared on lock). Layout: `Sidebar`, `TabStrip`, `PaneGrid`,
`StatusBar`.

States every list screen implements: empty (with a primary action), loading (skeleton rows),
error (`ErrorNotice` with retry), and populated.

## Accessibility rules

- Keyboard first: every action is reachable without a pointer; the command palette (Cmd+K on
  macOS; Ctrl+Shift+K elsewhere, plus Ctrl+K outside a terminal) lists every command with its
  shortcut. Bindings live in `lib/shortcuts.ts`, one table per platform family.
- Tabs use the ARIA tab pattern with roving focus; Ctrl/Cmd+Shift+Arrow moves a tab and keeps
  focus on it; F2 renames; Delete closes.
- Focus is never stolen: a terminal takes focus when its pane is shown or focused, not when its
  session merely changes state while the user is elsewhere.
- Tooltips are `content: attr(data-tooltip) / ""` so they never pollute accessible names.
- `tests/ui/behavior.spec.ts` asserts every button has an accessible name and ids are unique.

## Visual regression

`tests/ui/visual.spec.ts` captures 17 screens per theme. Baselines are recorded only in the
pinned Playwright image (`pnpm test:ui:update:container`) so pixels match CI. Review baseline
diffs like code.

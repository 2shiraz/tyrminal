# Design system

Everything visual is built from tokens in `apps/desktop/src/styles/tokens.css` and the component
layer in `apps/desktop/src/styles/global.css`. Components use variables only; raw colors outside
`tokens.css` and the terminal schemes are a review finding. No remote assets: fonts and icons are
bundled, and the CSP forbids loading anything from the network.

## Themes

- The current visual system is described in `DESIGN.md` at the repository root (Quiet Precision);
  where this file differs from it, `DESIGN.md` is newer.
- Five color themes (Cobalt, the default; Verdigris; Fjord; Graphite; High contrast), each with a
  dark and a light mode. The theme is the `palette` preference, applied as `data-palette` on the
  root element (absent for Cobalt); the mode is dark, light or system (follows
  `prefers-color-scheme`), applied as `data-theme`. Both are chosen in Settings → Appearance.
- Contrast: `node scripts/check-contrast.mjs` checks every text/surface pair in every theme and mode and
  every terminal scheme against WCAG 2.2 AA (4.5:1 text, 3:1 large text, icons and control
  boundaries). It runs in CI.
- The terminal palette is independent of the app theme (`features/terminal/schemes.ts`,
  14 schemes, each with a live preview in Settings).

## Tokens

| Group | Tokens |
|---|---|
| Type | `--font-ui` (system UI stack), `--font-mono` (bundled JetBrains Mono + Symbols Nerd Font Mono); sizes `--text-2xs` 11 → `--text-2xl` 26 px; weights 450/550/620/680 |
| Space | `--space-1` 4 px … `--space-7` 48 px (4-px base) |
| Radius | `--radius-inner`/`--radius-xs` 2, `--radius-sm` 3, `--radius-control` 4, `--radius-panel` 4, `--radius-box` 4, `--radius-dialog` 6, `--radius-edge` 0; `--radius-pill` for switch tracks and status dots only |
| Boxes | `--strip-height` 32, `--strip-height-pane` 44, `--row-dense` 28, `--row-height` 36, `--row-setting` 44; `--box-border`, `--box-rule`, `--box-gap`, `--bg-strip`, `--bg-box`; edges `--edge-select`, `--edge-live`, `--edge-danger` |
| Layout | `--control-height` 34, `--control-height-sm` 28, `--sidebar-width` 240 / collapsed 60, `--tabstrip-height` 42, `--statusbar-height` 28, `--panel-width` 340 |
| Motion | `--motion-fast` 120 ms, `--motion-base` 180 ms, `--motion-slow` 260 ms; `--ease-out`, `--ease-spring` |
| Color | Surfaces `--bg-app`, `--bg-sidebar`, `--bg-surface`, `--bg-raised(-hover)`; text, border, accent and status tones (`ok`, `warning`, `danger`, `info`) per theme |

## Boxes

The one container pattern (docs/design/revamp.md), taken from the SFTP and Files panes: rectangles
that share edges, labelled by a strip, filled with rows. Colour marks state only, as an edge.

- `.box` (1 px border, 4 px radius, no shadow, no padding); `data-edge` for panes attached to a
  window edge, `data-flush` inside a `.box-grid`, `data-live` for a 2 px accent top line.
- `.box-strip`: 32 px label strip with an `h2`/`h3`, an optional `.box-count` and `.box-actions`
  (small ghost buttons).
- `.dt`: data table with a sticky 28 px header strip, 36 px rows (28 with `data-dense`), hairlines
  between rows on pages, selection as `--bg-selected` plus a 2 px left accent edge.
- `.box-grid`: children share 1 px edges. `.btn-strip`: joined buttons.
- Only floating surfaces (menus, dialogs, palette, toasts) keep a shadow.
- Under forced colours, live and selected get an outline, since contrast themes drop box-shadows.

`styles/box.css`; `components/ui/Box.tsx` (`Box`) and `BoxEmpty` in `controls.tsx`.

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
and `Keys` (one platform-aware text hint, such as "Ctrl+Shift+K" or "⌘K", not key caps), `Avatar`, `EmptyState`, `BoxEmpty`, `SkeletonRows`, `ErrorNotice`,
`Notice`. `Dialog.tsx` (native `<dialog>`, focus trap, `data-autofocus`), `Menu.tsx`,
`Toasts.tsx` (polite live region; cleared on lock). `features/hosts/HostPanel.tsx` is the non-modal side panel
pattern for editing a record next to its list: focus moves into it on open and back to the opener
on close, Escape and the collapse button close it (asking first when there are unsaved changes),
Save keeps it open, and below 760 px of view width it covers the list, which becomes inert. Layout: `Sidebar`, `TabStrip`, `PaneGrid`,
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

# Afterglow status

Branch `claude/experimental-ui` only. Run it with `pnpm dev:exp` (desktop) or look at the captures in
`docs/design/afterglow/` (1440p, dark and light; `pnpm capture:exp` regenerates them). One line per
milestone, newest last.

- **M0 switch + skin (2026-10-12).** Visible: the whole app in Afterglow with no behaviour change:
  violet-graphite window material with the content as a rounded, lifted card, Ember amber as the one
  accent, Geist for the interface, rounded 8/12/16 shapes on the concentric rule, pill tabs and nav,
  soft fills for state, an amber brand mark, the vault screens as a card on a faint amber glow, and
  the terminal in Afterglow Night. Screenshots: `docs/design/afterglow/{dark,light}-01…17-*.png`
  (onboarding, unlock, empty hosts, home, hosts list and cards, host editor, menu, snippets,
  keychain, known hosts, settings, terminal, terminal with snippets, palette, split, trust prompt).
  Checks: typecheck, exp build, `scripts/exp/check-contrast.mjs` (163 AA checks), main build clean of
  Afterglow (`scripts/exp/check-isolation.mjs`), role-based specs against the exp build after merging main: 451 passed;
  the 2 identity specs that fail also fail on main, and the toast-beside-panel spec that the card
  inset broke is fixed (exp Toasts measures panels with the inset). Next: M1 press and release
  springs, origin-aware menus, Phosphor icons.
- **M1 press, hover, popovers (2026-10-12).** Visible: every button, nav pill, chip, card and tile
  eases into a 0.97 (cards 0.98) press and springs back with a small overshoot on release (200 ms,
  CSS `linear()` generated from the shared spring table); menus spring open from their trigger
  corner; tooltips are rounded and instant after the first; switches have a light thumb; the whole
  icon set is Phosphor (92 glyphs, same names as main's). Screenshots refreshed in
  `docs/design/afterglow/` (the menu shot, `*-08-menu.png`, shows the icons best). Checks:
  typecheck, exp build, contrast, role-based specs against the exp build (457 passed; the 2 identity
  specs fail on main too), new `tests/ui/afterglow-motion.exp.ts` (5 passed: release spring, 220 ms
  budget, menu spring vs keyboard, reduced motion, Phosphor). Next: M2 liquid tabs with a gliding
  pill and the afterglow ping.
- **M2 shell chrome (2026-10-13).** Visible: liquid tabs: a pointer switch glides one pill
  carrying the active fill from the tab you leave to the one you click, in step with main's tab
  width glide, then hands the fill back (keyboard switches stay instant); the afterglow ping: a
  background tab with new output or a finished command glows amber once and keeps a small amber
  dot until visited. Sidebar and status bar stay main's components, reskinned. Screenshots:
  `docs/design/afterglow/*-18-tab-glide.png` (the strip at rest after a switch; a 140 ms glide is
  over before a capture lands) plus the refreshed set. Checks: typecheck, exp build, role-based specs
  after merging main (459 passed; the 3 that fail also fail on main's own latest build or are its
  known frame-sampling flake), `afterglow-motion.exp.ts` 8 passed (pill glide, keyboard instant,
  ping). Next: M3 Hosts sheet physics.

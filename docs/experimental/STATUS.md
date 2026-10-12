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
  Afterglow (`scripts/exp/check-isolation.mjs`), role-based specs against the exp build (see the
  M0 entry in the commit for the count; the 5 failures that remain also fail on main). Next: M1
  press and release springs, origin-aware menus, Phosphor icons.

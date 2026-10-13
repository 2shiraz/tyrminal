# Afterglow: review build for the owner

Branch `claude/experimental-ui` only. Nothing here is merged into main, and nothing will be without
your written approval. The plan is `afterglow-plan.md` (its §11 lists every deviation and why);
milestone notes are in `STATUS.md`.

## How to look at it

| What | Command |
|---|---|
| Run the desktop app with Afterglow | `pnpm dev:exp` |
| Unsigned desktop build of Afterglow | `pnpm build:exp` |
| Only the front-end bundle (`apps/desktop/dist-exp/`) | `pnpm build:web:exp` |
| Main's UI, unchanged | `pnpm dev` / `pnpm build:desktop` |
| Screenshots of both, 1440p, dark and light | `docs/design/afterglow/` (Afterglow) and `docs/design/afterglow/main/` (main), same names |
| Regenerate the Afterglow screenshots | `pnpm capture:exp` |
| Run every UI spec against Afterglow | `pnpm test:ui:exp` |

The switch is build-time (`TYRMINAL_UI=experimental`). Main's build contains zero Afterglow bytes
(`node scripts/exp/check-isolation.mjs` checks that), and the only edit to an existing main source
file is two lines in `apps/desktop/vite.config.ts`.

## Side by side (same scenario, same data)

| Screen | Main | Afterglow |
|---|---|---|
| Hosts, list | `main/dark-05-hosts-list.png` | `dark-05-hosts-list.png` |
| Hosts, cards | `main/dark-06-hosts-grid.png` | `dark-06-hosts-grid.png` |
| Host details | `main/light-07-host-editor.png` | `light-07-host-editor.png` |
| Context menu (icons) | `main/dark-08-menu.png` | `dark-08-menu.png` |
| Terminal with snippets | `main/dark-14-terminal-snippets.png` | `dark-14-terminal-snippets.png` |
| Command palette | `main/dark-15-palette.png` | `dark-15-palette.png` |
| Connection track (trust prompt) | `main/dark-17-trust-prompt.png` | `dark-17-trust-prompt.png` |
| Toasts | `main/dark-19-toast-deck.png` | `dark-19-toast-deck.png`, `dark-20-toast-deck-fanned.png` |
| Terminal appearance | `main/dark-21-appearance-panel.png` | `dark-21-appearance-panel.png` |
| New tab | `main/light-22-start-page.png` | `light-22-start-page.png` |
| Settings | `main/light-12-settings.png` | `light-12-settings.png` |
| Unlock | `main/light-02-unlock.png` | `light-02-unlock.png` |
| SFTP | `main/dark-25-sftp-panes.png` | `dark-25-sftp-panes.png` |

## What changed, in one paragraph each

**Look.** Violet-graphite neutrals with Ember amber as the one accent (amber marks what is live,
current or just finished). The window is a heavy dark material; the content is a rounded, lifted
card inset from it, with the status bar as the card's foot. Geist for the interface, JetBrains Mono
for machine text. Shapes are rounded on one concentric rule (8 px controls, 12 px rows and menus,
16 px cards and sheets). State is a soft fill, not an edge line. Phosphor icons replace Lucide.
Terminal default: Afterglow Night. Light theme throughout.

**Feel.** Pressables ease into a 3% press and spring back with a small overshoot. Menus spring from
their trigger. The active tab's fill glides to the tab you click. A background tab that finished a
command or got output glows amber once and keeps a dot. Toasts form a deck that fans out on hover.
The host details panel can be thrown away by its header (it follows the pointer 1:1, flicks away
with momentum, rubber-bands, springs home). Connecting shows main's real-step track with a phosphor
glow, and the shell's end glows once on arrival. Unlocking brings the sidebar in one item after
another. Theme cards in the terminal panel. Keyboard actions and reduced motion stay instant, and
nothing ever moves the terminal canvas.

## Rules kept

- Main's own motion rules hold, enforced by its specs running against Afterglow unchanged: every
  running animation is at most 220 ms, transform and opacity only (plus colour, and the tab pill's
  width on a childless element), nothing from the keyboard, nothing under reduced motion, nothing on
  the terminal canvas. Afterglow's springs are fitted into that budget (plan §11.11).
- Same CSP, no new IPC, capabilities or permissions, no change to any crate, no secrets in animation
  state, data attributes or logs; lock clears content before any fade, as main.
- Contrast: 163 WCAG AA checks on the Afterglow tokens (`scripts/exp/check-contrast.mjs`), plus main's
  axe audits in both themes, which run against Afterglow unchanged.

## Verification status

| Check | Result |
|---|---|
| Typecheck, including `src/exp/parity.ts` (every swapped module keeps main's exports) | Pass |
| Main's role-based UI specs against Afterglow (`playwright.exp.config.ts`) | See the final M7 line in `STATUS.md`; every failure listed there also fails on main's own latest build |
| Afterglow specs (`*.exp.ts`): motion rules, liquid tabs, ping, sheet physics, toast deck, ignition, theme cards, start page, unlock stagger, performance smoke | Pass |
| Visual baselines | `tests/ui/__screenshots__/afterglow/` (main's untouched) |
| Bundle | Entry JS +1.8 KB gz over main (budget +10 KB), entry CSS +8.2 KB gz, Geist 46 KB (budget 80 KB), no animation library |
| Performance | **Not verified.** Headless Chromium with software GL only: frame intervals hold at 16 ms in the smoke tests; style recalculation during a 20-switch tab storm is about 0.9 s against main's 0.6 s (one costly `:has()` rule was found this way and replaced). Real WebView2 and WebKitGTK recordings on a mid-range laptop are still needed. |
| Native app tests (`pnpm test:native`) | Not run: this container has no packaged build or lab |

## Not done, and why

- **Hover preview of terminal schemes.** Main applies a scheme by saving the preference; previewing
  on hover would write preferences while the pointer passes over the cards.
- **Swipe to dismiss toasts.** Main made toasts click-through on purpose (a toast never covers a
  control); swiping needs pointer events on the toast.
- **Host sheet over a dimmed list, tile-to-tab morph, overlay-then-dock side panel.** Each would
  change geometry or timing that main's specs and panel clamps depend on; Afterglow keeps main's
  structure and adds the motion around it (plan §11.18, 19, 23).
- **The Motion library.** Not added: main's WAAPI machinery plus a small velocity-aware spring
  (`exp/motion/spring.ts`) covered every moment without a second animation system (plan §11.17).

## For main, independent of Afterglow

Two things found on the way that also affect main's own UI:

1. Since views and their CSS load on first use (#152), a switch row outside Settings (for example
   "Production host" in the host editor) shows its label and hint run together until Settings has
   been opened once, because `.setting-row` and `.setting-label` are laid out in `settings.css`.
2. Two of main's motion specs fail on main's latest build in this container ("a transfer bar glides
   between progress ticks", "a click slides the content in"), likewise after the lazy-loading change.

## If you want it in main later

A runtime switch (Settings → Appearance → "Interface: Classic / Afterglow") is possible without
touching the Rust core by keeping the choice in `localStorage` and loading the Afterglow entry as a
lazy chunk, but it would put Afterglow's code in main's bundle and make every swap a runtime branch.
The cleaner path, if you like the direction, is to adopt it screen by screen as ordinary main PRs.

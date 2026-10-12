# Tyrminal experimental UI plan: "Afterglow"

Planned read-only against `origin/main` `bc8af3bd`. Branch: `claude/experimental-ui` (never merged to main
without the owner's written approval). Paths are relative to `apps/desktop/src/` unless noted.

## 1. Vision

Tyrminal should feel like a calm, rounded instrument that answers your hand within one frame and then gets
out of the way of the terminal. Its colour comes from the amber phosphor of the terminals SSH grew up on.
Amber marks what is live, focused or just finished, then fades the way a phosphor glow fades. Motion is
physical and interruptible. It is generous on rare moments such as connecting, unlocking and first launch,
nearly invisible on the hundred-times-a-day ones, and absent from the keyboard and the terminal canvas.

**Design language name: Afterglow.** Lit things glow briefly, then settle.

Design read (taste-skill 0.B): *a desktop power-tool for engineers who live in it all day, with a rounded,
tactile, Apple-adjacent language. It leans on Motion springs, an amber accent on violet-graphite neutrals,
Geist for UI and JetBrains Mono for machine text.* Dials: VARIANCE 5, MOTION 7, DENSITY 6.

## 2. Skills used and what each contributed

| Skill | Contribution |
|---|---|
| taste-skill | Design read and dials. Bans the AI tells (Inter default, AI purple, beige+clay, em-dash copy, decorative dots, three equal cards). Shape-consistency lock and one-accent lock. Phosphor over Lucide for icons. |
| frontend-design | Grounds the identity in the subject: amber phosphor (VT220 era) plus a rounded tool. "Spend boldness in one place" means the amber afterglow is that one place and everything else stays quiet. |
| emil-design-eng | Frequency gate, press scale 0.97, never scale(0), origin-aware popovers, exits faster than entries, transitions over keyframes, Sonner principles, velocity dismiss above 0.11 px/ms. |
| apple-design | Springs as damping+response mapped to Motion `bounce`+`visualDuration`. Velocity hand-off, momentum projection (d = 0.998), rubber-banding, materials (heavier sidebar, lighter controls), spatial symmetry, size-specific tracking. |
| animate | Build order for every motion spec in section 6: gate, purpose, cheapest tool, properties, curve, interruption, reduced motion. |
| animation-performance | Frame budget of 8 ms at 120 Hz. Composite-only properties. CSS/WAAPI for anything that plays during IPC-heavy connect. Motion `transform` strings, not `x`/`y`, on busy paths. No inherited CSS-variable animation. Blur under 20 px. |
| improve-animations | Recon of the existing motion system (`styles/motion.css`, `lib/motion.ts`, `lib/inputModality.ts`, `docs/design/motion.md`), so this plan extends its tokens and keyboard-instant machinery instead of forking them. |
| ui-ux-pro-max | The design-system search ("developer tool SSH terminal desktop") returned teal+orange, Flat style and Inter. That was rejected as templated (teal is already main's accent, and Inter is the default tell). The colour search returned the "code dark + run green" dev palette. Its neutral-ladder structure (bg, card, muted, border, ring) was kept and the hues rejected. The typography search returned JetBrains Mono + IBM Plex Sans ("Developer Mono") and kept JetBrains Mono for machine text. Its checklist (4.5:1, visible focus, reduced motion, no emoji icons) is adopted as the gate in section 10. |
| redesign-skill | Audit-first and keep the stack: same React 19 + plain CSS, no Tailwind migration. Fix order: font, palette, press/hover, spacing, components, states. |

## 3. References and the lesson taken from each

Several sites (emilkowal.ski, rauno.me, linear.app, termius.com) were unreachable from this sandbox, so the
lessons come from search excerpts and established knowledge of the products. Nothing below is copied.

| Reference | Lesson for Afterglow |
|---|---|
| Termius (2025 desktop redesign: tabs in the title bar, vaults, command palette) | Navigation moved to title-bar tabs because the sidebar got cluttered. So keep the sidebar to a handful of destinations and put live sessions in tabs, never in the sidebar. The tile-with-subtitle list is a good, scannable unit. Afterglow keeps the unit and changes everything around it (palette, type, motion, density). |
| Linear (2024 refresh, feature-flagged rollout, LCH themes, warmer greys) | Ship the redesign behind a flag with one-click comparison, which matches section 8. Generate the neutral ramp in a perceptual space (OKLCH) so steps look even. Reduce chrome noise by aligning sidebar, header and tab heights to one grid. |
| Raycast (50 ms response budget, no open/close animation on the launcher) | The command palette and quick connect open **instantly**, and shortcuts are shown inline in results. Speed is the animation. |
| Arc | The sidebar is a *material*: a heavier, darker layer than the content, with content as a lifted card inside the window, rounded on all corners. Spaces get their own tint. In Afterglow, the vault and group tints are an 8% wash on the tile, not a full theme. |
| Warp | Group output into readable units and hold 60 fps on large screens. Applied here: chrome never repaints the terminal, and the command-mark gutter (existing) gets the afterglow treatment, not the canvas. |
| Vercel dashboard (Emil's account) | A shared-layout tab indicator dropped frames while the next page loaded. Anything that animates during connect or IPC bursts runs as CSS/WAAPI, not rAF. |
| Things 3 | Delight lives in a few rare, physical moments (Magic Plus drag-to-insert). Everyday rows stay still. This is the model for the signature-moment budget. |
| macOS Sonoma system UI | Concentric radii (inner = outer minus padding), translucent sheets over dimmed content, critically damped springs by default, and a little bounce only after a flick. |
| Emil Kowalski (Sonner, Vaul) | Toasts use transitions that retarget, a stacked deck that expands on hover, timers paused on hover or hidden window, and swipe with velocity. Sheets use the drawer curve `cubic-bezier(0.32,0.72,0,1)`, translate in percentages and write `transform` directly (no CSS-var drag). |
| Rauno Freiberg ("Invisible Details of Interaction Design") | Gestures respond during the gesture, not after a threshold. Every transition must be interruptible mid-flight, because a panel you cannot grab back while it animates feels broken. Feedback goes on pointer-down. |

## 4. Visual system

### 4.1 Colour (tokens in `exp/styles/tokens.css`, checked by `scripts/check-contrast.mjs`)

Neutrals are a violet-graphite ramp (hue around 285 in OKLCH, chroma 0.01 to 0.015), deliberately cool
against the warm accent. They are not Termius navy and not main's neutral graphite. The accent is
**Ember amber**: Termius owns blue, main owns teal, Linear owns violet, and amber is grounded in P3 phosphor
terminals. One accent, locked everywhere.

**Dark (default)**

| Token | Hex | Use |
|---|---|---|
| `--bg-window` | `#0E0D12` | sidebar and title bar (heavy material) |
| `--bg-canvas` | `#141319` | content card behind lists |
| `--bg-surface` | `#1A1920` | panels, sheets, the new-tab page |
| `--bg-raised` | `#211F28` | tiles, inputs, cards |
| `--bg-hover` | `#2A2833` | hover and pressed rows |
| `--bg-overlay` | `#24222C` | menus, popovers, toasts, palette |
| `--border-subtle` | `rgb(255 255 255 / 0.06)` | hairlines inside cards |
| `--border` | `#34313D` | card edges |
| `--border-control` | `#726E7E` | inputs and switches (3:1) |
| `--highlight` | `rgb(255 255 255 / 0.05)` | 1px top inner edge on raised surfaces |
| `--text` | `#EEEDF3` | primary |
| `--text-muted` | `#ABA8B6` | subtitles |
| `--text-faint` | `#8D8A98` | hints (4.5:1 on `--bg-raised`, to verify) |
| `--accent` | `#F7A440` | primary fills, focus, live markers |
| `--accent-hover` | `#FFB65E` | |
| `--accent-soft` | `rgb(247 164 64 / 0.14)` | active nav pill, selected tile |
| `--accent-text` | `#FFC27A` | accent text on dark |
| `--on-accent` | `#1C1305` | text on amber |
| `--success` | `#4CC38A` | connected |
| `--danger` | `#F2626B` | errors, production tag, host-key mismatch |
| `--warning` | `#E8D35A` | sulfur yellow, always with icon and label |
| `--info` | `#8DB4FF` | neutral info |

**Light**

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| `--bg-window` | `#ECEBF0` | | `--text` | `#17161C` |
| `--bg-canvas` | `#F6F6F9` | | `--text-muted` | `#54515E` |
| `--bg-surface` | `#FFFFFF` | | `--text-faint` | `#6A6775` |
| `--bg-raised` | `#FFFFFF` | | `--accent` | `#B35E00` |
| `--bg-hover` | `#EFEEF3` | | `--accent-hover` | `#994F00` |
| `--bg-overlay` | `#FFFFFF` | | `--accent-soft` | `rgb(179 94 0 / 0.10)` |
| `--border` | `#E1DFE7` | | `--on-accent` | `#FFFFFF` |
| `--border-control` | `#8A8696` | | `--success` / `--danger` / `--warning` | `#1E8A57` / `#C8323C` / `#8A6D00` |

Known risk: amber accent versus warning yellow. They are about 16 degrees of hue apart in dark mode. Rules:
warning is never a fill and always carries a triangle icon and a text label, and the accent is never used to
mean "caution". Production hosts use `--danger`, not amber. The contrast script gains a hue-distance check
between the accent and warning tokens.

Terminal schemes stay independent (`features/terminal/schemes.ts`). Afterglow adds one bundled scheme,
"Afterglow Night" (bg `#141319`, fg `#E6E4EC`, cursor `#F7A440`, selection `rgb(247 164 64 / 0.28)`), set as
the default only in the experimental build.

### 4.2 Typography

- **UI: Geist Sans** (variable, `@fontsource-variable/geist` 5.3.0, OFL-1.1, Vercel). It is made for small
  UI sizes, has tabular figures (`tnum`), and its round terminals suit the rounded language. Subset to
  latin + latin-ext woff2 (about 60 KB) and self-host under `public/fonts/` (CSP `font-src 'self'` holds).
  **ADR 0013 note:** "Bundled font Geist Sans 1.x (OFL-1.1) for the experimental UI build only; licence
  text added to NOTICE; no runtime fetch."
- **Machine text and terminal: JetBrains Mono** (already bundled, OFL). Hosts, IPs, ports, paths,
  fingerprints, commands.
- Scale (px): 11 caption, 12 meta, 13 body, 14 row title, 16 section, 22 page title. Tracking by size:
  22 at `-0.02em`, 16 at `-0.011em`, 13 and 14 at `0`, 11 at `+0.01em`. Weights 400, 500 (titles), 600
  (page titles only). Sentence case everywhere, with no all-caps labels. Section headers are 13/500 muted.

### 4.3 Shape: radii (one documented rule, concentric)

| Token | px | Used on |
|---|---|---|
| `--r-sm` | 8 | buttons, inputs, menu items, nav pills, tab pills, kbd hints (6) |
| `--r-md` | 12 | 40px icon tiles, list rows (hover shape), chips, toasts |
| `--r-lg` | 16 | cards, popovers, menus, sheets, dialogs, theme preview cards, the content card |
| `--r-full` | 999 | switches, avatars, status dot, segmented thumb |

Rule: a child inside padded rounded parent gets `parent radius minus padding`. A 16px menu with 4px
padding has 12px items, overriding the 8 default. The window content card has 12px corners inside the
window chrome.

### 4.4 Elevation and depth (no heavy blur)

Five layers: window (`--bg-window`), content card (`--bg-canvas`, 1px `--border`, inset at 6px from the
window edge, so content reads as a lifted sheet like Arc), raised (`--bg-raised` + `--highlight` top inner
edge), overlay (`--bg-overlay` + shadow), modal (overlay + scrim `rgb(8 7 12 / 0.55)`).

Shadows are tinted to the violet hue, never black: `--shadow-pop: 0 1px 0 var(--highlight) inset,
0 12px 32px -8px rgb(6 4 14 / 0.55), 0 2px 6px rgb(6 4 14 / 0.35)`. Translucency is limited to popovers
and the toast deck: `background: color-mix(in oklab, var(--bg-overlay) 88%, transparent)` with
`backdrop-filter: blur(12px) saturate(140%)` on small surfaces only, never full-window. It falls back to
solid under `prefers-reduced-transparency` and on Linux WebKitGTK when frame timing shows cost.

### 4.5 Iconography

**Phosphor** (`@phosphor-icons/core` 2.1.1, MIT): Regular weight for UI glyphs at 16 and 18 px, Duotone for
the 40px tiles (duotone layer filled with `--accent-soft` or the vault tint). It is generated to inline SVG
by a sibling of `scripts/gen-icons.py` into `exp/ui/icons.tsx`, so nothing is fetched at run time. Main's
Lucide set stays untouched. OS logos reuse `features/hosts/OsIcon.tsx`, placed in a 40px tile with the
distro colour at 16% as the tile wash.

### 4.6 Density and spacing

4px grid: 2, 4, 8, 12, 16, 20, 24, 32, 48. Control height 32, nav pill 32, tab height 30 in a 40 title bar,
host row 56 (40 tile + 8+8), compact row 36 (toggle in Settings), sidebar 216 expanded / 60 rail, page
gutter 24, card padding 16, section gap 24. Hit targets are at least 32px on desktop and 24px minimum for
inline icon buttons with 4px padding.

## 5. Motion system

### 5.1 Library choice: a hybrid of Motion with CSS `linear()` springs

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| CSS `linear()` springs | Off main thread, zero runtime, works in WKWebView/WebView2/WebKitGTK current, interruptible as transitions | No velocity hand-off, no layout/FLIP, no exit for unmounting nodes, no gestures | **Use for** press, hover, popover enter, tooltips, toast deck |
| Motion (`motion` package) | Real springs with `visualDuration`/`bounce`, velocity carry, `layout`/`layoutId`, `AnimatePresence`, drag with momentum, `useReducedMotion`, can hand transforms to WAAPI | Main-thread for layout animations, about 34 KB gz full | **Use for** sheets, tabs, reorder, toasts swipe, connect morph, unlock |
| @react-spring/web 10.1.2 | Good physics | No first-class exit/layout story, extra concepts, smaller community | Rejected |

**Pick: `motion` 13.4.4** (MIT, published 2026-09-25, React peer `^18 || ^19`). It is pinned exact and
14.x (2026-10) is deliberately avoided until it has aged. Import `LazyMotion` + `m` with `domMax`
loaded lazily after unlock, which keeps the initial chunk around 5 KB and the full feature set at about
25 KB gz. Measure in M0 with `vite build --mode exp` and record the real numbers. The budget is at most
40 KB gz added to the exp build and **0 bytes** added to main's build. Springs in CSS are generated by
`scripts/exp/springs.mjs` from the same `{visualDuration, bounce}` table into `linear()` strings, so CSS and JS
springs share one source of truth. **ADR 0013 note:** "motion 13.4.4, MIT, experimental build only; reason:
interruptible springs, layout/exit animations, gesture velocity; alternatives CSS-only and react-spring
rejected; lockfile committed."

### 5.2 Spring table (Motion syntax; `vd` = visualDuration in s)

| Interaction | Config | Properties | Notes |
|---|---|---|---|
| Press (down) | CSS 90 ms `cubic-bezier(0.23,1,0.32,1)` | `scale(0.97)`; tiles `0.98` | on pointer-down via existing `lib/press.ts` |
| Press (release) | CSS `linear()` from `{vd .28, bounce .25}` | back to `scale(1)` | tiny overshoot is the "tactile" cue |
| Hover | CSS 120 ms `ease` | `background-color`, icon `color` only | no movement on rows (tens/day); gated `(hover:hover)` |
| Menus, popovers, select | enter `{vd .18, bounce 0}`, exit 110 ms ease-out | `opacity`, `scale(.96→1)`, origin = trigger | keyboard-opened: instant |
| Tooltips | 120 ms opacity, 500 ms first delay, 0 ms after one is open | `opacity` | |
| Sheets and side panels | enter `{vd .34, bounce .06}`; after a flick `{vd .34, bounce .15, velocity}`; exit `{vd .22, bounce 0}` | `transform: translateX(%)`, scrim `opacity` | drag uses Apple projection, d=0.998; rubber-band 0.55 |
| Tab switch: active pill | WAAPI 220 ms `cubic-bezier(0.77,0,0.175,1)` | pill `translateX` + `width` on one absolutely positioned, `contain: strict` element (documented exception: no children, no reflow) | CSS/WAAPI because it fires while a session attaches |
| Tab open/close: siblings' widths | Motion `layout` `{vd .24, bounce 0}`, labels `layout="position"` | FLIP (transform) | new tab enters `opacity 0, scale .96`; closing tab fades 100 ms then siblings close the gap together |
| List reorder (drag) | `{vd .28, bounce .12}`, drop carries velocity | FLIP transform | only visible window rows, cap 60, reuse `MAX_FLIP_ITEMS` logic |
| List reorder (sort, filter) | `{vd .22, bounce 0}` | FLIP + opacity | skipped if more than 60 rows move |
| Page change (sidebar) | incoming 140 ms ease-out | `opacity 0→1`, `translateY(4px→0)`; outgoing removed instantly | no crossfade overlap; keyboard: instant |
| Toasts (deck) | CSS transitions 360 ms `ease` (Sonner's elegance) | `transform`, `opacity` | deck spec in 7.4 |
| Connect flow | see 7.1 | | |
| Lock / unlock | see 7.6 | | |
| Error shake (unlock, form) | `{vd .4, bounce .55}` from `x: 6` | `transform: translateX` | reduced motion: red border only |

### 5.3 Rules

1. **Interruptible always.** Springs start from the presentation value. CSS uses transitions, never keyframes,
   for anything reversible. A leaving element becomes `inert` at once and never blocks input.
2. **Keyboard is instant.** Reuse `lib/inputModality.ts` (`data-opened-by="keyboard"`). The palette, quick
   connect, tab cycling (Ctrl+Tab and Cmd+1..9), page switching from shortcuts and closing with Esc have no
   motion. Raycast rule: the palette never animates, even from the mouse.
3. **Reduced motion = zero motion**, the agreed project rule in `docs/design/motion.md` §1.6, honoured for the
   OS setting and the in-app switch. Motion reads `motionAllowed()` from `lib/motion.ts`. The `MotionConfig
   reducedMotion="always"` root is set when it returns false, and CSS duration tokens collapse to 0 as today.
   Colour changes stay.
4. **Budget: 8 ms/frame (120 Hz).** Only `transform` and `opacity` animate, plus the two documented
   exceptions (tab pill width, one-shot `background-color` tints). Never `box-shadow`. Use
   `filter: drop-shadow` if a shadow must change. Animated blur stays under 8 px and only on elements smaller
   than 400×400.
5. **The terminal canvas is sacred.** No transition, animation, `will-change` or transform on `.terminal-host`
   or its descendants, and no opacity animation on the canvas either. Side panels overlay the terminal while
   they move and commit the new terminal width once, on settle, with a single fit. Chrome around the canvas
   may move.
6. **Motion springs on busy paths use `transform` strings** (hardware-accelerated) instead of `x`/`y`.
7. **Exit faster than enter**, along the same path it came in.

## 6. Signature moments

1. **Ignition (connect).** Pointer-initiated connect from a host tile (double-click or Enter-free click on
   "Connect"). (a) On pointer-down the tile presses to 0.98. (b) An amber progress stroke traces the tile's
   12px rounded border, as an SVG `rect` with `pathLength=1` and `stroke-dashoffset` stepping through four
   real stages from the existing connect events: resolve 25%, handshake 50%, auth 75%, shell 100%, each
   step a 260 ms ease-out transition. Stages follow real events and never fake progress. (c) The new tab
   enters the title bar from the tile's position (Motion `layoutId` from tile icon to tab icon,
   `{vd .32, bounce .1}`) while the terminal pane fades in at opacity only, 160 ms. (d) On the shell event the
   tab icon gets the afterglow (moment 2). Failure: the stroke turns `--danger`, retracts 200 ms, and the
   tile shakes once. Keyboard connect: no morph, instant tab, stroke still shown on the tab (status, not
   decoration).
2. **Afterglow ping.** When a background tab finishes a long command (existing `useCommandFinished`) or
   receives a bell, its tab gets an amber `--accent-soft` wash that fades 1 to 0 over 900 ms
   `cubic-bezier(0.23,1,0.32,1)`, then holds a 6px amber dot until visited. It runs once with no loop, using
   opacity on a pseudo-element.
3. **Liquid tabs.** The active-tab pill glides between tabs with a width change (5.2). Opening a tab makes
   all siblings compress together (FLIP), and closing one makes them re-expand together, so the strip never
   jumps. Drag-reorder tabs with momentum and a 0.55 rubber-band at the strip ends.
4. **Sheet physics.** The host details sheet slides from the right edge over a dimmed list. It tracks the
   pointer 1:1 with the grab offset respected (`setPointerCapture`). A flick (velocity at least 0.11 px/ms) or
   a projected end past 50% dismisses it, carrying the release velocity. Over-drag left rubber-bands. The
   list behind scales to 0.99 and dims (Vaul's background effect, subtle on desktop).
5. **The toast deck.** Sonner-like: bottom-right, three visible, front at full size, the ones behind at
   `translateY(-12px*i) scale(1 - .05*i)` and `opacity 1 - .2*i`. Hovering expands to a list with an 8px gap,
   with a pseudo-element bridging gaps so hover holds. Timers pause on hover and when the window is hidden.
   Swipe right dismisses on velocity at least 0.11 px/ms or 48 px. Enter from `translateY(100%)`, exit the same
   way. The copy keeps verb consistency ("Copied", "Saved", "Disconnected").
6. **Unlock rise.** Wrong password: the field shakes (`{vd .4, bounce .55}`) and the message appears below.
   Correct: the lock card scales to 0.98 and fades (180 ms), the app shell rises from `scale(.985)
   opacity 0` with `{vd .42, bounce .08}`, and sidebar items stagger in at 30 ms steps (the first unlock of a
   session only, the delight tier). Lock (idle or Cmd+L): instant scrim to opaque, because security beats
   motion, then the lock card rises 200 ms. Secrets never render underneath during the fade: content is
   unmounted before the scrim fades in, exactly as main does today.
7. **Theme cards with live preview.** In the terminal side panel, rounded 16px preview cards render a tiny
   static ANSI sample (DOM, not xterm). Hovering for 150 ms applies the scheme to the live terminal
   instantly (no canvas animation) and leaving reverts it. Selecting springs a check badge in
   (`scale .9→1`, `{vd .2, bounce .3}`).

## 7. Screen-by-screen design

### 7.1 App shell

The title bar (40px, `--bg-window`, drag region) holds the traffic lights or native controls, then the tab
strip: rounded 8px tab pills 30px tall with a coloured OS icon, a label and a close that appears on
hover/focus. A "+" opens the new-tab page. The sidebar (216px, `--bg-window`) has the wordmark, search
(Cmd+K hint), nav pills (Hosts, Keychain, Port forwarding, Snippets, Known hosts, History), then a spacer
and Settings plus the vault lock button. It collapses to a 60px rail with tooltips and accessible names
kept. Content sits in a rounded 12px card. The status bar becomes a 28px strip inside the card bottom
(keeps `.statusbar`).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●   ╭ ◐ web-01 ✕╮ ╭ ◆ db-prod ╮ ╭ ◇ ci-runner ╮  +              ⌘K  ◔   │ 40px
├────────────┬─────────────────────────────────────────────────────────────────┤
│ Tyrminal   │╭───────────────────────────────────────────────────────────────╮│
│ ⌕ Search ⌘K││  page content (rounded card, --bg-canvas)                     ││
│            ││                                                               ││
│ ▣ Hosts    ││                                                               ││
│ ⚿ Keychain ││                                                               ││
│ ⇄ Forwards ││                                                               ││
│ ❯ Snippets ││                                                               ││
│ ✓ Known    ││                                                               ││
│ ⟲ History  ││                                                               ││
│            │├───────────────────────────────────────────────────────────────┤│
│ ⚙ Settings ││ statusbar 28px                                                ││
│ 🔒 Lock    │╰───────────────────────────────────────────────────────────────╯│
└────────────┴─────────────────────────────────────────────────────────────────┘
```
The active nav pill is an `--accent-soft` fill with `--accent-text` icon, and a shared pill glides between
items (CSS transform, 180 ms) on pointer clicks only.

### 7.2 Hosts

Top row: a page title (22/600) and inline host count (muted), then a full-width rounded search field (36px,
`--r-sm`, Cmd+F). The toolbar row has icon+label ghost buttons (New host, Import, Discover, Quick connect)
and a right-aligned view toggle (list / grid). Sections are Groups (horizontal scroll of 40px tiles with a
tint wash) and Hosts (rows: 40px tile with OS icon, title 14/500, subtitle `user@host:port` in mono 12
muted, trailing tags plus a prod tag in `--danger` and a hover "Connect" pill). The empty state reads
"Add your first host" with New host and Import buttons. Loading uses skeleton rows of the same shape.
Windowing stays (`useWindowedList`).

```
│ Hosts  38                                              [≡ list | ▦ grid] │
│ ╭─ ⌕  Search hosts, tags, addresses ───────────────────────────────╮  ⌘F │
│ [＋ New host] [⇩ Import] [◎ Discover] [⚡ Quick connect]                  │
│ Groups                                                                   │
│ ╭────╮ Production 6   ╭────╮ Staging 9   ╭────╮ Lab 4                    │
│ ╰────╯                ╰────╯             ╰────╯                          │
│ Hosts                                                                    │
│ ╭────╮ web-01                        ubuntu  edge          ( Connect )   │
│ ╰────╯ deploy@10.0.4.21:22                                               │
│ ╭────╮ db-prod                       debian  [prod]                      │
│ ╰────╯ admin@db.internal:2222                                            │
```

### 7.3 Host details sheet

A right sheet of 440px (`--r-lg` on the left corners), using the existing `HostPanel` + `hostForm` logic
and autosave. The header has the tile, the name (editable inline) and a primary "Connect" amber button. It
has segmented sections (General, Auth, Advanced, Startup) with a sliding thumb. Fields use labels above
inputs and errors below. Dismissal is by Esc (instant), the scrim, or a drag (moment 4).

### 7.4 New-tab page (replaces the empty tab)

A centred column of max 640px. A large search field ("Connect to…", focus on open) searches hosts and
`user@host` quick-connect parsing (existing `lib/quickConnect.ts`). Below it sit "Recent" as six 40px tiles
in a 3x2 grid, "Pinned snippets", and "Local shell". The first open of the day staggers tiles at 30 ms;
afterwards there is no motion.

### 7.5 Quick connect

The existing `QuickConnectDialog` is restyled as a 560px palette-style rounded 16px overlay. It opens
instantly, has inline validation, and Enter connects.

### 7.6 Terminal with side panel

The terminal fills the card with zero radius on the canvas itself; the card's 12px corners clip with
`overflow:hidden` on the wrapper, not the canvas. The right side panel (320px) has tabs for Theme,
Snippets, Glance, Notes and Files. It overlays during the motion and docks after settle (5.3 rule 5).

```
│╭──────────────────────────────────────────────────┬─────────────────────╮│
││ deploy@web-01:~$ systemctl status nginx          │ Theme  Snip  Glance ││
││ ● nginx.service - A high performance web server  │ ╭───────╮╭───────╮  ││
││    Active: active (running)                      │ │Aftrglw││Paper  │  ││
││                                                  │ │▇▇▇▇ ✓ ││▇▇▇▇   │  ││
││ deploy@web-01:~$ █                               │ ╰───────╯╰───────╯  ││
││                                                  │ Font  JetBrains Mono││
││                                                  │ Size  14   ─●────   ││
│╰──────────────────────────────────────────────────┴─────────────────────╯│
```

### 7.7 SFTP

A two-pane layout (local | remote) inside the card, each a rounded 16px card with a path bar of breadcrumb
chips and a dense 32px table. The transfer drawer is a bottom sheet with a progress bar on `scaleX`,
transitioned 200 ms so IPC ticks glide. Drop targets get an amber 2px dashed inner outline.

### 7.8 Keychain

Sections Keys, Identities and Certificates use the same 40px tile rows (key icon duotone, subtitle
`ed25519 · SHA256:ab12…` in mono). The details sheet is the same component as the host sheet. Secrets
render through the existing `LiveSecret` with no new reveal animation and no copy of secrets into the DOM
beyond today's.

### 7.9 Snippets

A two-column layout: a list (tiles with a `❯` glyph and the first line of the command in mono) and an
editor card. Run uses the existing review dialogs (`SnippetRunDialog`, `MultiRunDialog`) restyled.

### 7.10 Settings

A left inner nav of rounded pills with the glide indicator. Content is grouped cards of 44px setting rows
with the label and a hint under it. Appearance gains the theme cards from 7.6 and a density toggle.

### 7.11 Unlock and onboarding

A centred 400px card on the window background with a soft amber radial glow behind it at 6% (a static
gradient, no loop). Onboarding uses three steps with a real sequence (Create vault, Save recovery key,
Done), where a numbered stepper is justified. The recovery-key words stagger at 30 ms, reusing main's
existing stagger.

## 8. Architecture: isolation and rebase-friendliness

Goal: main's UI is untouched, the experimental build reuses every hook, IPC call and feature module, and
rebasing onto main conflicts only in new files.

1. **Build-time switch, not a Preferences field.** `TYRMINAL_UI=experimental` (scripts `pnpm dev:exp`,
   `pnpm build:exp`, `pnpm build:e2e:exp`). Adding `ui` to `Preferences` would change `crates/contracts`,
   the Rust core and generated TS, which means more conflicts and touching security-reviewed code. Main's
   bundle contains zero experimental bytes. A runtime switch in Settings can come later only if the owner
   wants to adopt it (M7).
2. **Module swapping through one Vite plugin.** `apps/desktop/vite.exp.ts` exports `expSwap()`, which maps a
   whitelist of resolved module ids to replacements under `src/exp/`, for example
   `components/layout/Sidebar.tsx → exp/layout/Sidebar.tsx`, plus `TabStrip`, `StatusBar`,
   `components/ui/Toasts`, `Dialog`, `Menu`, `features/hosts/HostsView`, and so on. Replacements export the
   same names and props. Type parity is enforced by `exp/parity.ts`:
   `export const _s: typeof import("../components/layout/Sidebar").Sidebar = ExpSidebar;` so `pnpm typecheck`
   fails when main changes a signature. The only edit to an existing main file is one conditional line in
   `vite.config.ts` (`plugins: [react(), ...(exp ? [expSwap()] : [])]`).
3. **Styles.** `exp/styles/{tokens,base,motion,components}.css` are imported by `exp/entry.css`, which
   the plugin injects. `styles/global.css` still loads first. Afterglow is wrapped in `@layer afterglow` and
   scoped under `:root[data-ui="afterglow"]` so it wins without `!important`. Existing hooks the tests rely on
   stay intact: roles, accessible names, `.statusbar`, `.terminal-pane`, `.terminal-host`, `.tab-layout`,
   `.pane[data-focused]`, `nav.sidebar [data-nav]`, `dialog.palette`, `[data-testid]`.
4. **Logic reuse.** `app/AppShell.tsx` (1,500 lines) is **not** forked. It keeps orchestrating workspace,
   tabs, panes and dialogs, and only the presentational leaves it imports are swapped. When a screen needs
   new structure (the new-tab page), it is added as a swapped leaf, not by editing AppShell. If a seam is
   unavoidable, it is proposed as a small, neutral PR to main first (for example exporting a hook), so the
   branch never carries AppShell diffs.
5. **Dependencies are experimental-only.** `motion`, `@fontsource-variable/geist` (or vendored woff2) and
   `@phosphor-icons/core` (build-time icon generation only) go in `apps/desktop` devDependencies or are
   referenced only from `src/exp/`. `scripts/check-release.mjs` gains an assertion that the main build's
   output contains no `motion` code and no Geist font. ADR `docs/decisions/0013-experimental-ui.md` records
   versions, licences, reasons and NOTICE updates. Lockfile committed.
6. **Security rules unchanged.** CSP is unchanged (fonts are self-hosted and Motion needs no `eval`; it uses
   inline styles, already allowed). No new IPC, capabilities or permissions. Secrets never go into
   animation state, `layoutId` keys, data attributes or logs (keys use host IDs, never addresses with
   credentials). Lock blanks content before any fade. No plaintext fallback. Domain, vault, ssh and storage
   crates are untouched.

## 9. Delivery plan (branch `claude/experimental-ui`)

Each milestone is a small commit series ending in a runnable `pnpm dev:exp`, with screenshots in
`docs/design/afterglow/`.

| M | Commits | Visible at the end |
|---|---|---|
| **M0 Switch + skin (first visible, about 1 day)** | `vite.exp.ts` swap plugin with an empty whitelist; `exp/styles/tokens.css` (palette, radii, type), Geist bundled, `data-ui="afterglow"`; CSS-only reskin of existing classes (rounded 8/12/16, pills, tiles, content card, title-bar tab pills); Afterglow Night scheme; ADR 0013 draft; bundle measurement | The **whole app already looks new**: amber on violet-graphite, rounded everything, Geist, and the terminal in the new scheme. No behaviour change. |
| **M1 Press, hover, popovers** | `springs.mjs` generating `linear()` tokens; press and release spring on every pressable; origin-aware menus and popovers; tooltip instant-after-first; Phosphor icon generation | Every click feels tactile; menus pop from their trigger. |
| **M2 Shell chrome** | Swapped `Sidebar` (glide pill, rail collapse), `TabStrip` (liquid tabs, FLIP widths, drag reorder), `StatusBar` inside the card; Motion added (LazyMotion) | Moments 3 and 2 work. |
| **M3 Hosts + sheet** | Swapped `HostsView` (sections, tiles, skeleton, empty state), host details sheet with drag physics, list FLIP | Moment 4 works. Hosts looks like the wireframe. |
| **M4 Connect + toasts** | Ignition stroke wired to real connect stages, tile-to-tab `layoutId`, swapped `Toasts` deck | Moments 1 and 5 work. |
| **M5 New tab, quick connect, terminal panel** | New-tab page, quick connect restyle, side panel overlay-then-dock, theme cards | Moment 7 works. |
| **M6 Remaining screens** | SFTP, Keychain, Snippets, Settings, Known hosts, History, unlock and onboarding (moment 6), light theme pass | The full app is covered in dark and light. |
| **M7 Hardening + review** | Perf traces, contrast, a11y sweep, screenshot set, a comparison doc for the owner; optional runtime switch proposal | Owner review build (`pnpm build:exp`, unsigned). |

Each milestone runs `pnpm verify:fast` and `pnpm test:ui` with the flag, and updates `docs/progress.md` on
the branch. No push or publish happens without the owner's instruction, and the branch never merges to main
without explicit approval.

## 10. Testing

1. **Functional parity.** `tests/ui/*.spec.ts` (87 files, role-based) must pass against the exp build:
   add a `UI=experimental` project to the Playwright config that builds with `TYRMINAL_UI=experimental`.
   Visual baselines live in a separate folder (`__screenshots__/afterglow/`) so main's baselines never
   change. `pnpm test:native` (WebDriver, real app) runs against `build:e2e:exp` before M7. Tests are never
   weakened. If a selector depends on main's DOM, the exp component reproduces the hook rather than the test
   being edited.
2. **Motion specs** (`tests/ui/afterglow-motion.spec.ts`, UI-only mocks allowed): (a) with
   `reducedMotion: 'reduce'` and with the in-app switch, `document.getAnimations()` is empty after each
   interaction and every computed `transition-duration` is 0; (b) a keyboard-opened palette, menu or tab
   switch produces no animations; (c) every running animation's animated properties are a subset of
   {transform, opacity, background-color, stroke-dashoffset, width on `.tab-pill-indicator`}; (d) nothing
   animates under `.terminal-host` (walk `getAnimations({subtree:true})` targets); (e) interruptibility:
   open a sheet, close it at 50%, and the transform reverses without a jump (sampled transform monotonic, no
   reset to start); (f) an exit makes the node `inert` within the same frame.
3. **Performance budget** (`tests/performance/afterglow-frames.mjs`): a CDP trace on Chromium plus WebKit
   frame timing for the tab open/close storm (20 tabs), the sheet drag, the toast burst (10 in 1 s), connect
   with output streaming, and a 2,000-host list scroll. Pass when p95 frame time is at most 8.3 ms on a
   dev machine at 4x CPU throttle, there are no long tasks over 50 ms caused by animation, and layout count
   during the tab pill animation is at most 1 per frame. Also: initial exp JS chunk at most main + 10 KB gz,
   full Motion chunk at most 40 KB gz, Geist at most 80 KB. A real mid-range laptop recording on Windows
   (WebView2) and Linux (WebKitGTK) is needed before claiming smooth; until then it is marked
   IMPLEMENTED_UNVERIFIED.
4. **Contrast and a11y.** `pnpm check:contrast` is extended with the Afterglow token sets (dark and light,
   AA) and the accent/warning hue check. Focus rings are a 2px `--accent` ring with 2px offset at 3:1 or
   better. The axe pass in `accessibility.spec.ts` runs in both themes.
5. **Matrix.** The experimental UI gets its own `feature-matrix.csv` rows (DEFERRED_BY_SCOPE on main,
   IN_PROGRESS on the branch) and never claims VERIFIED from mocked UI tests.

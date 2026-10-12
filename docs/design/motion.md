# Tyrminal motion plan: making the app feel alive

Audited at `origin/main` `04b67e87`, read-only. Builds on `docs/design/overhaul.md` §1.3 and §4, and
`docs/design/interaction-polish.md` §4. Paths are relative to `apps/desktop/src/` unless they start with `tests/` or `docs/`.

## 0. Why it feels dead (diagnosis)

1. **The agreed motion system was never switched on.** `styles/next/motion.css` (the `.m-*` utilities)
   is not imported anywhere. `global.css` still uses the old keyframes that overhaul §1.3 marked for
   removal: `page-in` on every navigation (`global.css:1634`), the palette `dialog-in` (`:1973`), the
   sidebar `grid-template-columns` transition (`:1290`), and `panel-in` keyframes (`:1783`, `:3945`).
   So the app spends motion on the things that should be still, and has none where it would help.
2. **Nothing leaves.** Every surface unmounts on the spot: toasts (`components/ui/Toasts.tsx:26`),
   the host panel, side panels, menus, the bulk bar, the transfer drawer and the connection sheet.
   An entrance with no exit reads as a glitch, not as life.
3. **Nothing moves when things change place.** When a tab closes or is reordered, a host is added or
   deleted, a toast stacks, or the current page changes in the sidebar or Settings nav, the
   content teleports. This is the biggest "dead" signal in a desktop app.
4. **Progress jumps.** The transfer bar sets `scaleX()` with no transition (`features/files/TransferDrawer.tsx:98`,
   `features/files/files.css:615`), so it steps from one IPC tick to the next.
5. **Feedback gaps.** Only `.btn` has press feedback. Tabs, nav items, chips, tiles, host cards and status
   buttons give nothing on pointer-down. Tooltips wait 450 ms every time, even when another
   tooltip is already showing (`global.css:3002`).

What is already right: the token values (`styles/tokens.css:89-96`), the reduced-motion zeroing
(`tokens.css:383-397`, `[data-reduce-motion]`), the recovery-key stagger (`global.css:2877`), the
spinner and pulse stopping under reduced motion, and the files table's instant press tint.

## 1. Principles

1. **Answer the pointer, never the keyboard.** Motion confirms what the hand did. Anything opened,
   switched or closed from the keyboard is instant. This is enforced with a global input-modality
   attribute (PR 1).
2. **Things that move between places glide; things that appear rise; things that leave fade.**
   Glides use `--ease-in-out` at 180 ms. Entrances use `--ease-out` at 140–220 ms with a 2–8 px offset
   or `scale(0.97)`. Exits fade only, at 100 ms.
3. **Transform and opacity only.** The one exception is `background-color` for one-shot tints, which
   the browser composites. `width`, `height`, `grid-template-*`, `top`/`left` and `box-shadow` are never
   animated.
4. **Interruptible by construction.** Use CSS transitions with `@starting-style` and WAAPI that starts
   from the on-screen position. Never use keyframes for anything reversible. Input is never blocked:
   a leaving element is `inert` at once.
5. **The terminal canvas is sacred.** No transition, animation or `will-change` on `.terminal-host` or its
   descendants. Overlays inside `.terminal-pane` (the connection sheet, banners, the find bar) may move.
6. **Reduced motion means zero motion.** This holds for the OS setting and for the in-app switch. It
   is the agreed rule and stricter than the "gentler, not none" default, and it is kept here. Every duration
   token becomes 0, and JS motion reads the token and skips.
7. **Life comes from many small, correct answers,** not from big motion. No bounce, parallax, loops or
   page transitions. The one optional loosening is in §2.
8. **Resting pixels never change.** Every proposal below leaves the settled state identical, so the
   reduced-motion screenshot baselines stay valid and nothing is re-recorded.

### As built (2026-10-12)

What shipped differs from the plan in a few places, on the owner's word or after review:

- **Tab strip width (owner).** Tabs animate their width when one opens or closes: the old tab
  shrinks while the new one grows, in sync (one `width`/`min-width` transition, `--duration-glide`,
  `--ease-in-out`, pointer only via `html[data-input="pointer"]`, none under the keyboard or reduced
  motion). It is the one exception to principle 3, and there are no FLIP transforms on tabs.
- **Host details panel.** Opened by a click, the list takes its narrower width at once and the
  cards that move glide there (FLIP), while the panel's content slides in 16 px and fades;
  switching hosts only crossfades the content; closing fades an inert copy. Its width is not
  animated: that would reflow the host grid every frame and make cards jump between column counts.
- **Exits** are static, inert copies (`lib/exitGhost.ts`) rather than kept-mounted elements
  (`usePresence`), so no component needs a leaving state; a lock removes them before they paint.
- **Calmer lists (owner: "motion 3 looks bad").** The arrival stagger is opacity only, 6 rows,
  `--stagger` 20 ms; rows glide only for small changes (two or fewer rows added or removed), and a
  re-filter snaps; glides are 140 ms on `--ease-out`.
- **No spring** (owner), no Home stagger (Home was removed), connection-step checks in the
  connection sheet's own track.

## 2. Motion tokens (add to `styles/tokens.css`)

Add these after line 96, inside the existing `:root` motion block. Keep the existing tokens.

```css
  /* ---------- motion, second pass (docs/design/motion-plan) ---------- */
  --duration-exit: 100ms;      /* every exit: fade only, faster than any entrance */
  --duration-glide: 180ms;     /* something moving to a new place: FLIP, nav/tab glide */
  --duration-progress: 200ms;  /* progress bars retargeting between ticks (linear) */
  --duration-flash: 400ms;     /* one-shot "this changed" tint (autosave, just added) */
  --stagger: 30ms;             /* per item; cap at 8 items (≈210 ms total) */
  --distance-xs: 2px;          /* disclosure, tooltips */
  --distance-sm: 4px;          /* menus, rows entering */
  --distance-md: 8px;          /* panels, toasts, dialogs */
  --scale-enter: 0.97;         /* popovers, tabs, check marks entering */
  --scale-press: 0.98;         /* buttons, chips, tabs, nav items while pressed */
  --scale-press-card: 0.99;    /* host cards, tiles: bigger surfaces give less */
  --ease-linear: linear;       /* progress only */
  /* Optional, owner sign-off needed (see "Loosening" below): a spring with 2.8 % overshoot. */
  --duration-spring: 260ms;
  --ease-spring-soft: linear(0, 0.05, 0.167, 0.314, 0.465, 0.604, 0.723, 0.82, 0.894, 0.948, 0.985,
    1.008, 1.021, 1.027, 1.028, 1.026, 1.023, 1.018, 1.014, 1.01, 1.007, 1.005, 1.003, 1.001, 1);
```

In **both** reduced-motion blocks (`@media (prefers-reduced-motion: reduce) :root` and
`:root[data-reduce-motion="true"]`), add:

```css
    --duration-exit: 0ms; --duration-glide: 0ms; --duration-progress: 0ms; --duration-flash: 0ms;
    --duration-spring: 0ms; --stagger: 0ms;
    --distance-xs: 0px; --distance-sm: 0px; --distance-md: 0px;
    --scale-enter: 1; --scale-press: 1; --scale-press-card: 1;
```

Delete the duplicate `:root` and reduced-motion token blocks at the top of `styles/next/motion.css`,
because the tokens live in `tokens.css` only. Leave the old aliases (`--motion-*`, `--ease-spring`) until PR 1
has migrated every use, then remove them in the same PR.

**Loosening (optional, one rule).** `--ease-spring-soft` is a critically under-damped spring (ζ = 0.75,
settles inside its 260 ms) sampled into CSS `linear()`. It needs no library. Use it only for the switch
thumb (16 px travel, so the overshoot is 0.4 px) and the nav/tab glide (about 3 px on a 120 px move).
**Reason:** these are small, pointer-initiated state changes, and a hint of mass is what makes macOS
and iOS controls feel physical. It is 40 ms over the 220 ms ceiling and a mild breach of "no bounce", so it
needs the owner's yes. Without sign-off, use `--ease-in-out` at `--duration-glide`. Browsers without
`linear()` (WebKitGTK < 2.42) ignore the declaration, so declare `--ease-in-out` first as the fallback.

No new dependency. CSS, `@starting-style` and WAAPI cover everything. Motion/Framer Motion
(MIT, ~30 KB) was considered for presence and layout animations, and two small hooks (about 150 lines) do the
same job with no main-thread rAF and no ADR.

## 3. Surface audit

Legend: **E** entrance, **X** exit, **G** glide (FLIP). "RM" is the reduced-motion result. In every row
it is instant, because the tokens go to 0.

| Surface | Today | Proposed motion (exact) | Interruption |
|---|---|---|---|
| Buttons `.btn` | `translateY(.5px) scale(.985)` at 100 ms, plus a `box-shadow` transition | Keep the press. Drop `box-shadow` from the transition list (paint) | transition, retargets |
| Tabs, nav items, chips, status buttons, icon buttons | colour only | `:active` → `scale(var(--scale-press))`, `transform var(--duration-press) var(--ease-out)`. Release uses the same 100 ms | transition |
| Host cards, Home tiles | hover `translateY(-1px)` + shadow (`global.css:2174`) | Remove the hover lift and shadow, as agreed in overhaul (colour only). Add `:active` `scale(var(--scale-press-card))`, 100 ms. On **double-click to connect**, add `data-launching` for one `--duration-glide`, which tints the border to `--accent` (background-color/border-color, `--ease-colour`) | transition |
| Sidebar collapse | `grid-template-columns` transition (layout, reflows the terminal) | **Instant** (agreed). Expanding, `.nav-label` fades from opacity 0, `--duration-fast`, `--ease-out`, via `@starting-style` | n/a |
| Sidebar current page | 3 px bar `::before` jumps | **G** a `.nav-glide` bar `translateY(Δ)` from the old item to the new one, `--duration-glide` `--ease-in-out` (or `--ease-spring-soft` at `--duration-spring`). Pointer only. The item's own `::before` is hidden while gliding, so the resting pixels are unchanged | WAAPI from the presentation value |
| Sidebar session list | rows pop in and out | **E** row `@starting-style` opacity 0, `translateX(calc(-1*var(--distance-sm)))`, `--duration-fast`. **G** FLIP siblings on close or reorder | transition and FLIP |
| Page change | `page-in` 180 ms on every navigation | **Remove** (agreed: tens per hour, makes navigation feel slower). The sidebar glide carries the life | n/a |
| Tab strip: open | appears | **E** `.tab` `@starting-style { opacity:0; transform: scale(var(--scale-enter)) }`, `transform-origin: left bottom`, `--duration-fast` `--ease-out`. Pointer and keyboard both (a new tab is a creation, not navigation, and the tab still works from frame 0) | transition |
| Tab strip: close | vanishes, and the tabs to the right jump left | **X** none (the closed tab owns a session, so it goes at once). **G** the remaining tabs FLIP `translateX(Δ)` to their new place, `--duration-glide` `--ease-in-out`. Skipped when closed from the keyboard (Ctrl+W) | FLIP retargets |
| Tab strip: reorder | drop line, then a jump | **G** the moved tab and its displaced siblings FLIP, `--duration-glide`. Keyboard reorder is instant | FLIP |
| Tab strip: active tab | background swaps | **G** pointer clicks only: a transient `.tab-glide` (same fill and border as the selected tab) translates from the old tab to the new one, `--duration-glide`. The new tab's own fill is hidden while gliding. **Never** on Ctrl+Tab or Ctrl+1–9 | WAAPI; a new click retargets from the presentation value |
| Panes and splits | instant; focus ring `box-shadow` 100 ms; unfocused terminal opacity 0.86 | **No change.** Terminal resize and dividers never animate (agreed). Move the `.terminal-host` opacity transition off the canvas: put the 0.86 dim on a `::after` scrim over the pane instead (opacity on the overlay, not the WebGL canvas) | n/a |
| Home | `page-in` | First render after **unlock only** (rare tier, delight): the `.tile-grid > *` children get `@starting-style` opacity 0, `translateY(var(--distance-sm))`, `transition-delay: calc(min(var(--i),7) * var(--stagger))`, `--duration-base`. Later visits are instant (`data-first` set once per unlock) | transition; clicks are never blocked |
| Hosts grid/list: add, delete, import, bulk move | teleports | **E** a new row or card `@starting-style` opacity 0, `scale(var(--scale-enter))`, `--duration-base`, plus a `--duration-flash` accent-soft tint. **X** fade `--duration-exit`. **G** siblings FLIP `--duration-glide`. **Not** on search or filter keystrokes (typing is 100+/day) | FLIP |
| Hosts multi-select | checkbox fades in on hover; bulk bar pops and pushes the list down | Checkbox fine. Bulk bar **E** opacity 0, `translateY(calc(-1*var(--distance-sm)))`, `--duration-fast`; **X** fade `--duration-exit`. The list under it FLIPs instead of jumping. A selected card gets `border-color` `--ease-colour` 100 ms | transition and FLIP |
| Group chips | colour 100 ms | Add press scale. A new group chip **E**s like a row. The nested chip reveal uses `.m-reveal` (opacity, `translateY(-2px)`, 140 ms) | transition |
| Host details panel | `panel-in` keyframes 140 ms, no exit | **E** `.m-panel`: opacity, `translateX(var(--distance-md))`, `--duration-base` `--ease-drawer`. **X** fade plus `translateX(var(--distance-sm))`, `--duration-exit`, kept mounted by `usePresence`. The list reflows at once (no width animation) | transition; reopening mid-exit retargets |
| Side panels (Files, Snippets, Connection, Glance) | `panel-in` keyframes 180 ms, no exit | Same as the host panel | same |
| Dialogs | `dialog-in` keyframes 180 ms; backdrop blur | `dialog.m-dialog`: opacity, `scale(.98) translateY(4px)`, `--duration-base`; drop the backdrop blur (agreed). No exit (native dialogs close at once, which is fine) | transition |
| Menus | `menu-in` from center, 140 ms | `.m-pop` with `--origin` set by `Menu.tsx` to the real corner: `top right` when anchored, `bottom right` when flipped above, `top left` at a point. `--duration-fast`. **X** fade `--duration-exit`. Keyboard-opened: none | transition |
| Command palette | `dialog-in` | **None** when opened from the keyboard (agreed, the Raycast rule). From the sidebar search click: `.m-dialog` at `--duration-fast` | n/a |
| Tooltips | 450 ms delay, then 100 ms fade and 2 px move, every time | `.m-tip`: opacity only, `--duration-fast`. Once any tooltip has shown, others open with **0 delay and 0 duration** for 600 ms after the last one hides (`:root[data-tips-warm]`) | transition |
| Toasts | `toast-in` keyframes; removed at once; stack jumps | **E** `.m-toast`: opacity, `translateY(var(--distance-md))`, `--duration-slow` `--ease-out`, rising from the status-bar edge. **X** opacity `--duration-exit`. **G** remaining toasts FLIP down `--duration-glide`. Hover pauses the 4.5 s timer | transitions and FLIP |
| Connection sheet | all steps rendered; the marker swaps | Steps stay still (agreed: no idle motion). On a step turning done, the check icon **E**s at `scale(var(--scale-enter))` and opacity, `--duration-fast`, and `.connect-time` fades in. On connect the sheet **X**s with an opacity fade at `--duration-fast` (agreed) while the shell is already live underneath, so input is never delayed. Failure and host-key-changed states are still | transition |
| SFTP panes, file table | instant press tint (correct) | **No change** to rows (folder navigation is keyboard-heavy and 100+/day) | n/a |
| Transfer drawer | mounts at once; bar steps | **E** `.xfer` opacity, `translateY(var(--distance-md))`, `--duration-base`. The list toggle uses `.m-reveal` and the chevron `rotate` at `--duration-fast`. Bar `transition: transform var(--duration-progress) var(--ease-linear)`. A finished row: the icon colour goes to `--success` at `--duration-base` plus one `--duration-flash` tint. **X** when emptied: fade `--duration-exit` | the bar transition retargets each tick |
| Keychain, known hosts, identities | rows pop | Same list recipe as hosts (E, X, G, plus the flash on add). Deleting a trusted host key: fade only, no glide delay before the list settles | FLIP |
| Settings nav | `aria-current` jumps; `scrollIntoView({behavior:"smooth"})` ignores the in-app switch | **G** the nav glide, same as the sidebar. Smooth scroll only when motion is allowed (read `--duration-base` > 0), else `"auto"` | WAAPI |
| Toggles `.switch` | thumb 140 ms `--ease-spring`(= ease-out) | Thumb `--duration-spring` `--ease-spring-soft` if signed off, else unchanged. Track colour `--ease-colour` | transition |
| Vault unlock | wrong passphrase only changes text | Error: `.auth-card` `@keyframes auth-shake` `translateX` 0 → -6 → 5 → -3 → 0 px, 220 ms `--ease-out`, once per failed attempt (restarting is right, since each failure is a new event). Success: `.shell` `@starting-style` opacity 0, `--duration-slow` (once per unlock) | keyframes, deliberately |
| Onboarding | recovery-key stagger (good); steps are static | Keep. Moving from step 1 to step 2: the card body **E**s opacity plus `translateX(var(--distance-md))`, `--duration-base` (rare tier) | transition |
| Status bar | dot colours swap | `.status-dot` `background-color` and `box-shadow` → `background-color` only, `--duration-base` `--ease-colour`. The broadcast item **E**s with opacity at `--duration-fast`. Numbers never animate | transition |

### Rejected (and why)

- **Page transitions, the palette from the keyboard, Ctrl+Tab and pane-focus moves**: keyboard or high
  frequency. The Raycast rule.
- **Height animation for the bulk bar, groups and drawer**: layout, and it reflows the terminal. FLIP and fades instead.
- **Split and pane resize animation**: the terminal reflows per frame and xterm `fit()` would run
  per frame. Agreed "never".
- **Shimmer and skeleton sweeps, idle breathing on anything but connecting**: paint every frame, and idle motion.
- **The card-to-tab "shared element" ghost on double-click**: View Transitions snapshot the WebGL canvas,
  WebKitGTK support is patchy, and it is tens per day. The border tint plus the tab grow-in tell the same story.
- **Hover lift on host cards**: tens of times an hour. Colour only (agreed).

## 4. Priority (leverage = "alive" gained ÷ effort)

| P | Item | Effort | PR |
|---|---|---|---|
| P0 | Switch on the motion system: import the `.m-*` utilities, convert the keyframes to `@starting-style` transitions, delete `page-in`, the palette animation and the sidebar width transition; fix the menu origin | S | 1 |
| P0 | Exits everywhere (`usePresence`): toasts, panels, menus, bulk bar, drawer, connection sheet | M | 2 |
| P0 | FLIP on tabs (close and reorder) and on toasts stacking | M | 3 |
| P0 | Transfer bar transition (one line) | XS | 1 |
| P1 | Press feedback on every pressable (tabs, nav, chips, cards, tiles, status buttons) | XS | 1 |
| P1 | Nav glide (sidebar, Settings) and the pointer-only tab glide | M | 3 |
| P1 | List FLIP plus the flash for hosts, keychain, known hosts and the sidebar sessions | M | 3 |
| P1 | Tooltip warm-up (instant after the first) | S | 1 |
| P2 | Moments: unlock shake and shell fade, onboarding step, Home first-load stagger, connection step checks, the double-click launch tint, the autosave flash (after the autosave PR lands) | M | 4 |
| P2 | Spring token for the switch and glides (needs owner sign-off) | XS | 4 |

## 5. Implementation PRs

Every PR follows the same rules:
- Change only the listed files.
- Do not change resting styles (colours, sizes, positions), so the screenshot baselines must pass
  unchanged, and re-recording is forbidden.
- `pnpm verify:fast` and `pnpm test:ui` must pass.
- Update `docs/design/overhaul.md` §4 tables when a row changes.

### PR 1: "Motion foundation" (P0 and P1 CSS-only wins)

**Files.**
- `styles/tokens.css` (the §2 tokens).
- `styles/next/motion.css`: move it to `styles/motion.css` and import it from `global.css` after
  `tokens.css`.
- `styles/global.css`, `features/files/files.css`.
- `components/ui/Menu.tsx`, `components/ui/Dialog.tsx`, `features/palette/CommandPalette.tsx`.
- `features/settings/SettingsViews.tsx`.
- New `lib/inputModality.ts`, wired once in `main.tsx`.
- New `tests/ui/motion.spec.ts`.

**Steps.**
1. In `motion.css`, delete the `:root` and reduced-motion token blocks (now duplicated). Change the
   terminal guard from `.terminal-pane, .terminal-pane *` to `.terminal-host, .terminal-host *`.
   Otherwise it disables the connection sheet, banner and find bar, which live inside `.terminal-pane`
   (`features/terminal/TerminalView.tsx:465-520`). Keep `transition: none !important` and add
   `animation: none !important` except for xterm's cursor blink: exclude `.xterm-cursor-blink`.
2. `lib/inputModality.ts` (about 25 lines):
   - Capture-phase `pointerdown` sets `document.documentElement.dataset.input = "pointer"`.
   - `keydown` sets `"keyboard"`, ignoring bare Shift, Ctrl, Alt and Meta.
   - Export `openedBy(): "pointer" | "keyboard"` and `motionMs(token: string): number`. The second reads
     `parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token))` and returns 0 when
     NaN.
   - Call `installInputModality()` in `main.tsx` before `createRoot`.
3. In `global.css`, replace each animation:
   - `.dialog[open]` and `::backdrop` → add the `m-dialog` class in `Dialog.tsx`. Delete `dialog-in`,
     `fade-in` and the `backdrop-filter: blur(3px)`.
   - `.menu` → `m-pop`. In `Menu.tsx` `useLayoutEffect`, set `menu.style.setProperty("--origin", …)` to
     `"top right"`, `"bottom right"` (flipped) or `"top left"` (point). Set `data-opened-by={openedBy()}`
     with a lazy `useState`. Delete `menu-in`.
   - `.toast` → `m-toast`. Delete `toast-in`. `.term-banner` → `m-toast`. `.find-bar` → `m-pop` with
     `--origin: top right`.
   - `.side-panel`, `.host-panel` → `m-panel`. Delete `panel-in`.
   - `.palette[open]`: delete the animation. Add `data-opened-by` in `CommandPalette.tsx`, plus a rule
     `.palette[open][data-opened-by="pointer"]` that uses the `.m-dialog` transition at `--duration-fast`.
   - `.page-inner`: delete `animation` and `@keyframes page-in`.
   - `.shell`: delete the `grid-template-columns` transition. Add
     `.shell:not([data-sidebar="collapsed"]) .nav-label { transition: opacity var(--duration-fast) var(--ease-out); @starting-style { opacity: 0 } }`.
     Check that `.nav-label` is unmounted while collapsed; if it is only hidden, toggle `display`.
   - `.host-card`: remove the `:hover` transform and `box-shadow` and their transitions.
4. Press feedback: add `transform var(--duration-press) var(--ease-out)` to the existing transition lists
   of `.tab`, `.nav-item`, `.chip`, `.status-button`, `.icon-btn` (confirm the class in
   `components/ui/controls.tsx`), `.tile` and `.host-card`. Add the rules
   `:active:not(:disabled,[aria-disabled="true"]) { transform: scale(var(--scale-press)) }`, and
   `--scale-press-card` for `.host-card` and `.tile`. Gate them with `@media (hover: hover) and (pointer: fine)`.
   Not for file table rows, which keep `pressFeedback`.
5. `files.css`: `.xfer-bar > span { transition: transform var(--duration-progress) var(--ease-linear); }`.
6. Tooltips (`global.css:2955-3017`):
   - Keep the transform offsets only for positioning. Change the transition to
     `opacity var(--duration-fast) var(--ease-out)`, so the 2 px move is gone.
   - Add `:root[data-tips-warm] button[data-tooltip]:hover::after { transition-delay: 0s; transition-duration: 0s; }`.
   - In `inputModality.ts`, a delegated `pointerover`/`pointerout` on `[data-tooltip]` sets `data-tips-warm`
     after 450 ms of hover and clears it 600 ms after the last `pointerout`.
7. `SettingsViews.tsx:216`: use `behavior: motionMs("--duration-base") > 0 ? "smooth" : "auto"`.
8. Migrate the remaining `--motion-fast/base/slow` and `--ease-spring` uses to the new names, keeping the
   same durations. Delete the aliases.

**Tests: `tests/ui/motion.spec.ts`.**
- **(a) Functional, `test.use({ reducedMotion: "no-preference" })`:**
  - Open a menu by click: `getComputedStyle(menu).transitionDuration` contains `0.14s` and
    `transformOrigin` is `right top`-ish (the computed value is in px, so assert `x > width/2`).
  - Open the same menu with Shift+F10: `menu.getAnimations().length === 0`, and the first item is
    focused in the same task.
  - Open the palette with Ctrl+K and type immediately: the input has the value and the palette has
    no animations.
  - A transfer bar span has a transition-duration of `0.2s`.
- **(b) Reduced motion disables everything**, run twice: once with `emulateMedia({reducedMotion:"reduce"})`,
  once with `no-preference` plus the Settings "Reduce motion" switch on.
  - Drive this sequence: open the host panel, a menu, a toast and a dialog; toggle a switch; open and
    close a tab; navigate.
  - After each step, assert
    `await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running" && !String(a.animationName ?? "").match(/spin|pulse|cursor/)).length) === 0`.
  - Assert `getComputedStyle(document.documentElement).getPropertyValue("--duration-glide").trim() === "0ms"`.
- **(c) Terminal guard:** open a local terminal and split, then assert
  `document.querySelector(".terminal-host").getAnimations({ subtree: true })` contains no transitions,
  and that `.terminal-host`'s computed `transition-property` is `none` or `all` with a duration of `0s`.

### PR 2: "Presence: everything that appears also leaves"

**Files.**
- New `lib/usePresence.ts`.
- `components/ui/Toasts.tsx`, `components/ui/Menu.tsx`.
- `features/hosts/HostsView.tsx` (host panel, bulk bar).
- `app/AppShell.tsx` (side panels).
- `features/files/TransferDrawer.tsx`, `features/terminal/ConnectionSheet.tsx`.
- `styles/motion.css`, `tests/ui/motion.spec.ts`.

**Hook contract.**

```ts
// Keeps the last non-null value mounted for one exit duration after it becomes null.
export function usePresence<T>(value: T | null, token = "--duration-exit"): { item: T | null; leaving: boolean }
```

- When `value` goes from non-null to null, compute `ms = motionMs(token)`. If `ms === 0`, return
  `{ item: null }` **in the same render**. Use derived state, not an effect, so tests under reduced motion
  never see a lingering node.
- Otherwise keep the previous item with `leaving: true` and start a `setTimeout(ms)` that clears it.
- If `value` becomes non-null again before the timeout ends, clear the timer and return the new value
  with `leaving: false`. The CSS transition retargets from the current opacity.
- The caller renders the leaving node with `className="… m-leaving"`, `inert` and `aria-hidden`, and
  without `id` or `data-testid`, so tests and assistive technology see it gone at once.

**CSS.** `.m-leaving` already fades. Make it `opacity:0; transition: opacity var(--duration-exit) var(--ease-out), transform var(--duration-exit) var(--ease-out); pointer-events:none`,
then add `.m-panel.m-leaving { transform: translateX(var(--distance-sm)) }` and
`.m-pop.m-leaving { transform: scale(var(--scale-enter)) }`.

**Apply to:**
- Toasts. Keep each toast in state with a `leaving` flag rather than using the hook: map the
  timeout to `leaving: true`, then remove it after `motionMs("--duration-exit")`. Pause the
  `VISIBLE_MS` timer on `pointerenter` and resume on `pointerleave`.
- Menus. The owners unmount them, so wrap `Menu` in a `MenuPresence` that takes `open`.
- The host panel, side panels, the bulk bar and the transfer drawer (when it empties).
- The connection sheet when the session opens: `--duration-fast`. Confirm in
  `ConnectionSheet.tsx:481` that the terminal is already receiving input under the fading layer. The
  layer must get `pointer-events:none` the moment it starts leaving.

**Tests (motion.spec, `no-preference`).**
- Close the host panel: `.host-panel` (the leaving node has no test id) is gone from
  `getByTestId`/role queries immediately, and the list is clickable immediately (click a card within
  50 ms and assert the panel reopens).
- Reopen within the exit window: one panel, not two.
- A toast hovered past 4.5 s is still visible.
- Under reduce: the DOM count of `.host-panel` is 0 synchronously after close.
- Existing `host-panel.spec.ts`, `sidepanel.spec.ts` and `files.spec.ts` must pass unchanged.

### PR 3: "Things glide to their new place" (FLIP and nav glides)

**Files.**
- New `lib/useFlip.ts`, new `lib/useGlide.ts`.
- `components/layout/TabStrip.tsx`, `components/layout/Sidebar.tsx`.
- `features/settings/SettingsViews.tsx`.
- `components/ui/Toasts.tsx`.
- `features/hosts/HostsView.tsx`, `features/credentials/KeychainView.tsx` (plus the known-hosts list
  file, located with `grep -rn "known" features --include=*.tsx`).
- `styles/global.css`, `tests/ui/motion.spec.ts`.

**`useFlip(containerRef, deps, { enabled = true, token = "--duration-glide", easing = "--ease-in-out" })`.**

Children opt in with `data-flip-key`. In `useLayoutEffect` (which runs every time `deps` change):
1. `ms = motionMs(token)`. If `ms === 0`, if `!enabled`, or if `dataset.input === "keyboard"` and the
   caller did not pass `keyboard: true`, store the rects and return.
2. For each child: `A = el.getBoundingClientRect()` (includes any running FLIP transform). Cancel that
   element's previous FLIP animation (kept in a `WeakMap`). Then `B = el.getBoundingClientRect()` (the new layout).
3. `prev = lastLayout.get(key)`. If it exists, the presentation-correct start is `start = prev + (A - B)`
   and `dx = start.left - B.left`, `dy = start.top - B.top`.
4. If `|dx|` or `|dy|` > 0.5 px, call
   `el.animate([{ transform: \`translate(${dx}px, ${dy}px)\` }, { transform: "none" }], { duration: ms, easing: getComputedStyle(root).getPropertyValue(easing) })`.
5. Store `lastLayout.set(key, B)`. Never write state, so there is no re-render per frame.

Keys that are new get no FLIP: their entrance is CSS `@starting-style`. Cap the work at 60 children per
container; above that, skip (large host lists).

**`useGlide(containerRef, activeKey, { axis: "x" | "y", byPointerOnly: true })`.**

When `activeKey` changes and the last input was the pointer:
- Create or reuse an absolutely positioned indicator element (`.tab-glide` / `.nav-glide`) in the
  container.
- Size it to the new target (width/height set once, not animated).
- WAAPI-translate it from the old target's offset to the new one at `--duration-glide`, with easing
  `--ease-in-out` (or `--ease-spring-soft`/`--duration-spring` after sign-off).
- Set `data-gliding` on the container so that `.tab[aria-selected=true]` (background and border) and
  `.nav-item[aria-current]::before` are transparent during the glide.
- On `finish` or `cancel`, remove `data-gliding` and hide the indicator (`opacity:0`).
- A second change mid-glide reads the indicator's current `getBoundingClientRect()` as its start.

The resting pixels are identical to today.

**Apply.**
- TabStrip: `useFlip` on `.tabstrip-tabs`, deps `[ws.tabs.map(t => t.id).join()]`. `useGlide` keyed on
  `ws.active`. Tab entrance CSS:
  `.tab { @starting-style { opacity:0; transform: scale(var(--scale-enter)) } transform-origin: left bottom; }`.
  Add `opacity var(--duration-fast) var(--ease-out)` to the tab's transition list (keep it at
  `--duration-press` for transform).
- Sidebar: `useGlide` on the library nav (axis y). `useFlip` on the session list.
- Settings nav: `useGlide` (axis y).
- Toasts: `useFlip` on `.toasts`.
- Hosts grid/list, keychain and known hosts: `useFlip` with `enabled` false while the search or filter
  input changed in this render. Compute it as `prevQuery === query && prevFilter === filter`.
- New rows: `.list-row, .host-card, .tile-grid > li` get
  `@starting-style { opacity:0; transform: scale(var(--scale-enter)) }` with
  `transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out)`
  added to the existing list. This fires only for nodes inserted after the first render of the list:
  gate it with `[data-list-ready] >` set in a `useEffect` after mount, so page loads and filters don't play it.

**Tests (motion.spec, `no-preference`).**
- Open three tabs, close the first by clicking its ×: during the next 50 ms the second tab
  `getAnimations()[0].effect.getKeyframes()[0].transform` starts with `translate(`. After 300 ms there
  are no animations and the order is correct.
- Close with Ctrl+W: no animations.
- Click tab 3, then tab 1 within 60 ms: one `.tab-glide` animation is running and it ends on tab 1's
  rect (±1 px).
- Ctrl+Tab: none.
- Add a host through the panel: the new card has a running opacity transition. Type in search: no
  card has animations.
- Reduced motion (both modes): repeat everything and assert `document.getAnimations().length === 0`
  after each action. `workspaces.spec.ts` (tab reorder) passes unchanged.

### PR 4: "Moments" (P2, rare-tier delight and the optional spring)

**Files.**
- `features/vault/VaultScreens.tsx`, `app/App.tsx` (or wherever `.shell` mounts).
- `features/home/HomeView.tsx`.
- `features/terminal/ConnectionSheet.tsx`.
- `features/hosts/HostsView.tsx`.
- `components/layout/StatusBar.tsx`.
- `features/files/TransferDrawer.tsx`.
- `styles/global.css`, `styles/tokens.css` (the spring, only after sign-off).
- `tests/ui/motion.spec.ts`.

**Steps.**
1. **Unlock failure shake.** The shake plays on `.auth-card[data-shake]`; increment a `shakeKey` on each
   wrong-passphrase result so the keyframe restarts.

   ```css
   @keyframes auth-shake { 20% { transform: translateX(-6px) } 45% { transform: translateX(5px) } 70% { transform: translateX(-3px) } }
   .auth-card[data-shake] { animation: auth-shake 220ms var(--ease-out) }
   ```

   Under reduced motion, use `animation: none` in both blocks. Keep focus in the field, with the text
   selected, so retyping is instant. Never shake for the changed-host-key warning.
2. **Shell entrance after unlock:** `.shell { transition: opacity var(--duration-slow) var(--ease-out); @starting-style { opacity: 0 } }`.
   It mounts once per unlock, so it is rare.
3. **Home first-load stagger:** set `--i` on each `.tile-grid > *` (index ≤ 7) and `data-first` on
   `.page-inner` for the first Home render after unlock only (a module-level flag reset on lock).
   Use the CSS from the §3 Home row.
4. **Connection steps:**
   - `.connect-steps li[data-kind="done"] .connect-marker svg { transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out); @starting-style { opacity:0; transform: scale(var(--scale-enter)) } }`.
   - Give `.connect-time` the same opacity rule.
   - The rows themselves never move.
5. **Double-click launch tint:** on host card or row `dblclick`, set `data-launching` for
   `motionMs("--duration-glide")`. CSS:
   `.host-card[data-launching] { border-color: var(--accent); transition: border-color var(--duration-press) var(--ease-colour) }`.
6. **Flash (`--duration-flash`)** for a just-added row, a finished transfer row, and the autosaved field
   once interaction-polish §3 lands:

   ```css
   @keyframes flash { from { background-color: var(--accent-soft) } }
   [data-flash] { animation: flash var(--duration-flash) var(--ease-out) }
   ```

   Set it for one frame cycle, then remove it on `animationend`.
7. **Status dot:** `.status-dot { transition: background-color var(--duration-base) var(--ease-colour) }`.
8. **Spring (only with owner sign-off):**
   - Add `--ease-spring-soft` and `--duration-spring` (§2).
   - `.switch::after { transition: transform var(--duration-spring) var(--ease-in-out); transition-timing-function: var(--ease-spring-soft) }`
     (two declarations, so browsers without `linear()` keep the fallback).
   - `useGlide` reads the same tokens.

**Tests.**
- Wrong passphrase in the mock vault: `.auth-card` has a running animation named `auth-shake`
  (`no-preference`), and the input is focused and selected within the same task.
- Under reduce: none.
- Home after unlock: `.tile-grid > *:nth-child(3)` has `transitionDelay` `0.06s`. Navigate away and
  back: `0s`, with no animations.
- Double-clicking a host opens exactly one tab. Covered by the existing behavior spec; assert the tab
  exists within 100 ms, so the tint never delays connect.
- The reduced-motion sweep from PR 1 is extended with these surfaces.

## 6. Feel-check (every PR, before review)

- Run `pnpm dev` with DevTools → Animations at 10 % speed. Check that the menu grows from its trigger
  corner, that tab FLIP and glide have no start jump when clicked twice quickly, and that toasts don't
  double-expose.
- Under 4× CPU throttle, flood the terminal (`yes | head -c 50M`) and close tabs. The FLIP and the glide stay
  smooth: they are WAAPI transforms, which run off the main thread. Terminal throughput (the
  `tests/performance` measure) must not regress by more than noise.
- Toggle Settings → Reduce motion and repeat the sequence. Nothing moves, and every action still works.

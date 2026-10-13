# Quiet Precision motion

How Tyrminal's interface moves, and where it deliberately does not. The values below are the ones
in `apps/desktop/src/styles/tokens.css`; the rules are implemented in `styles/motion.css`,
`lib/useGlide.ts`, `lib/exitGhost.ts`, `lib/motion.ts` and `lib/inputModality.ts`. There is no
motion library: CSS transitions with `@starting-style` for entrances, the Web Animations API for
positions known only at run time.

## Principles

1. Motion answers something the user did with the pointer, or shows a real change of state. Nothing
   moves to decorate.
2. The action happens first. No connection, command, dismissal, focus change or keystroke waits for
   an animation.
3. Anything opened from the keyboard appears at once (`data-opened-by="keyboard"`). Power users
   never pay for an entrance.
4. Only `transform` and `opacity` animate, plus a color for hover and one-shot tints. No layout
   property is transitioned.
5. The terminal canvas never moves, fades, scales or blurs. `.terminal-host` and its descendants
   have transitions and animations switched off; the cursor blink is the user's terminal setting.
6. Security decisions stand still. Trust prompts and the changed-key warning do not animate, and no
   error shakes.
7. Progress is the truth. A bar or step moves only when the backend reports it.

## Tokens

| Token | Alias | Value | Used for |
|---|---|---|---|
| `--motion-instant` | | 0 ms | Keyboard-opened surfaces, tab switch, palette, search results |
| `--duration-press` | `--motion-micro` | 100 ms | Press and hover color, focus ring |
| `--duration-fast` | `--motion-fast` | 140 ms | Menus, popovers, tooltips, disclosure |
| `--duration-base` | `--motion-standard` | 180 ms | Dialogs, side panels, status color |
| `--duration-slow` | `--motion-spatial`, `--motion-expressive` | 220 ms | Toasts, the shell after unlock, onboarding step |
| `--duration-exit` | | 100 ms | Every exit: fade only |
| `--duration-glide` | | 140 ms | The nav caret, list reorder (FLIP) |
| `--duration-progress` | | 200 ms, linear | A transfer bar retargeting between reported values |
| `--duration-flash` | | 400 ms | The one-shot "this changed" tint |
| `--ease-out` | `--ease-enter`, `--ease-exit` | `cubic-bezier(0.23, 1, 0.32, 1)` | Entrances and exits |
| `--ease-in-out` | `--ease-move` | `cubic-bezier(0.77, 0, 0.175, 1)` | Movement between two resting places |
| `--ease-drawer` | | `cubic-bezier(0.32, 0.72, 0, 1)` | Side panels |
| `--distance-xs / sm / md` | | 2 / 4 / 8 px | Disclosure / menus and rows / panels, toasts, dialogs |
| `--scale-enter`, `--scale-press` | | 0.97, 0.98 | Popover entry, press feedback |

Nothing overshoots and nothing lasts longer than 220 ms. `--motion-expressive` equals the spatial
duration on purpose: daily screens have no expressive motion, and first run has one 180 ms step
change. Spring tokens (`spring-soft`, `spring-responsive`) are not defined because nothing uses a
spring: split dividers and panel edges follow the pointer 1:1 and stop where it stops. Staggers are
not used; `--stagger` remains in the token file but no list cascades.

## Recipes

| Interaction | What happens |
|---|---|
| Button, row, tab, nav hover and press | Color eases over 100 ms; pressable things scale to 0.98 while held |
| Sidebar and Settings navigation, by pointer | The fill changes at once. Only the 2 px accent caret glides to the new row over 140 ms |
| Sidebar and Settings navigation, by keyboard | Instant |
| Sidebar collapse | Instant width (an animated width would reflow the terminal every frame); labels fade in over 140 ms |
| Tab add, switch, close | Instant. All tabs have one width, so neighbours never shift on selection |
| Menu, popover | Scales 0.97 → 1 from the trigger's corner with a fade, 140 ms; exit is a 100 ms fade of an inert copy |
| Dialog | Fade with a 4 px rise, 180 ms. `alertdialog` never animates |
| Command palette | Instant, however it was opened |
| Side panel (Files, Snippets, host details) | 8 px slide with a fade from its edge, 180 ms, after layout is committed; the terminal resizes once |
| Host details closing | Removed at once: it holds credential fields, and no copy of them outlives the panel |
| Connection progress | One rotating arc while work is in flight; steps fill when the backend reports them |
| Connected | The sheet fades out; the shell is already live underneath |
| Auth error, wrong passphrase | Inline message, focus back in the field. No shake |
| Toast | Rises 8 px with a fade, 220 ms; leaves along the same edge |
| List reorder, a single row added | FLIP over 140 ms, at most 2 rows changing and 300 rows measured; never while typing |
| Transfer progress | Width follows reported bytes, 200 ms linear between ticks; a finished row tints once |
| Theme switch | Instant |
| Split divider, panel edge drag | 1:1 with the pointer |

## Deliberately not animated

Typing, search results, tab traversal, terminal output and resize, text selection, fingerprint text,
the changed-key warning, error severity, page changes, list arrival (no row cascade) and anything
without a truthful state behind it.

## Reduced motion

The operating system preference and the in-app switch (Settings → Appearance → Reduce motion) set
every duration, distance and scale token to zero or one, so the recipes above become instant
without separate rules. Loops stop. Content and state stay fully visible; nothing depends on an
animation to be understood. Turning the preference on mid-animation removes a running glide or exit
copy immediately.

## Interruption

- A pointer glide starts from where the caret is now, not where it began.
- A key press, a keyboard navigation or a reduced-motion change cancels a running glide and removes
  its element.
- An exit copy is inert and hidden from assistive technology. Any later pointer or key event, the
  same surface reopening, locking the vault or reduced motion removes it at once; a timeout removes
  it regardless.
- Forms, inputs, dialogs and anything containing a terminal are never copied for an exit.

## Verification and its limits

`tests/ui/motion.spec.ts` and `tests/ui/redesign-motion.spec.ts` assert the origins, durations,
keyboard immediacy, the absence of terminal animation, interruption and both reduced-motion
sources against the production build with a synthetic backend. They run in headless Chromium with
software rendering, so they establish behavior, not frame rate: no frame-rate figure is claimed for
any device, and real GPU, high-refresh and native WebView timing have not been measured. The audit
that preceded these changes is `MOTION-AUDIT.md`; results are in `PROGRESS.md`.

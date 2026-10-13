# Redesign progress

Updated 2026-10-14. Branch `redesign/quiet-precision`, from checkpoint `8b8da8ae`. Specification:
`Tyrminal_Premium_Redesign_Codex_Prompt.md`. Design: `DESIGN.md`. Motion: `docs/redesign/MOTION.md`.

Read this first when resuming. Everything below was run on one machine: macOS arm64, headless
Chromium 1243 for the browser suite. Nothing here is evidence for Windows or Linux.

## Where each phase stands

| Phase | State | What exists |
|---|---|---|
| 0 Safety and baseline | Done | `BASELINE.md`; 132 before-captures; pre-redesign control build for comparisons |
| 1 Direction and system | Done | `DESIGN.md`, `PRODUCT.md`, `MOTION.md` |
| 2 Foundations | Done | Planes and tokens for five themes, fields, segmented choice, tooltips, boxes |
| 3 Host → terminal | Done | Sidebar, tab strip, Hosts, host details, connection sheet, status strip |
| 4 Workspace, files, settings | Done for what was restyled; see "Not yet redesigned" | Panes, side panel, Settings, Files and SFTP surfaces |
| 5 Motion | Done | Two audit plans carried out; one defect in that work found and fixed |
| 6 Hardening | Partly done | Layout and overflow tests, contrast gate; no screen-reader or adversarial-string pass yet |
| 7 Evidence and handoff | Partly done | 156 after-captures; native smoke passes on macOS; visual goldens not re-recorded |

## What changed

1. **Planes.** The page is the canvas, a box is one step up, fields are recessed; before, every
   layer sat one step too light and the interface read as one flat gray.
2. **Terminal as one object.** The selected terminal tab, the pane title and the status strip take
   the terminal scheme's colors, so the terminal reads as a single sheet docked in the frame. All
   tabs have one width, so selecting a tab moves nothing.
3. **Hosts.** One header row (page name plus a field that finds a host or connects to an address),
   compact group cells, one box of 48 px rows. The empty library offers New host, Import hosts and
   Local terminal.
4. **Connection sheet.** Rebuilt as heading, scrolling body and actions. At the 820×620 minimum
   window the changed-key warning used to clip its heading, and then overlapped its own text.
5. **Themes** (owner request, 2026-10-14). Five app themes, each dark and light; Cobalt (blue) is
   the default. A new `palette` preference carries the choice; see DESIGN.md "Themes".
6. **Wide windows** (owner report). Pages use the full width of their pane; Settings flows its
   groups into two columns when its pane is wide.
7. **Hosts horizontal scrollbar** (owner report). Cause: invisible tooltips of buttons near the
   right edge counted as page content. Tooltips now take no room until shown.
8. **Side panel** (owner request). Snippets, History and Appearance sit on a surface with segmented
   section tabs, label-style folders and roomier rows.
9. **Segmented choices** (owner request). A recessed track with the chosen option lifted out.
10. **Sidebar.** Groups are Library, Security and New session; the duplicated "Local · encrypted"
    labels were removed (the status strip keeps one).

## Motion

Kept: press and hover color, menu and popover entry from the trigger corner, dialog fade, side
panel slide, toasts, list reorder, truthful transfer progress. Restored in a smaller form: the
navigation marker glides again, but only its 2 px caret; the fill changes at once. Removed: the
tab width animation, the row cascade on arriving at a list, three simultaneous loops on the
connection track, and every shake. Never animated: the terminal, the palette, tab switching,
security prompts.

Defect found and fixed: an earlier change cancelled a menu's exit animation on the same click that
closed the menu (it compared event timestamps, which tie when the clock is coarse), so the exit
never played. `lib/exitGhost.ts` now attaches its cancel listeners after the current task.

## Backend change (one)

`Preferences.palette: String` in `crates/contracts`, validated in `crates/core/src/preferences.rs`
as an id (lowercase letters, digits, hyphens, at most 40 characters), like a terminal scheme id.
It is not a secret and touches no vault, transport or permission code. Files written before it
existed read as `cobalt`; an id from a newer version is shown as the default theme. Covered by
`preferences::tests::the_color_theme_is_an_id_and_older_files_get_the_default`.

## Results

| Check | Command | Result |
|---|---|---|
| Fast gate | `pnpm verify:fast` | **7 of 7 pass** (format, clippy, Rust tests, contracts, TypeScript, build, matrix) |
| Contrast | `pnpm check:contrast` | **Pass**: 1,269 pairs, 10 theme modes, 14 terminal schemes; picker previews match tokens |
| Feature matrix | `pnpm docs:check` | **Pass**, 314 rows; P-34 added as IMPLEMENTED_UNVERIFIED |
| Browser suite | see below | **436 pass, 41 fail** of 477 |
| Capture matrix | `REDESIGN_STAGE=after … -c redesign-capture.config.ts` | **72 of 72 pass**, 156 images |
| Native smoke, macOS arm64 | `pnpm build:e2e && node --test tests/native/redesign.test.mjs` | **Pass** (1 of 1), real application and WebView |
| Integration, security, full native | `pnpm test:integration`, `test:security`, `test:native` | **Not run** (need the Docker lab; no Docker daemon here) |
| Windows, Linux | — | **Not run** |

`verify:fast` must be run outside a restricted command sandbox: inside one, the PTY crate's
`kill_and_drop_terminate_the_process` cannot open a pseudo-terminal and fails. That failure is
environmental; no Rust code under it changed.

Browser suite command (the suite is written for Linux keyboard conventions, so on macOS it needs
the convention emulated; the pinned Chromium 1194 is not installed, so 1243 was used):

```sh
cd tests/ui
TYR_UI_PLATFORM=linux TYR_BROWSER_EXECUTABLE=<chrome-headless-shell 1243> \
  pnpm exec playwright test -c playwright.config.ts --project=chromium
```

The 41 failures, by cause:

| Count | Tests | Cause | Status |
|---|---|---|---|
| 22 | `visual.spec.ts` | Screenshot goldens recorded in the pinned Linux image; every screen changed | Must be re-recorded with `pnpm test:ui:update:container` (needs Docker). Not done |
| 12 | `multi-select` ×6, `optimistic` ×4, `inventory:80`, `inventory-presentation:147` | macOS Chromium turns Ctrl+click into a right-click | All 12 passed with `TYR_UI_PLATFORM=macos` on an earlier build of this session; not repeated on the final build |
| 5 | `files:813`, `files:1124`, `sftp:523`, `accessibility:108` ×2 | Need Ctrl+click and Linux shortcuts in one test | Cannot pass on a macOS host under either convention; unverified here |
| 1 | `ime:184` | Focus timing under five parallel workers | Passed with `--workers=1` on an earlier build of this session |
| 1 | `motion` host details slide | Unknown | Fails identically on the pre-redesign build on this machine |

So no failure is known to be caused by the redesign, and 28 of the 41 have not been shown to pass
in their intended environment. The Linux container run is the check that settles them.

Two tests that failed on the pre-redesign build here now pass: the transfer-bar motion test (its
setup opened Files on a local terminal, which has none) and the menu exit test (the defect above).

Control build: the pre-redesign commit was built in a throwaway worktree and `motion`, `broadcast`
and `tabstrip` were run against it serially on this machine (32 pass, 3 fail), which is how the
pre-existing failures above were told apart from regressions.

### Native

`tests/native/redesign.test.mjs` drives the real application (macOS arm64, WKWebView, a disposable
vault, no network): it creates a vault, saves a host, shrinks the window to 820×620 and checks for
overflow, switches to light, opens the palette and checks focus, opens Settings, checks the theme
picker (five themes, Cobalt selected, every card inside its group), chooses Graphite, locks,
unlocks and checks that the saved host, the light mode and the Graphite theme all came back from
the real backend. It passes. Screenshots are in `docs/redesign/native/`.

This run found a defect the browser suite could not: at the minimum window a Settings row's fixed
control column was wider than its group in WebKit. Rows now put the control under the label in a
narrow pane; the native test and a browser test both assert it.

The rest of the native suite (`pnpm test:native`) needs the SSH lab and was not run.

## Tests added or changed

- Added `tests/ui/themes.spec.ts` (5), `tests/ui/redesign-layout.spec.ts` (9: changed-key at the
  minimum window, host editor layout, 500 hosts windowed, Hosts never scrolls sideways in List and
  Cards, wide-window pages and Settings, Settings groups at the minimum window),
  `tests/ui/redesign-motion.spec.ts`, and theme checks in `tests/native/redesign.test.mjs`.
- `motion.spec.ts`: expectations follow the motion decisions above (no shake, no row cascade, no
  exit copy of a credential form). The navigation glide test is the original assertion again, plus
  a check that the glide has no fill.
- `tabstrip.spec.ts`: tabs are compared with the one resting width instead of a fixed 180 px.
- Modifier keys go through `uiModifier`, so the suite can run under either keyboard convention.
- No assertion about host keys, authentication, vault or permissions was changed.

## Not yet redesigned or verified

Ranked by how much they matter.

1. **Visual goldens** are stale (22 tests). Until they are re-recorded in the container the visual
   regression suite protects nothing.
2. **Windows and Linux** rendering of the new styles is unchecked. They use CSS nesting,
   `@starting-style`, `:has()`, `color-mix()` and container queries; the WebViews are WebView2 and
   WebKitGTK. WebKitGTK is the one to look at first.
3. **Screens only restyled through shared tokens**, not reviewed one by one: Tunnels, Recordings,
   Keychain, Known hosts, Notes, Server panel, History, dialogs for import, discovery, broadcast
   review and paste review, recovery-key and backup screens.
4. **No screen-reader pass**, no high-refresh or real-GPU frame measurement, no touch input.
5. **Adversarial content** (very long names, right-to-left text, hundreds of tabs) was only
   exercised as far as the existing suite does.
6. **`precision.css` and `workspace.css` override the base stylesheets by class.** It works and is
   documented, but the rules should be folded into `global.css` and `hosts.css` section by section.
7. **Performance** was not measured before or after: no startup, bundle-transfer or frame numbers
   are claimed. No dependency was added.

## Skills actually used

`frontend-design` for the direction pass (planes, restraint, copy). The motion audit and plans in
`MOTION-AUDIT.md` and `animation-plans/` came from the earlier session using `improve-animations`,
`find-animation-opportunities`, `animate` and `animation-performance`; this session carried them
out and corrected one of them. `impeccable`, `ui-ux-pro-max`, `web-design-guidelines` and `break-ui`
were not run in this session.

## Resume

```sh
pnpm doctor && pnpm verify:fast          # outside a restricted sandbox
pnpm check:contrast && pnpm docs:check
pnpm test:ui:update:container            # needs Docker: re-record the 22 goldens, then review them
pnpm lab:up && pnpm test:integration && pnpm test:security
pnpm build:e2e && pnpm test:native
```

## Evidence files

Screenshots (`docs/redesign/before`, `after`, `native`, about 25 MB) and the Playwright result
files are on disk but were left out of the commit: whether that much binary evidence belongs in
the repository's history is the owner's call. They are regenerated by the commands in `CAPTURE.md`.

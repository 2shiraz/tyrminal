# Progress — terminal input and connection tools

Updated: 2026-10-12. Branch `claude/terminal-input`, built on the workspaces branch (PR #7).
Rows: TRM-07, TRM-08, TRM-11, TRM-14, UX-03, UX-04, P-13, and the "Connection details" view for CON-15.
New code lives in `apps/desktop/src/features/{broadcast,...}/` and `apps/desktop/src/lib/messages-input.ts`
(`msgI`); edits to shared files are additive and listed in `docs/work-split.md` (Requests).

## Slices

| # | Slice | State |
|---|---|---|
| 1 | IME composition (TRM-11) | Done: UI tests over Chromium's IME path, native test on Linux |
| 2 | Broadcast targets can be left out (P-13) | Done: UI tests; native test on Linux (real local shells) |
| 3 | Highlight patterns with bounded matching (TRM-07) | Done: core, UI and native tests on Linux |
| 4 | Ordered IME commits (TRM-11 fix) | Done: UI stress tests; native check on Linux |
| 5 | Palette completeness (UX-03), Connection details view (CON-15) | Done: UI tests; native waits for `session_diagnostics` |
| 6 | Connection side panel: snippets, history, appearance (TRM-14) | Done: UI tests; visual baselines updated in the pinned container |
| 7 | Mouse mappings and native persistence (TRM-08), recent connections native test (UX-04) | Done: core, UI and native tests on Linux |
| 8 | Termius-like highlighting, on by default (TRM-07, owner priority) | Done: UI tests, benchmark; visual baselines re-recorded |
| 9 | Actions on addresses and paths in the output | Done: UI tests |
| 10 | Command boundaries from shell integration (OSC 133) and jumping between commands | Done: UI tests |

## Slice 1: IME composition (TRM-11)

- Keys an input method is processing (`isComposing` or keyCode 229) are left to xterm's
  composition helper: no shortcut, copy or paste handling sees them.
- `tests/ui/ime.spec.ts` drives Chromium's IME over the DevTools protocol
  (`Input.imeSetComposition`/`insertText`): nothing is sent while composing, the committed text is
  sent once as UTF-8, the IME's Enter/Escape stay with it, a shortcut chord during composition does
  nothing, committed text is broadcast once and the preedit never.
- Native (`tests/native/terminal.test.mjs`): the WebView's composition events are played on the
  terminal's input element (WebDriver cannot drive a system IME), then `od` in the lab shell shows
  exactly the nine UTF-8 bytes of 日本語. Passes on Linux.

## Slice 2: broadcast exclusion (P-13)

- The review lists every pane with a checkbox (all on); at least two must stay. Broadcast binds
  the confirmed panes to the sessions they had (`features/broadcast/members.ts`): a pane left out
  neither receives nor relays, a pane added to the tab later never joins, and broadcast stops when
  a confirmed pane leaves the tab, drops or reconnects. Panes left out are marked in their header.

## Slice 3: highlight patterns (TRM-07)

- A rule is a word (literal) or a pattern (`HighlightKeyword.pattern`, serde default false, so
  older preference files load). Patterns are a restricted subset, checked natively
  (`crates/core/src/highlight.rs`, at the preferences boundary) and in the UI
  (`features/highlight/patterns.ts`): no backreferences, lookaround or named groups, no repeated
  groups (`)*`, `)+`, `){n}`), at most 3 unbounded repetitions, counts up to 256, 128 characters,
  8 patterns; the UI also refuses patterns that match empty text.
- Patterns run in one module worker per window (`patterns.worker.ts`, `runner.ts`). A request
  that takes over 250 ms terminates the worker; the rule it was on (the worker reports each rule
  before running it) is switched off until the rules change, and a notice names it. If no worker
  can start, patterns are not applied; they never run on the main thread.
- Earlier rules win where matches overlap (words and patterns in list order, addresses last).
- Evidence: `tests/ui/highlight.spec.ts` (exact cell extents, refused shapes, a polynomial
  pattern switched off while typing keeps working); native `terminal.test.mjs` "highlighting
  patterns in the real WebView" (worker loads in WebKitGTK, slow pattern cut off; Linux).

## Slice 4: committed IME text in exact order (TRM-11)

- Found with 6 parallel runs: xterm 6.0.0's composition helper read committed text a tick after
  `compositionend` from offsets recorded earlier. A key typed before that tick (Chromium runs
  input before timers) sent the text twice or partly; Enter or Ctrl+C right after a commit empties
  the input element first, so the text was lost; back-to-back commits occasionally dropped one.
  6 of 12 stress runs failed.
- `features/terminal/composition.ts` replaces the helper's composition methods on the instance
  (xterm's own handling stays if the internals are not found; the host element says which,
  `data-composition="ordered"|"xterm"`). Committed text is what the input element gained since
  the composition began, sent exactly once at the first of: next composition, next key, blur, or
  one tick after `compositionend`. 42/42 stress runs pass; `ime.spec.ts` keeps the stress case.

## Slice 5: palette and connection details (UX-03, CON-15 view)

- Every application action has a palette entry where it can act (next/previous/rename/close tab,
  close other tabs, focus and move pane in four directions, copy, paste), running the same code
  as its shortcut (`features/commands/extraActions.tsx`, contributed through a new `extra` prop).
- CON-15 view: superseded by the connection log dialog from #27 ("Show connection log" in the
  palette, "Connection log" on the failure notice). This branch's duplicate "Connection details"
  dialog was removed; `tests/ui/palette-actions.spec.ts` keeps its copy-as-text and refused-request
  checks against that dialog.

## Slice 6: connection side panel (TRM-14)

- The panel beside the terminal has three sections (tabs, arrow keys move between them):
  Snippets (unchanged), History (recent connections with when, the current host marked, Open
  starts a new tab; connections only, nothing typed is recorded) and Appearance (scheme, font
  size, line height, cursor for every terminal; zoom for this pane only, not saved).
- The snippets shortcut and status-bar button show Snippets from another section and close the
  panel from Snippets; the palette has "Show connection history" and "Show terminal appearance".
- `SnippetsPanel.tsx` is no longer rendered (its content is the Snippets section).
- Visual baselines `*-09-terminal-snippets.png` re-recorded with `node scripts/ui-container.mjs`.

## Slice 7: mouse mappings, persistence, recent connections (TRM-08, UX-04)

- Right click: select word, paste or nothing (one choice; refused natively if both flags are
  set). Middle click can paste. Pastes from the mouse use the terminal's paste path, so
  several lines are reviewed first. While an application asked for mouse reports, the click is
  reported to it unless Shift is held. A handled middle click also swallows the X11
  primary-selection paste that would follow (`features/mouse/mouseMap.ts`).
- `WorkspacePreferences` gained `rightClickPaste` and `middleClickPaste` (struct default, so older
  files load with both off).
- Native: a shortcut recorded from real key events and the mouse settings are written by the core
  to `preferences.json`, shown again after a restart, and the rebound shortcut opens Find in a
  real terminal. Recent connections reopen from Home and from the new-tab menu (lab host).
- Observed once in 3 full native runs: "16 panes of real local shells" (PR #7's test) timed out;
  it passed in isolation and in the next full run. Not seen in the UI suite.

## Slice 8: highlighting on by default (TRM-07)

- Built-in kinds, each with its own toggle (`HighlightPreferences`: numbers, urls, macAddresses,
  dates, quoted, paths, hex, levels, plus the existing ipAddresses; on by default through a
  `Default` impl, so files written earlier get the new kinds on): addresses (IPv4 with CIDR or
  port, IPv6, MAC), numbers with sizes/percentages/durations, links, ISO dates and clock times,
  quoted text, paths, 0x/UUID/commit hashes, status words (error… red, warn… yellow, ok… green,
  info/debug dim). Rules live in `features/highlight/builtins.ts`, in rank order; the user's
  own words and patterns rank first.
- Only plain output is colored: a match is drawn only if every cell is in the default colors,
  not inverse or invisible. Nothing is drawn on the alternate screen (vim, htop, tmux).
- Colors come from the current scheme (`features/highlight/palette.ts`): per kind, the first of
  its preferred ANSI colors that reaches 4.5:1 on the scheme background (3:1 for dimmed words);
  when none does (Nord's red, Solarized's red and violet, most of Catppuccin Latte), the kind's
  first choice is moved toward the scheme's foreground until it does. `scripts/check-highlight-contrast.mjs`
  (run by `scripts/check-contrast.mjs` in CI) checks all 14 schemes: 168 colors at AA, 6–10
  distinct colors per scheme.
- Settings show each kind with a sample in the scheme's colors and a preview line matched by the
  same code as the terminal.
- `tests/performance/highlight-bench.mjs`: a full 80×300 screen takes ≤ 7 ms for every
  adversarial shape tried (budget 50 ms); matching runs once after output settles (60 ms).
- Visual baselines 09/10/11/17 re-recorded in the pinned container (plain numbers now colored).

## Slice 9: token actions

- An xterm link provider (`features/tokens/tokenLinks.ts`) underlines IPv4 (with port), IPv6
  (bracketed with port), MAC addresses and, in local terminals only, paths on hover; a plain
  click (no drag) opens a menu: Copy / Copy path, and for addresses "New host for …", which opens
  the host editor prefilled with address and port (`NewHostFromTerminal`, through a module-level
  request channel, `features/tokens/requests.ts`). Nothing connects until the user saves and
  connects. URLs keep the existing confirmed-link flow; nothing on the alternate screen.

## Slice 10: command boundaries (OSC 133)

- When the shell reports prompts and exit statuses (OSC 133 A/B/C/D, as printed by shell
  integration scripts), a hairline in the scheme's text color is drawn above every prompt after
  the first and a short bar in the scheme's danger color marks the prompt of a command that
  exited non-zero (title "Exit status N"). The sequences are handled, never printed; marks on the
  alternate screen are ignored; at most 2000 marks are kept.
- "Jump to the previous/next command": Ctrl+Shift+↑/↓ (⌘↑/⌘↓ on macOS), in the palette and in
  the shortcut settings. At the bottom, "previous" is the last command run; scrolled up, it is
  relative to the top of the screen.
- Note for tests: xterm's DOM renderer draws decorated cells one element per cell, so tests find
  terminal text by position in its row (`tests/ui/highlight-helpers.ts` `pointOf`), not by span.

## User guide

Applied to `docs/user-guide.md` (Terminals, Connecting, Snippets and broadcast, shortcuts).

# Progress — terminal input and connection tools

Updated: 2026-10-12. Branch `claude/terminal-input`, built on the workspaces branch (PR #7).
Rows: TRM-07, TRM-08, TRM-11, TRM-14, UX-03, UX-04, P-13, and the "Connection details" view for CON-15.
New code lives in `apps/desktop/src/features/{broadcast,...}/` and `apps/desktop/src/lib/messages-input.ts`
(`msgI`); edits to shared files are additive and listed in `docs/work-split.md` (Requests).

## Slices

| # | Slice | State |
|---|---|---|
| 1 | IME composition (TRM-11) | Done: UI tests over Chromium's IME path, native test on Linux |
| 2 | Broadcast targets can be left out (P-13) | Done: UI tests |
| 3 | Highlight patterns with bounded matching (TRM-07) | Done: core, UI and native tests on Linux |
| 4 | Ordered IME commits (TRM-11 fix) | Done: UI stress tests; native check on Linux |
| 5 | Palette completeness (UX-03), Connection details view (CON-15) | Done: UI tests; native waits for `session_diagnostics` |
| 6 | Connection side panel: snippets, history, appearance (TRM-14) | Done: UI tests; visual baselines updated in the pinned container |
| 7 | Mouse mappings and native persistence (TRM-08), recent connections native test (UX-04) | Done: core, UI and native tests on Linux |

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
- "Connection details…" (palette, for the focused SSH pane) and "Show connection details" (on the
  connection-failed notice) open a dialog listing the core's lines for that session with Copy.
  Lines are shown as text; control characters are replaced. IPC `connectionDetails.lines` →
  `session_diagnostics` (the core command arrives with PR #8; until then the native call fails
  and the dialog shows the error). UI tests use a mock handler; no native test until the command exists.

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

## User guide text (to merge into `docs/user-guide.md`, which arrives with PR #8)

- Broadcast: "Before broadcast starts, Tyrminal lists every pane of the tab. Clear the box next to
  a pane to leave it out: it keeps its own input and receives nothing. A pane you open later is
  never added; start broadcast again to include it."
- Input methods: "Japanese, Chinese and Korean input methods work in the terminal. Text is sent
  when you commit it; keys the input method uses (Enter to choose, Escape to cancel) never reach
  the server, and shortcuts wait until the composition ends."
- Highlighting: "Choose Word or Pattern when adding a rule. A pattern is a regular expression; to
  keep matching fast, groups cannot be repeated and backreferences and lookaround are not
  available. A pattern that takes too long is switched off and named in a notice; edit the rules
  to try it again. Rules higher in the list win where matches overlap."
- Command palette: "Every action is in the palette (Ctrl+Shift+K, ⌘K on macOS): type part of
  its name. Tab and pane actions appear when a terminal is in front."
- Connection details: "To see what happened while connecting, choose Connection details… in the
  palette, or Show connection details on a failed connection. Copy puts the lines on the
  clipboard; they never contain passwords, passphrases or keys."
- Side panel: "The panel beside the terminal (Ctrl+Shift+S, ⌘⇧S on macOS) has Snippets, History
  and Appearance. History lists the hosts you connected to and when; Tyrminal never records what
  you type. Appearance changes the scheme, font and cursor of every terminal, and zooms only the
  pane you are in."
- Mouse: "Settings → Shortcuts and input → Right click chooses between selecting a word, pasting
  and nothing; Middle click pastes can be turned on. A paste from the mouse is reviewed like any
  paste. Programs that use the mouse (vim, htop, mc) get the click; hold Shift to paste anyway."

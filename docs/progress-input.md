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

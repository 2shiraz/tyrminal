# Progress — agent C (Phase 05: terminal polish and workspaces)

Updated: 2026-10-12. Branch `claude/agent-c-workspaces`. Scope and owned files: `docs/work-split.md`.
Rows: `TRM-*`, `WSP-*`, `UX-03`, `UX-04`, `P-13`.

## Slices

| # | Slice | State |
|---|---|---|
| 1 | Tab duplicate/reorder, session status indicators | Done: UI tests and native test on Linux |
| 2 | Layouts: multi-host splits, grid/focus layouts, pane reorder, 16 panes | Done: UI tests and native 16-pane test on Linux |
| 3 | Named layout templates in the vault, explicit save, unsaved indicator, restore by explicit action | Done: core, UI and native tests on Linux |
| 4 | Detach a tab into its own window (scoped capability, session handoff bound to the window label) | Done on A's handoff (636f104, cherry-picked); UI, native and lab tests on Linux |
| 5 | Keyboard customization, encodings/emulation (honest limits), output highlighting, palette/recent polish, broadcast target review (P-13) | Done, including palette tab search and recent connections (UX-03/04) |

## Slice 1 (2026-10-12)

- `workspace.ts`: every pane carries `unread` (output arrived while its tab was hidden); selecting
  a tab by any route (click, keyboard, cycling, closing the tab in front) marks its panes seen.
  `tabStatus` aggregates a tab's panes: the most urgent state wins (prompt waiting > dropped >
  connecting > connected > ended), so a split tab no longer shows only its focused pane.
- Tab strip, sidebar session list and the home page's open sessions show the aggregate dot, an
  outline ring for unseen output (shape, not color alone) and spoken text ("new output", "needs
  your input", "disconnected", "connecting").
- The terminal reports only *that* output arrived (no content), once until its tab is shown.
- Duplicate copies the whole arrangement (layout, ratios, destinations, name) right after the
  source tab; each pane opens a new session (a new SSH connection, which confirms the host key
  as usual); nothing typed in the original is replayed. Refused with a message when the copy would
  exceed 16 panes.
- Evidence: `tests/ui/workspaces.spec.ts` (5 tests, mock backend), native
  `tests/native/terminal.test.mjs` "workspaces with real sessions" (local lab, Linux).

## Slice 2 (2026-10-12)

- `PaneGrid` renders every pane of every tab in one container, in id order, and positions the tab
  in front from its layout. Moving a pane to another tab, swapping, rearranging or switching to the
  focus layout therefore never remounts a terminal: its session keeps running (UI tests assert no
  `session_close`/extra `session_open_*`).
- Multi-host workspace: "Split right with…" / "Split down with…" in the palette switch it into a
  picking mode that lists only hosts and the local shell.
- Arrangements: grid (near-square), side by side, stacked; balanced trees with equal shares.
- Focus layout (Ctrl+Shift+Enter / ⌘⇧↩, pane header button, palette): the focused pane fills the
  tab, the others are listed beside it with their state and unseen-output marker.
- Pane reorder: Alt+Shift+Arrow (⌘⌥⇧Arrow) swaps with the neighbour; dragging a pane header's grip
  onto another pane swaps them; "Move pane to a new tab".
- The 16-pane limit now says so from every split route (shortcut, palette, header button, tab menu).
- Fix: after a split, keyboard focus stayed in the old pane (another terminal's input textarea
  counted as "the user is elsewhere"), so typing went to a pane that was not highlighted.

## Slice 3 (2026-10-12)

- Vault record kind 20 (`crates/core/src/layouts.rs`, contracts `layouts.rs`, commands
  `layout_list`/`layout_save`/`layout_delete`). A template holds tabs, split trees, ratios, tab
  names, focus and each pane's destination (saved host id or local shell) and nothing else.
- Native validation: every tree names each pane of its tab exactly once; ratios finite and within
  0.15–0.85; at most 16 panes and tabs; depth bounded before recursing; ids canonical; SSH targets
  must be saved hosts; names and titles display-safe (no controls or bidi overrides).
- Explicit save only (palette "Save layout as…", the layout button's menu). The tab strip shows
  the current layout's name with a dot for unsaved changes; "unsaved" compares a canonical form
  of the open tabs with what was saved.
- Restore appends the template's tabs with every pane *pending*: no xterm, no session, an overlay
  with Connect (and "Connect all in this tab"). Broadcast cannot be enabled while a pane waits.
  A host deleted since saving shows as "Missing host" and fails on Connect with the core's error.
- WSP-10 (shell context) is BLOCKED: it needs shell integration (Phase 08); templates store no
  commands, so there is nothing to re-run or preview.

## Slice 5 (2026-10-12)

- P-13: broadcast starts only after a review listing exactly the receiving panes (label and
  destination); confirming re-checks that the panes and their sessions are unchanged.
- Shortcuts (TRM-08, WSP-13): any action can be rebound, unbound or reset; a shortcut needs Ctrl,
  Alt or Cmd and never Ctrl with a single key, enforced in the UI and natively. Option as Meta
  (macOS) and right-click word selection are settings.
- Highlighting (TRM-07): words and IPv4/IPv6 addresses (not times or MAC addresses) are colored by
  xterm decorations over the visible rows; bytes, buffer text, copies and input are untouched.
- Encodings (TRM-05): per-session output decoding and exact input encoding; characters the
  encoding lacks are not sent and the user is told. TRM-06 is BLOCKED (see the matrix).

## Slice 4 (2026-10-12)

- "Move tab to a new window" (tab menu, palette): only when every pane is connected. The main
  window releases its panes (unmounting them no longer closes the sessions) and calls
  `window_detach`, which validates the tab, creates a `detached-<random>` window and offers each
  session to it (A's handoff); the tokens are kept natively and only that window can collect them
  (`window_detach_take`, once, 60 s). If any offer fails, the window is destroyed and the tab stays.
- The detached window runs a terminal-only shell with its own capability (`capabilities/detached.json`:
  take its tab, attach and use those sessions, read preferences, report activity). It cannot open
  sessions: no split, new tab or reconnect there. The release policy checks that capability
  against an explicit allowlist and keeps the take permission out of the main window.
- Limits: the screen contents do not move (a new terminal starts; full-screen apps redraw on the
  resize); typing in the detached window is not driven natively (the WebDriver plugin sends keys
  to the main window only), so it is covered by the UI test and A's lab test.

## Shell context restore (WSP-10)

- Panes remember the working directory their shell reports with OSC 7 (`file://host/path`):
  absolute, bounded, no control or invisible characters, otherwise ignored. Templates store it
  per pane (optional field; older templates unchanged; validated natively).
- After a restored SSH pane connects, a banner shows the exact command, `cd -- '<path>'` with
  POSIX single-quote escaping, and sends it only on "Send". Nothing else about the shell (history,
  commands, environment) is saved or re-run. Shells that do not report OSC 7 get no offer.

## Findings

1. A Playwright `filter({ hasNot })` checks descendants only; the page tab is excluded by class.
2. In the embedded WebDriver (WebKitGTK) a synthetic click does not focus a `tabindex` element and
   a right click does not raise `contextmenu`; an Alt+Shift+`=` chord did not trigger the split.
   Native tests use the palette and real buttons instead.
3. A pane split repeatedly halves to zero width; WebDriver cannot click its header. The native
   test tiles the panes (grid) before using a header button.
7. Open: one local `pnpm test:native` run (right after `pnpm build:e2e`) failed 3 tests of the
   "terminal with real applications" suite in 119 s (normally ~30 s); the runner kept only the
   passing tail, so the errors were not captured. Not reproduced in 4 reruns. Watching CI for it.
8. CI: on macOS the palette is Cmd+K (native tests used Ctrl+Shift+K); Windows' local shell does
   not expand `$((…))`. Native tests now use the platform chord and a literal token.
9. The e2e build replaces the capability list (`tauri.e2e.conf.json`); new capabilities must be
   listed there too, and the test-only automation capability must name the new windows.
10. The handoff sends no state event; an attached pane marks itself connected (only connected
    tabs move) and the new window may ask for its tab before the offers exist (the native take
    waits up to 5 s).
5. WHATWG `TextDecoder("iso-8859-1")` is Windows-1252; offered as one choice.
6. xterm drops an invalid UTF-8 byte rather than showing U+FFFD.
4. The broadcast UI test typed while the focused terminal was still answering a cursor-position
   query; after the focus fix the typing pane is the answering one and, under load, the reply
   landed between keys (`h[11;23Rostname`). The test now waits for the reply (`data-tx`).
11. Windows lab tests sometimes timed out waiting for PowerShell. ConPTY sends `ESC[6n` at
    start-up and waits for the reply; the lab test client counted the query per output chunk, so
    a query split across chunks went unanswered. It now counts over all output received
    (8962011; windows-x64 green). The handoff relay was not involved.

## Next

Slice 4: detach a tab into its own window. Sessions are bound to the window label in the core,
so a detached window needs an explicit handoff of each session (old label → new label, accepted
only by the new window), a capability file granting only what a terminal window needs, and tests
for cross-window stream access denial and detach/close races.

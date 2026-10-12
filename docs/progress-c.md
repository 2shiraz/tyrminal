# Progress — agent C (Phase 05: terminal polish and workspaces)

Updated: 2026-10-12. Branch `claude/agent-c-workspaces`. Scope and owned files: `docs/work-split.md`.
Rows: `TRM-*`, `WSP-*`, `UX-03`, `UX-04`, `P-13`.

## Slices

| # | Slice | State |
|---|---|---|
| 1 | Tab duplicate/reorder, session status indicators | Done: UI tests and native test on Linux |
| 2 | Layouts: multi-host splits, grid/focus layouts, pane reorder, 16 panes | Done: UI tests and native 16-pane test on Linux |
| 3 | Named layout templates in the vault, explicit save, unsaved indicator, restore by explicit action | Next |
| 4 | Detach a tab into its own window (scoped capability, session handoff bound to the window label) | — |
| 5 | Keyboard customization, encodings/emulation (honest limits), output highlighting, palette/recent polish, broadcast target review (P-13) | — |

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

## Findings

1. A Playwright `filter({ hasNot })` checks descendants only; the page tab is excluded by class.
2. In the embedded WebDriver (WebKitGTK) a synthetic click does not focus a `tabindex` element and
   a right click does not raise `contextmenu`; an Alt+Shift+`=` chord did not trigger the split.
   Native tests use the palette and real buttons instead.
3. A pane split repeatedly halves to zero width; WebDriver cannot click its header. The native
   test tiles the panes (grid) before using a header button.
4. The broadcast UI test typed while the focused terminal was still answering a cursor-position
   query; after the focus fix the typing pane is the answering one and, under load, the reply
   landed between keys (`h[11;23Rostname`). The test now waits for the reply (`data-tx`).

## Next

Slice 3: layout templates as a vault record kind (20), contracts and commands, explicit save with
an unsaved-change indicator, restore that opens panes disconnected with a per-pane and a
"Connect all" action (never automatic, never re-runs commands).

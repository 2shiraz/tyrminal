# Progress — agent C (Phase 05: terminal polish and workspaces)

Updated: 2026-10-12. Branch `claude/agent-c-workspaces`. Scope and owned files: `docs/work-split.md`.
Rows: `TRM-*`, `WSP-*`, `UX-03`, `UX-04`, `P-13`.

## Slices

| # | Slice | State |
|---|---|---|
| 1 | Tab duplicate/reorder, session status indicators | Done: UI tests and native test on Linux |
| 2 | Layouts: multi-host splits, grid/focus layouts, pane reorder, 16 panes | Next |
| 3 | Named layout templates in the vault, explicit save, unsaved indicator, restore by explicit action | — |
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

## Findings

1. A Playwright `filter({ hasNot })` checks descendants only; the page tab is excluded by class.

## Next

Slice 2: split with a different host (palette in "pick for split" mode), even grid arrangement,
focus layout (one main pane plus a pane list), pane swap by keyboard and drag, move pane to a new
tab, a 16-pane test.

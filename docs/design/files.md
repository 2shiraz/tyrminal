# Files redesign: the Files panel and the SFTP tab

Follows `docs/design/overhaul.md` §5 "Files (SFTP)". Both file browsers now share one set of
parts, so they look and behave the same:

| Part | File | Used by |
|---|---|---|
| Table (columns, sort, selection, keyboard, type-ahead, row menu, inline rename) | `apps/desktop/src/features/files/FileTable.tsx` | Files panel, its local pane, both SFTP panes |
| Path bar (breadcrumbs that turn into a path field) | `features/files/PathBar.tsx` | same |
| Transfer drawer (summary, 3 px bars, rate) | `features/files/TransferDrawer.tsx`, `transfers.ts` | Files panel, SFTP tab |
| Styles (tokens only, both themes) | `features/files/files.css` | all of the above |

Screens: `docs/design/files/before/*.png` (main at 7ae072f) and `docs/design/files/after/*.png`,
both captured by `tests/ui/design-capture-files.ts` against the mock backend, in dark and light.
Visual baselines: `tests/ui/__screenshots__/*-19-sftp-panes.png` (changed) and
`*-20-files-panel.png` (new).

## What changed

### Files panel

Before: `before/dark-panel.png`, `before/dark-panel-selected.png` · After: `after/dark-panel.png`,
`after/dark-panel-selected.png`, `after/dark-panel-menu.png`

- **Quiet header.** "Files on api-gateway" plus four icon buttons with tooltips and accessible
  names: Upload (a menu: Upload files, Upload folder, Download this folder), New folder, View
  options (Show hidden files, Show this computer, as checkable menu items), Close. The four text
  buttons, two switches and the shortcut key caps that took three rows before the first file are
  gone (overhaul finding I11, T14).
- **No action bar under the list.** Download, Edit, Copy to another server, Rename, Permissions,
  Copy path and Delete live in the row menu: right-click, Shift+F10 or the menu key, or the `⋯`
  button that appears on the hovered and selected row. Right-click on the free space gives the
  folder's menu (New folder, Upload, Refresh, Copy path, Show hidden files).
- **A real table.** Name, Size and Mode (octal) with sortable headers; the date column appears
  when the panel is wide enough (container query at 480 px). Rows are 28 px, sizes tabular, modes
  faint mono. Folders stay first in every sort.
- The sort and the view options are kept per session with the folder, selection and scroll.

### SFTP tab

Before: `before/dark-sftp-panes.png` · After: `after/dark-sftp-panes.png`,
`after/dark-sftp-swapped.png`, `after/dark-sftp-menu.png`, `after/dark-sftp-path.png`

- **Single-line rows** (28 px) with permissions in their own column (`-rwxr-xr-x`), instead of
  a second line under every name; the Kind column goes (the icon says it, and folders are always
  first). Date Modified no longer truncates.
- **The pane in use is marked**: a 2 px accent line along its top edge. The other pane keeps its
  selection in grey, as in Finder, so it is always clear which pane F5, Delete or typing acts on.
- **Swap** (the round button on the divider, at header height) exchanges the panes' sides. The
  panes keep their connection, folder, history and selection; nothing reconnects. The DOM order
  follows what is shown, so Tab still goes left to right.
- The filter moved into the pane header; the `⋯` menu holds the folder actions.
- Row menu: Open, Copy to *the other pane* (F5), Rename (F2), Permissions, Copy path, Delete (Del).

### Both

- **Editable path.** Breadcrumbs for the folder shown; click the free space after them (the
  pointer turns into a text cursor), or press Ctrl+L in the list, and the bar becomes a field
  with the whole path selected. Enter goes there, Escape or leaving the field puts the crumbs
  back without moving. A local folder (inside the folder the user chose) stays breadcrumbs only.
  Up selects the folder you came from.
- **Inline rename** (F2 or Rename): the name becomes a field in the row with the name selected
  up to its extension. Enter saves and keeps the renamed row selected; Escape keeps the old name;
  leaving the field keeps a valid new name, as in Finder. A refused name (already there) is
  explained under the field, which stays (`after/dark-panel-rename.png`).
- **Keyboard.** Arrows, Home/End, Shift to extend, Space to toggle, Ctrl/Cmd+A for all; typing
  jumps to the first name starting with what was typed (the same letter again moves to the next
  one); Enter opens; Backspace or Alt+Up goes up; Alt+Left/Right go back and forward (SFTP);
  F2 renames; Delete asks to delete; F5 copies to the other pane (SFTP); Escape clears the
  selection first, then closes the panel. Opening the panel puts the keyboard in the list; after
  a folder opens the keyboard stays in the table.
- **States.** Loading the first listing shows still placeholder rows (no shimmer); a folder that
  cannot be listed says why with Try again; an empty folder says so and how to fill it; a folder
  of only hidden files says how many and offers Show hidden files; a filter with no match says so.
- **Transfer drawer** (`after/dark-panel-transfers.png`). A header line "Transfers · 2 running ·
  1 failed" that folds the list away (then it shows one bar and the overall percentage for what is
  still running). Each row: direction icon, name, percentage and Cancel, a 3 px bar, and
  "175 MB of 700 MB, 12 MB/s". The rate is smoothed and appears from the second progress report
  on. Failures are red with the reason. Clear finished keeps running transfers.

## Fixed on the way

- Icon buttons at the right edge of a panel had their centred tooltip (an invisible
  pseudo-element) sticking out past the window. That widened what the workspace could scroll, so
  focusing a field (inline rename) shifted the whole workspace 34 px sideways. Those buttons now
  use an end-aligned tooltip (`data-tooltip-side="bottom-end"`). UI tests check that the
  workspace does not overflow with the panel or the SFTP tab open. (`overflow: clip` on
  `.content` was tried as a second guard and dropped: it stops axe from scrolling off-screen
  parts of Settings into view, so its contrast check fails.)
- A menu opened from the keyboard now gives focus back to the row it was opened from (it used to
  read the opener after it had already moved focus into itself).

## Motion

Nothing new animates. Hover is a colour change; the drawer folds without a transition; the
progress bars are scaled with `transform` (composite-only). The indeterminate list progress bar
already stops under reduced motion.

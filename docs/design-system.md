# Design system: Quiet Precision

The design system of Tyrminal's desktop interface. Tokens live in
`apps/desktop/src/styles/tokens.css`; components use variables only, and no asset is loaded from
the network (fonts and icons are bundled, and the CSP forbids remote loads).

Where this file and the code disagree, the code is what ships: fix the file.

## The idea in one paragraph

The window is a quiet frame around the work. The sidebar, tab strip and status strip share one
tone. What they frame sits a step deeper: a page on the canvas, or a terminal in its own color
scheme. The selected tab is cut from the same material as what is below it, and with a terminal in
front the status strip is too, so a terminal, its tab and its status read as one object docked in
the frame. That object is the signature. Everything else stays out of its way.

## Planes

Every theme uses the same six planes. The values shown are Cobalt, the default.

| Plane | Token | Cobalt dark | Cobalt light | Used for |
|---|---|---|---|---|
| Canvas | `--bg-app` | `#0C111B` | `#F4F6FB` | Pages, the selected page tab |
| Frame | `--bg-sidebar` | `#0F1522` | `#EBEFF7` | Sidebar, tab strip, status strip on a page |
| Surface | `--bg-surface` (`--bg-box`, `--bg-strip`) | `#131A29` | `#FFFFFF` | Boxes of rows, side panels, group cells |
| Raised | `--bg-raised`, `--bg-overlay` | `#192235` | `#FFFFFF` | Buttons, menus, dialogs, palette, toasts |
| Field | `--bg-field` | `#090D15` | `#FFFFFF` | Text inputs, the Hosts search, path bars |
| Terminal | scheme background | Tyrminal Night `#0A0E17` | Tyrminal Day `#FCFDFF` | Terminal, its tab, pane title, status strip |

The accent marks focus, the current selection, identity (the brand mark and the terminal cursor)
and the one primary action of a view. It is not used for dividers, ordinary buttons or status.

Status (`--success`, `--warning`, `--danger`) always comes with text or an icon. Red on a tab's top
edge and around a pane means a production host (the P-26 guardrail) and nothing else; tabs carry no
decorative color.

## Themes

Themes are selectable, with a blue default; the verdigris palette is one theme among five. Each theme has a dark and a
light mode; Settings → Appearance chooses the theme and, separately, the mode (System, Light, Dark).

| Theme | id | Character | Accent, dark / light |
|---|---|---|---|
| Cobalt (default) | `cobalt` | Blue-black ink, cool paper | `#6AA5FF` / `#1F5FD1` |
| Verdigris | `verdigris` | The specification's obsidian ink and porcelain | `#68C9B7` / `#176D60` |
| Fjord | `fjord` | Blue slate, frost | `#88C0D0` / `#2E6894` |
| Graphite | `graphite` | Neutral gray, periwinkle | `#A9A6F7` / `#5148C9` |
| High contrast | `contrast` | Black or white, for low vision and bright rooms | `#FFD65C` / `#0040A0` |

How it works: the choice is the `palette` preference (an id, validated in the core like a terminal
scheme id; files from before it existed read as `cobalt`, and an id from a newer version shows the
default). `app/preferences.tsx` puts it on the root element as `data-palette`, absent for Cobalt,
and `styles/tokens.css` has one block per theme and mode. `app/themes.ts` names the themes and holds
the picker's preview colors. To add a theme: add its two blocks to `tokens.css`, an entry to
`app/themes.ts` and its two rows to `scripts/check-contrast.mjs`.

`pnpm check:contrast` checks every text, status, focus and control-boundary pair in all ten
combinations (1,269 pairs pass) and fails if a picker preview differs from its token. The
specification's candidate muted text (`#809099`) failed on overlays and was raised to `#93A2AB`.

Terminal color schemes are independent of the app theme and do not change with it. The two Tyrminal
schemes had their background, cursor and selection retuned to Cobalt, the default; their ANSI colors
and every third-party scheme are untouched.

## Type and geometry

- UI: the platform sans (SF, Segoe UI, system). Machine values (addresses, fingerprints, grid size,
  permissions) use the bundled JetBrains Mono with a slashed zero. No new font payload.
- Sizes 11 / 12 / 13 / 15 / 20 / 26 px. Body 13, page title 20, first-run title 26. Weights 400,
  500, 600. No all-caps labels.
- Spacing on a 4 px base. Controls 32 px (small 28). Host rows 48 px, dense rows 28–30 px, tab strip
  38 px, status strip 28 px.
- Radius by hierarchy: 4 px chips and small buttons, 6 px controls and nav rows, 8 px boxes, 10 px
  menus, 12 px dialogs and the palette. Tabs and panes attached to an edge are square.
- Elevation only on things that float. Boxes use a hairline (`--border-subtle`).
- Selection everywhere is the active fill plus a 2 px accent caret on the leading edge
  (`--edge-select`, or the rounded caret on nav rows).

## Composition

- **Shell.** Sidebar groups: Library (Hosts, Snippets, Tunnels, Recordings), Security (Keychain,
  Known hosts), New session (Local terminal, SFTP); Settings, Lock and Collapse at the foot. The
  one "Local · encrypted" statement lives in the status strip.
- **Tabs.** Every tab has the same width whether selected or not, so selecting moves nothing. The
  selected tab takes the fill of what is below and covers the strip's bottom rule.
- **Pages.** Every page uses the full width of its pane; nothing is a capped column with an empty
  right side. Prose keeps its own measure (80 characters).
- **Hosts.** One header row: the page name and a field that both finds a host and connects to an
  address; it stays in view while the library scrolls. Then one toolbar, group cells, and a single
  box of host rows (name and sign-in, address in mono, tags and state, actions). The empty library
  is the first-run screen and offers the three real ways to start. The page never scrolls sideways.
- **Host details.** A side panel of plain sections separated by hairlines, not cards in a panel.
- **Side panel** (Snippets, History, Appearance, Notes, Server). A surface with a plain title, its
  sections as a segmented choice, folder names as small labels and 44 px snippet rows on a 12 px
  inset; Run appears on the row under the pointer or with focus.
- **Segmented choice.** A recessed track with the chosen option lifted out of it (theme mode, list
  or cards, cursor style, panel sections). One look everywhere.
- **Connection sheet.** Fixed heading, scrolling body, fixed actions, so the risk statement and
  the choices are in view at any window size. A changed host key has a danger border and never
  animates.
- **Settings.** A second, lighter navigation column on the canvas; groups are boxes of rows. In a
  wide pane the groups flow into two columns (a container query, so it follows the pane, not the
  screen).
- **Tooltips.** Take no room until shown, so a button at a page's edge cannot widen the page.
- **Files and SFTP.** Shared table, path bar as a field, native path grants and truthful transfer
  progress, unchanged in behavior.

## Where the styles live

`styles/tokens.css` holds every value. `styles/global.css`, `box.css` and `hosts.css` are the
component base. `styles/precision.css` (shared surfaces) and `styles/workspace.css` (shell chrome)
are the Quiet Precision layer on top; they override by class and should be folded into the base
files section by section as those are next touched. No UI kit, icon set or motion library was added.

## Motion

CSS transitions and the Web Animations API only, with tokens in `tokens.css` and utilities in
`motion.css`. Motion answers the pointer, never the keyboard; nothing overshoots or runs longer
than 220 ms; everything that appears also leaves; `prefers-reduced-motion` turns movement off.

## Not covered by this design

Sync, accounts, teams, AI and mobile do not exist and have no screens or navigation. Windows and
Linux native rendering, touch input, high-refresh displays and screen readers have not been checked
by a person yet.

# Revamp: boxy language, a useful Home, a rebuilt Settings

Status: plan for the owner's review. Read against `origin/main` at 04b67e87 (after #42 Files redesign,
#45 security review, #41 notes, #35/#36 first screens). Follows `docs/design/overhaul.md` (tokens,
themes, motion, copy rules), `docs/design/files.md` and `docs/design/interaction-polish.md`. Nothing
here changes a theme colour, the accent, the type scale or a motion duration; it narrows radii, adds
a handful of structural tokens and moves every surface onto one container pattern.

Owner request (2026-10-12): Home is dated and should be more useful; the "Start" and "Keyboard" blocks
look strange; take the boxier look of SFTP across the app; update the Settings UI.

---

## 1. What makes SFTP boxy (measured, not guessed)

From `features/sftp/sftp.css` and `features/files/files.css` (PR #42):

| Trait | Where | Value |
|---|---|---|
| Full-bleed panes, no outer radius, no shadow | `.sftp`, `.sftp-pane` | radius 0; panes meet a 1 px `--border` divider |
| Header strip on every pane | `.sftp-head` 44 px, `.fp-nav` 40 px | `border-bottom: 1px solid var(--border-subtle)`, same fill as the body |
| Column-header strip | `.ft-table thead th` | 28 px, sticky, `--bg-surface`, 12 px `--text-muted` 500 |
| Dense single-line rows, no row borders | `.ft-table tbody tr` | 28 px, hover `--bg-hover`, tabular numbers |
| Selection as an edge, not a pill | `tr.is-selected td:first-child` | `--bg-selected` + `inset 2px 0 0 var(--accent)`; inactive pane: grey + `--border-strong` edge |
| "This one is live" marker | `.sftp-pane[data-active]::before` | 2 px `--accent` line on the top edge |
| Small inner radii | icon buttons, inline rename, path field | 3 px (`--radius-xs`) on inner controls |
| Footer / drawer strips | `.fp-footer`, `.xfer` | `border-top: 1px solid var(--border-subtle)`, 12 px tabular text |
| Drop target | `[data-drop]` | `inset 0 0 0 2px var(--accent)` (inside the box, never a glow) |

What breaks it today: the one pill swap button (`.sftp-swap`, `--radius-pill`) and the picker art
tile (`.sftp-picker-art`, 14 px radius). Both get fixed in PR 1.

In one sentence: **rectangles that share edges, labelled by a strip, filled with rows; colour only
marks state (an edge for selection, a top line for "live").** Everything else in the app is the
opposite: free-floating rounded cards on a canvas, each with its own padding (`.card`, `.tile`,
`.host-card`, `.settings-section`, `.snippet`, `.list`).

## 2. Design principles

1. **Boxes, not cards.** A container exists only to group rows under a strip label. It has a 1 px
   border, a 4 px (or 0 when edge-attached) radius, no shadow, no inner padding: rows touch its edges.
2. **Strips label things.** Every box opens with a 32 px strip: title (13/600), an optional count
   (tabular, faint), and right-aligned actions as small ghost buttons. No eyebrows, no uppercase.
3. **Rows carry the content.** 28 px dense rows in panels, 36 px rows on pages, 44 px for settings
   rows with a hint. Hairlines between rows only on pages (`--border-subtle`); tables in panels have none.
4. **State is an edge.** Selected = 2 px left accent edge; current/live = 2 px top accent edge;
   danger = 2 px left `--danger` edge. Never a glow, never a coloured card fill.
5. **Shared edges.** Adjacent boxes in a grid share their border (1 px gap on a `--border` background)
   instead of floating in 24 px of canvas. Groups of buttons share edges (a button strip).
6. **Floating things stay the only rounded-and-shadowed things** (menus, dialogs, palette, toasts),
   and even they go squarer (6 px).
7. **Keyboard hints are text, not key caps.** One quiet string ("Ctrl+Shift+K"), finishing tell T13
   from the overhaul that is still in `Shortcut`/`Keys`.
8. **Quiet motion, unchanged rules**: colour-only hover (100 ms), nothing animates on Home load,
   palette/keyboard-opened things never animate, reduced motion zeroes everything (`motion.css`).

Review against the brief (two-pass check): the first draft made Home a dashboard of 8 equal widgets
in a 3-column card grid. That is the SaaS-card default (calibration item 4) and buries the two things
people do on Home (connect, return to a session). Changed to: one quick-connect strip, one wide
primary box (sessions + recents), a narrow status column, and everything else as rows, not widgets.
The second draft used zero radius everywhere; that tips into the "broadsheet hairline" default
(item 3) and makes inputs look like table cells. Changed to 0 only for edge-attached panes, 4 px for
page boxes and controls, 6 px for floating surfaces.

## 3. Token changes (`apps/desktop/src/styles/tokens.css`)

Radii (old names keep working, values tighten):

| Token | Today | New | For |
|---|---|---|---|
| `--radius-inner`, `--radius-xs` | 3 | **2** | tags, badges, chips, checkboxes, key hints, inner icon buttons |
| `--radius-sm` | 4 | **3** | small buttons, segmented thumbs |
| `--radius-control` | 6 | **4** | buttons, inputs, selects, segmented, menu items, tabs |
| `--radius-panel` | 8 | **4** | page boxes, popovers, notices |
| `--radius-dialog` | 10 | **6** | dialogs, palette, toasts, menus |
| `--radius-pill` / `--radius-round` | 999 | 999 | **only** switch tracks and status dots |
| new `--radius-box` | | **4** | `.box` on a page |
| new `--radius-edge` | | **0** | panes attached to window edges (side panels, SFTP, Files, settings nav pane) |

Structure (new):

| Token | Value | Notes |
|---|---|---|
| `--strip-height` | 32px | box header strips (between `th` 28 and pane head 44) |
| `--strip-height-pane` | 44px | equals `.sftp-head`; Files panel head and settings section head adopt it |
| `--row-dense` | 28px | equals `.ft-table` rows; panels, palette, snippets panel |
| `--row-height` | 36px | unchanged; page tables |
| `--row-setting` | 44px | settings row with label + hint |
| `--box-border` | `1px solid var(--border)` | outer box edge |
| `--box-rule` | `1px solid var(--border-subtle)` | strip bottom, row separators |
| `--edge-select` | `inset 2px 0 0 var(--accent)` | selected row (lifted from `.ft-table`) |
| `--edge-live` | `inset 0 2px 0 var(--accent)` | current box/tab/pane (as `.sftp-pane[data-active]`) |
| `--edge-danger` | `inset 2px 0 0 var(--danger)` | danger rows and notices |
| `--bg-strip` | `var(--bg-surface)` | strip fill = `th` fill |
| `--bg-box` | `var(--bg-raised)` | box body; rows hover `--bg-hover`, select `--bg-selected` |
| `--box-gap` | 1px | grid gap for shared-edge layouts (grid background `--border`) |

Contrast: no new colour pairs. `--text-muted`/`--text-faint` on `--bg-surface` and `--bg-raised` and
on `--bg-selected` are already in `scripts/check-contrast.mjs`; add the pair "`--accent` edge on
`--bg-raised`" (3:1, non-text) for all six themes. Focus ring stays `outline: 2px solid var(--focus)`;
inside a box with `overflow: hidden` use `outline-offset: -2px` so it is never clipped.

## 4. Primitives (new and changed)

`apps/desktop/src/styles/box.css` (imported from `global.css`) and `components/ui/Box.tsx`:

- `.box` = `border: var(--box-border); border-radius: var(--radius-box); background: var(--bg-box);
  overflow: hidden`. `.box[data-edge]` drops radius and side borders (edge-attached).
- `.box-strip` = flex, `height: var(--strip-height)`, `padding: 0 var(--space-2) 0 var(--space-3)`,
  `background: var(--bg-strip)`, `border-bottom: var(--box-rule)`; `h2/h3` 13/600, `.box-count`
  12 px faint tabular; actions are `.btn-ghost.btn-sm`.
- `.box[data-live]` gets `box-shadow: var(--edge-live)` (used for the focused session tab's box, the
  current settings section, the active SFTP pane).
- `.dt` (data table) = the `.ft-table` rules generalised: sticky 28 px `th` strip, `tr` at
  `--row-height` (`.dt[data-dense]` 28), `td + tr` hairlines on pages, hover/selected/pressed exactly
  as `.ft-table`. `files.css` keeps `.ft-table` but takes its values from the same tokens, so the two
  never drift.
- `.box-grid` = `display: grid; gap: var(--box-gap); background: var(--border); border: var(--box-border)`
  so children share edges. Children use `.box[data-flush]` (no border of their own).
- `.btn-strip` = joined buttons (`margin-left: -1px`, outer corners only), for Home actions and
  segmented-like action groups.
- `<Box title count actions live edge>{rows}</Box>` in React, and `<BoxEmpty>` for the in-box empty
  row (left-aligned, one sentence, one action), replacing `EmptyState`'s icon tile + dashed rings.
- `Shortcut`/`Keys` render one `<kbd class="hint">Ctrl+Shift+K</kbd>` (no border, `--text-faint`,
  12 px, `--radius-inner`), platform-formatted from `lib/shortcuts.ts` (`⌘K` style on macOS).
- `.eyebrow` loses `text-transform`/`letter-spacing` (becomes 12/500 muted), so every remaining use
  (sidebar groups, palette groups) reads as a strip label.

## 5. Home

### 5.1 What is there now (`features/home/HomeView.tsx`, `.home-grid`, `.tile`, `.tips`)

- Title "Home" + a subtitle sentence; a 19 px search icon quick-connect field with `Shortcut` key caps.
- Left: "Open sessions" tile grid, "Recent connections" tile grid (initial avatars, `→` on every
  tile), and a "Hosts" tile grid that duplicates the Hosts page.
- Right 300 px column: **"Start"** = a card with an uppercase eyebrow and five tiles (Local terminal,
  SFTP, Add host, Snippets, Keychain), each a 34 px tinted icon tile + title + sub-line, i.e. cards
  inside a card; **"Keyboard"** = a card with an uppercase eyebrow and five rows of triple key caps.
- Empty vault: a centred `EmptyState` in a card ("Welcome to Tyrminal", two buttons).

Why it reads as dated: it is the card kit (T6) with avatar tiles (T5), arrows (T7), eyebrows (T4)
and key caps (T13), the overhaul items that were never applied to Home. "Start" is a launcher of
links the sidebar already has, and "Keyboard" is a static cheat sheet; neither tells you anything
about *your* state. Nothing on Home is live except open tabs.

### 5.2 New Home

Page column (`--page-max` 1080, left-aligned, 32 px gutter). Title row "Home" without a subtitle.

```
Home
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ⌕  Search hosts or type user@host:port                            Ctrl+Shift+K    │ 36px strip input
└──────────────────────────────────────────────────────────────────────────────────┘
[+ New host][Import][Local terminal][SFTP][Generate key]             Shortcuts  (btn-strip, 30px)

┌ Sessions 3 ───────────────────────────── New tab ┐┌ Vault ─────────────────────────┐
│● api-gateway   deploy@10.20.0.11      120×40      ││ Unlocked   Quick unlock on      │
│◌ db-primary    Signing in                         ││ Hosts 42   Keys 6   Snippets 18 │
│○ Local terminal  zsh                              ││ Lock now         Export backup  │
├ Recent 6 ──────────────────────────── All hosts ─┤├ Security review 3 ─────── Open ─┤
│ Name          Address              Sign-in  When  ││▌ 1 key without a passphrase     │
│ ⌂ api-gateway deploy@10.20.0.11:22 Key      2 m   ││▌ 1 host signs in with a password│
│ ⌂ bastion     ops@203.0.113.7      Agent    1 h   ││  1 unused known host            │
│ ⌂ stg-web     www@stg.example.net  Password 3 d   ││  Checked 4 min ago, on this device│
├ Snippets 18 ────────────────────────── Library ─┤├ Port forwards 1 ───── Tunnels ───┤
│ deploy.sh    git pull && make deploy     Run in…  ││● web  127.0.0.1:8080 → :80  2 conn│
│ tail-logs    journalctl -fu app          Run in…  ││  Saved 4, 1 starts automatically │
└──────────────────────────────────────────────────┘└─────────────────────────────────┘
```

Grid: `minmax(0, 1fr) 320px`, `.box-grid` per column so boxes stack with shared 1 px edges; below
980 px one column (status column moves under). Every box is a `<section aria-labelledby>` with an
`h2` in its strip, so headings stay navigable (H key in screen readers).

| Widget | Data source (existing only) | Behaviour |
|---|---|---|
| Quick connect | `useVaultData().hosts`, `parseDestination`, `hosts.save` (unchanged) | Same combobox; results list becomes a `.box` dropdown with 28 px rows and a server/OS icon instead of `Avatar`. A new destination is saved then goes through the normal connect flow, so trust and auth prompts are unchanged. |
| Action strip (replaces **Start**) | callbacks already passed to `HomeView` (`onLocal`, `onSftp`, `setEditing("new")`) plus `importer` dialog (`hosts/ImportDialog.tsx`) and `keys.generate` dialog (Keychain's) | Five joined buttons, label + icon, shortcut in the tooltip only. "Shortcuts" (ghost, right) opens Settings → Keyboard shortcuts (`settingsAt.section = "shortcuts"`). This replaces the **Keyboard** card: shortcuts live in tooltips, the palette and Settings. |
| Sessions | `ws.tabs`, `tabStatus`, `tabTitle`, `statuses` (props, unchanged) | Rows: status dot, title, identity (mono), size. Enter/click switches tab. Strip action "New tab" = `onLocal`. Hidden when no tabs. Keeps list name "Open sessions". |
| Recent | `useVaultData().recent` (`lastConnectedAt`, `auth.kind`, address, port); OS icon from `appearance.list()` | `.dt` table, 6 rows. Single click selects, double-click/Enter connects (interaction-polish §2), row menu = Hosts row menu. No `→`. "All hosts" goes to Hosts. Empty: one row "Hosts you connect to appear here." |
| Vault | `vault.quickUnlockStatus()`, counts from `useVaultData()` (`hosts`, `keys`, `snippets`), Lock = the shell's existing lock action, Export = `ExportBackupButton` | No dates we do not have: the contracts have no "last backup" time, so none is shown (see question 3). |
| Security review | `securityReview.run()` (local, read-only, returns labels and counts, never secrets) | Run once per unlock after first paint (idle callback), cached in memory with the vault lists. Shows the top 3 finding kinds as counted sentences with a 2 px edge (`--danger` for DSA/short RSA/expired cert, `--warning` otherwise) and "Checked N min ago, on this device". "Open" goes to Settings → Security review. No findings: "Nothing to review across 6 keys and 42 hosts." Never calls `passwordCheck.run` (network). |
| Snippets | `useVaultData().snippets` (6 most recently updated) | Name + first line (mono, truncated). "Run in…" opens the existing target picker / `MultiRunDialog`; disabled with tooltip when no session is open. Nothing is sent from Home without the existing review and confirmations (paste safety P-25). |
| Port forwards | `tunnels.active()`, `tunnels.list()` | Running forwards with dot, bind → dest (mono), live connections; Stop uses `tunnels.stop` (existing). Starting needs a session, so it is not offered here; "Tunnels" opens the page. Hidden if none saved. |

Left out on purpose:
- **Favourites/pinned**: `HostSummary` has no such field; adding one is a vault/contract change
  (question 1). Until then "Recent" is the shortcut list.
- **Recent transfers**: transfer lists live inside each Files panel/SFTP tab (`files/transfers.ts`
  owners), not window-wide. A window-level in-memory store is a follow-up; no IPC change.
- **Command history and notes**: `history.list()` can contain typed secrets on command lines and notes
  are encrypted per host; showing either on an always-visible screen widens exposure. Not on Home.

First run (no hosts): quick connect focused, the action strip, then one box "Get started" with four
36 px rows (Add a host / Import from an SSH config, PuTTY, MobaXterm or SecureCRT / Generate a key /
Open a local terminal), each a sentence on what it does. Keeps the heading "Welcome to Tyrminal".

## 6. Settings

### 6.1 Problems today (`features/settings/SettingsViews.tsx`, `WorkspaceSettings.tsx`, `AboutSection.tsx`, `SecurityReviewSection.tsx`)

1. One long scroll of eight rounded cards (`.settings-section`, 24 px padding, radius 8) on the canvas.
2. The 200 px nav only changes `aria-current` on click, so it is wrong as soon as you scroll; it uses
   `scrollIntoView({ behavior: "smooth" })` (motion the reduced-motion setting does not stop).
3. "Highlighting" is rendered (`#settings-highlight`) but missing from the nav.
4. Four row patterns: `SettingRow` (grid 1fr / 200–300 px), `Switch` (`.switch-row`, its own layout,
   switch not in the control column), bare button rows (`.row-flex`), and `.settings-row`, which has
   **no CSS at all** (Updates, Diagnostics).
5. Terminal is one 150-line section: a 220 px preview, a card grid of 20+ scheme cards (150 px each),
   then ten rows and five switches in an unlabelled `<div>`.
6. Security mixes explanatory paragraphs, two bare buttons and two sub-components with their own
   layouts; the "Status" warning notice sits permanently in Privacy.
7. No search, although there are ~60 settings.

### 6.2 New structure

Two edge-attached panes inside the page area, like SFTP: a 224 px nav pane and a section pane, joined
by a 1 px divider. One section shows at a time (no scroll-spy to get wrong, no smooth scroll).

```
┌ Settings ──────────────┬───────────────────────────────────────────────────────────────┐
│ ⌕ Search settings      │ Terminal                                       Reset section  │ 44px strip, --edge-live top
├────────────────────────┤ How sessions look and behave. Changes apply at once.          │
│ General                │                                                               │
│▌Appearance             │ ┌ Colour scheme ────────────────┬ Preview ──────────────────┐ │
│ Terminal               │ │◉ Tyrminal Night  ▇▇▇▇▇▇▇▇     │ deploy@api:~$ ls -la       │ │
│ Keyboard shortcuts     │ │○ Solarized Dark  ▇▇▇▇▇▇▇▇     │ (live xterm, inert)        │ │
│ Highlighting           │ │○ Paper           ▇▇▇▇▇▇▇▇  ⚠  │                            │ │
│ Security               │ └───────────────────────────────┴────────────────────────────┘ │
│ Vault and unlock       │ ┌ Text ─────────────────────────────────────────────────────┐ │
│ Security review     3  │ │ Font                                  [JetBrains Mono  ▾] │ │
│ Password check         │ │ Size                                  [────●───]  13 px   │ │
│ Data                   │ │ Ligatures         Joins => and != … [          (●)]       │ │
│ Backup                 │ └───────────────────────────────────────────────────────────┘ │
│ Privacy                │ ┌ Cursor ┐ ┌ Behaviour ┐ ┌ Local shell and editors ┐  …      │
│ About            0.9.0 │                                                               │
└────────────────────────┴───────────────────────────────────────────────────────────────┘
```

- **Nav pane** (`--bg-sidebar`, `data-edge`): search field at top (36 px), group labels as 28 px
  strips (12/500 muted, sentence case: General, Security, Data), items 30 px with the overhaul's
  cursor marker plus a 2 px accent left edge on the current one; a count where it means something
  (Security review findings). `nav` keeps `aria-label="Settings"` and `aria-current="page"`.
  Up/Down move between items, Enter opens (roving tabindex).
- **Section pane**: 44 px strip (title 15/600, one-sentence description below at 12 px muted, a
  section action like "Reset section" right). Body is a column (max 760 px) of **groups**, each a
  `.box` with a strip label and rows.
- **One row component** `SettingRow` with variants: `control` (select, range, segmented), `switch`
  (the switch sits in the same right column; whole row is the label), `action` (button right,
  e.g. "Change passphrase…"), `link` (navigates, e.g. "Open Keychain"). Grid
  `minmax(0,1fr) 280px`, min-height `--row-setting`, `padding: var(--space-2) var(--space-3)`, hairline
  between rows. Label 13/500, hint 12 muted below, `max-width: 60ch`. `.settings-row` and the
  separate `.switch-row` layout go.
- **Search**: a static index `features/settings/settingsIndex.ts` (`{ section, group, label, hint,
  id }` from the same message strings). Typing filters the nav to matching sections and shows a result
  list in the pane (28 px rows "Terminal / Text / Font size"); Enter opens the section and focuses the
  row (`id` anchor, focus-visible ring, no scroll animation). Esc clears. No match: "No setting
  matches “x”."
- **Sections and groups**:
  - Appearance: Theme (Mode segmented, Palette swatches), Motion (Reduce motion).
  - Terminal: Colour scheme (a 28 px radio list with an 8-colour strip and the low-contrast warning
    icon, replacing the 150 px card grid) side by side with the live preview at >= 1100 px, stacked
    below; Text (font, size, line height, letter spacing, padding, ligatures); Cursor (style, blink);
    Behaviour (scrollback, renderer, confirm paste, copy on select); Local shell and editors.
  - Keyboard shortcuts and Highlighting: existing `WorkspaceSettings` content inside groups; shortcut
    rows become a `.dt` (action, binding as text, Change).
  - Vault and unlock: Passphrase (action), Recovery key (action), Quick unlock (switch row),
    Auto-lock (the current sentence as the group hint).
  - Security review: the existing findings list as a `.dt` with danger/warning edges; "Run again" in
    the strip.
  - Password check: the existing `PasswordCheckSetting` (off by default; still says it sends a hash
    prefix before anything is enabled).
  - Backup: Export (action), Restore (action, keeps its dialog and passphrase prompt).
  - Privacy: Diagnostics (switch + "Save report"), Updates (link row).
  - About: version table; the "Status" notice moves here from Privacy.
- Every setting still applies and saves on change (`usePreferences().update`); `saveError` shows as a
  danger strip under the section strip. Explicit confirmations stay where they are (passphrase,
  recovery key, restore, shortcut reset).

## 7. Boxy language, surface by surface

| Surface | Today | Change | Files |
|---|---|---|---|
| Cards (`.card`, `.card-pad`) | radius 8, 24 px padding, floating | Retire for layout; `.box` + strip. `.card` remains only as an alias of `.box` until the last use goes | `styles/global.css`, all users |
| Tiles (`.tile`, `.tile-icon`, `.tile-grid`) | rounded tiles with 34 px tinted icon squares | Rows in a `.box`; icon 16 px, no tinted square | `global.css`, Home, Tunnels, Keychain, Security review |
| Lists (`.list`, `.list-row`) | rounded panel, 56 px rows | `.box` + `.dt` rows 36 px, actions on hover/selection | `global.css`, Tunnels, Security review |
| Empty states (`.empty`, `.empty-art`) | centred, 72 px icon tile, gradient, two dashed rings | `BoxEmpty`: left-aligned row in the box, 15 px heading only on full-page empties | `controls.tsx`, `global.css` |
| Sidebar (`.sidebar`, `.nav-item`, `.sidebar-search`) | 34 px rounded items, uppercase group labels | Edge-attached pane; items 32 px, radius 0, current = `--bg-active` + 2 px left accent edge; group labels as 28 px strips; search 30 px radius 4 | `components/layout/Sidebar.tsx`, `global.css` |
| Tab strip (`.tab`) | 34 px tabs with rounded top corners | Square tabs sharing 1 px dividers; active tab = page colour + `--edge-live` top line (as the SFTP pane) | `TabStrip.tsx`, `global.css` |
| Status bar | already a strip | `border-top: var(--box-rule)`; items separated by 1 px rules | `StatusBar.tsx` |
| Hosts grid (`.host-card`) | rounded cards, hover lift `translateY(-1px)` + shadow, pills | Grid cells in a `.box-grid` (shared edges), no lift/shadow, tags as 2 px-radius tags; selected cell = `--edge-select` | `features/hosts/HostsView.tsx`, `global.css` |
| Hosts list, group filter (`.chip`) | pills with stray `…` buttons | `.dt` table in a box; group filter becomes a select in the toolbar strip | `HostsView.tsx` |
| Avatars (`Avatar`) | initials on hue-gradient 10 px tiles | Server/OS icon from `appearance.list()` (16 px, muted); remove `Avatar` | `controls.tsx`, Home, Hosts, palette, `sidepanel/ConnectionPanel.tsx` |
| Keychain, identities | `.btn-sm` rows in stacks, tile icon | Two boxes ("Keys", "Identities") with `.dt` (name, type, fingerprint mono middle-truncated, used by) | `features/credentials/KeychainView.tsx` |
| Known hosts | 900 px column, list | One box, `.dt`; a changed key row gets `--edge-danger` and a "Changed" tag | `SettingsViews.tsx` (`KnownHostsView`) |
| Snippets page (`.snippet`) | one rounded card per snippet | Folder boxes with `.dt` (name, first line mono, lines); editing in side panel unchanged | `features/snippets/SnippetLibrary.tsx`, `global.css` |
| Snippets/side panels | rounded rows | `data-edge` panes with 44 px head strip and 28 px rows, matching the Files panel | `features/sidepanel/*`, `global.css` |
| Tunnels, Recordings | `.list` + `.section-head` | Boxes "Running" and "Saved" / one recordings box, `.dt` | `features/tunnels/TunnelsView.tsx`, `features/history/RecordingsView.tsx` |
| Command palette | radius 10, 40 px items radius 6, eyebrow groups | Radius 6, items 28 px square with `--edge-select`, groups as 28 px strips, shortcut as text hint, footer strip | `features/palette/CommandPalette.tsx`, `global.css` |
| Dialogs | radius 10, padded head | Radius 6; 44 px title strip with `--box-rule`; footer strip with actions right; body padding 16 | `components/ui/Dialog.tsx`, `global.css` |
| Menus, popovers, tooltips | radius 6, 5 px padding | Menus and popovers `--radius-panel` (4), padding 4, items 28 px radius 2; tooltips radius 2 | `components/ui/Menu.tsx`, `global.css` |
| Toasts | radius 6 | Radius 6 (dialog token), 2 px left status edge instead of tinted icon area | `components/ui/Toasts.tsx`, `global.css` |
| Notices | radius 6, full border | Radius 4, 2 px left status edge on soft fill (overhaul "Notices") | `global.css` |
| Buttons | radius 6, primary has inset highlight + drop shadow, press `scale(0.985)` | Radius 4; drop the primary's shadows (flat fill); keep press feedback per `motion.css`; `.btn-lg` radius 4 | `global.css` |
| Inputs, selects, segmented | radius 6 | Radius 4; segmented thumb radius 2, track inset 2 px | `global.css` |
| Tags, badges, chips | pills | Radius 2, 20 px, `--bg-hover` fill; status colours only for status | `global.css` |
| Kbd caps (`kbd`, `.kbd-group`) | bordered caps with 2 px bottom border, one per key | Single text hint (§4) | `controls.tsx`, `global.css` |
| SFTP leftovers | pill swap button, 14 px picker art | Swap = 24 px square, radius 2; picker art removed (left-aligned picker like other empties) | `features/sftp/sftp.css`, `SftpView.tsx` |
| Connection sheet, onboarding, unlock | recent work, mostly square already | Only token-driven radius change; no layout change | none |

## 8. Accessibility and security guardrails

- Contrast: no new colour values; the one new non-text pair (accent edge on raised) is added to
  `check-contrast.mjs` for all six themes. Selection never relies on the edge alone: `--bg-selected`
  plus `aria-selected`/`aria-current` stay.
- Focus: one outline ring; boxes with `overflow: hidden` use `outline-offset: -2px` on rows so it is
  never clipped. Every strip action has an accessible name; icon-only ones a tooltip.
- Landmarks/headings: each Home box and settings group is a `section` with a heading; settings nav
  keeps its `nav` name and `aria-current`.
- Motion: nothing new animates. Settings drops `behavior: "smooth"`. Home does not animate in.
  Reduced motion already zeroes press feedback.
- Forced colours: edges use `box-shadow`, which Windows contrast themes drop, so selected/live rows
  also get `outline: 1px solid Highlight` under `@media (forced-colors: active)`.
- Security: Home shows only labels, addresses, counts and states; no fingerprints in full, no
  secrets, no history, no notes. Nothing connects, runs or sends from Home without the existing
  flow: connect goes through trust and auth prompts; snippets through the target picker and paste
  review; quick connect still saves first. The security review is local and read-only; the password
  check (the only networked check) is never triggered from Home.

## 9. Delivery: five PRs

PR 1 lands first (tokens and primitives). PRs 2 to 5 depend only on PR 1 and not on each other, so
they can go in any order. No screenshot re-records (visual baselines are skipped); each PR keeps
`pnpm verify:fast`, `node scripts/check-contrast.mjs` and the UI suite green and updates the
functional specs named.

**PR 1: Box tokens and primitives**
- Files: `apps/desktop/src/styles/tokens.css` (radii, structural tokens), new `styles/box.css`,
  `styles/global.css` (buttons, inputs, segmented, tags/badges/chips, notices, kbd, `.eyebrow`,
  `.empty*`, `.card` alias), `components/ui/controls.tsx` (`Shortcut`/`Keys` as one hint string,
  `BoxEmpty`), new `components/ui/Box.tsx`, `features/files/files.css` (read shared tokens),
  `features/sftp/sftp.css` (square swap, picker art), `scripts/check-contrast.mjs` (edge pair),
  `docs/design-system.md`.
- Specs: `accessibility.spec.ts` (axe, focus ring visible on a `.dt` row inside a box),
  `sftp.spec.ts` (swap button name unchanged), `files.spec.ts` (table unchanged). No spec reads key
  caps today (only `connection.spec.ts`'s unrelated `kbd-question` test id). Add one case to
  `behavior.spec.ts`: a shortcut hint renders as a single text string.

**PR 2: Home**
- Files: `features/home/HomeView.tsx` (split into `home/QuickConnect.tsx`, `home/HomeBoxes.tsx`),
  `lib/messages.ts` (`home.*`: drop `actions`, `shortcuts`, `*Body`, `allHosts`; add box titles and
  sentences), `styles/global.css` (remove `.home-grid`, `.tips`, Home uses of `.tile`),
  `app/AppShell.tsx` (pass lock, import and generate-key callbacks; Settings section for "Shortcuts").
- Specs: `behavior.spec.ts` (Home heading), `workspaces.spec.ts` ("Open sessions" list on Home),
  `accessibility.spec.ts` (Home axe), new `tests/ui/home.spec.ts`: quick connect saves then connects
  through the trust prompt; Recent double-click connects and single click only selects; Snippets
  "Run in…" opens the picker and sends nothing by itself; Security review box shows counts from the
  mock and never calls `password_check_run`; first run shows "Welcome to Tyrminal" with four rows.

**PR 3: Settings**
- Files: `features/settings/SettingsViews.tsx` (split into `settings/SettingsShell.tsx`,
  `settings/sections/*.tsx`), new `settings/settingsIndex.ts`, `components/ui/controls.tsx`
  (`SettingRow` variants; `Switch` as a row variant), `features/layouts/WorkspaceSettings.tsx`,
  `features/security-review/SecurityReviewSection.tsx`, `features/password-check/*`,
  `features/settings/AboutSection.tsx`, `styles/global.css` (`.settings-*`, `.scheme-*`, `.switch-row`),
  `lib/messages.ts` (group names, search strings).
- Specs: one section at a time means specs that reach a control without choosing a section add a
  nav click: `settings.spec.ts` (Terminal; Privacy), `password-check.spec.ts`, `highlight.spec.ts`,
  `mouse.spec.ts`, `security-review.spec.ts`, `about.spec.ts` (About last in nav, `aria-current`,
  sidebar version opens About), `workspaces.spec.ts` (Keyboard shortcuts heading and nav button),
  `accessibility.spec.ts` (axe over each section). New cases: search finds "Font size" and focuses
  it; Highlighting is reachable from the nav; nav `aria-current` follows the shown section.

**PR 4: Shell and floating surfaces**
- Files: `components/layout/Sidebar.tsx`, `TabStrip.tsx`, `StatusBar.tsx`,
  `components/ui/Dialog.tsx`, `Menu.tsx`, `Toasts.tsx`, `features/palette/CommandPalette.tsx`,
  `styles/global.css` (sidebar, tabs, dialog, menu, toast, palette blocks).
- Specs: `workspaces.spec.ts` (tab strip roles and names unchanged), `palette-actions.spec.ts`
  (group names), `about.spec.ts` (sidebar version), `accessibility.spec.ts`.

**PR 5: Lists onto boxes**
- Files: `features/hosts/HostsView.tsx` (grid cells, list `.dt`, group select, remove `Avatar`),
  `features/credentials/KeychainView.tsx`, `features/identities/*`, `KnownHostsView` in
  `SettingsViews.tsx`, `features/snippets/SnippetLibrary.tsx`, `features/tunnels/TunnelsView.tsx`,
  `features/history/RecordingsView.tsx`, `features/sidepanel/*`, `styles/global.css` (`.host-card*`,
  `.chip*`, `.list*`, `.snippet*`, `.avatar*` removed).
- Specs: `inventory.spec.ts`, `inventory-presentation.spec.ts`, `host-panel.spec.ts`,
  `identities.spec.ts`, `inventory-keys.spec.ts`, `snippets-runs.spec.ts`, `tunnels.spec.ts`,
  `history.spec.ts`, `sidepanel.spec.ts` (row roles stay `row`/`option`/`listitem` as today; update
  only selectors that used `.host-card`, `.chip`, `.snippet` classes).

Feature matrix: these are presentation changes on existing rows; no row changes state. Each PR
records which UI specs it updated in its description and `docs/progress.md`.

## 10. Questions for the owner

1. **Favourites**: add a "Pinned" flag to hosts (vault field + contract) so Home can show pinned
   hosts above Recent? It is the one widget the data does not support today.
2. **Settings one-section-at-a-time** (with search) instead of one long scroll. Agreed?
3. **Backup reminder**: show "Last exported N days ago" on Home? Needs the core to record the export
   time (non-secret, local). Not shown until it exists.
4. **Hosts default view**: with boxy grid cells, keep the grid as default, or switch to the list
   table as the overhaul proposed?

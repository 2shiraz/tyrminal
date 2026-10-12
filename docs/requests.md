# Owner requests during testing

Requests the owner makes while testing builds. Each is mapped to a feature-matrix row and an
agent (see `docs/work-split.md`); a request with no matching row gets a new `P-` row.

| Date | Request | Matrix row | Phase | Owner agent | Status |
|---|---|---|---|---|---|
| 2026-10-12 | Import a private key from a key file (not only pasted text) | KEY-01 (key import: file or pasted text) | 04 | D | requested |
| 2026-10-12 | Terminal output highlighting like Termius (IPs, numbers, keywords) | TRM-07 (output highlighting) | 05 | terminal input | first priority |
| 2026-10-12 | Files panel must not reconnect and reload when switching tabs | FIL-10 (terminal/SFTP switching) | 06 | SFTP tab | done (per-session panel memory) |
| 2026-10-12 | A dedicated SFTP tab like Termius: two switchable panes, host picker, transfers | FIL-02 (two-pane file manager) | 06 | SFTP tab | done in PR #18 |
| 2026-10-12 | Version info in the app (About, sidebar, vault screens) | UX-05 (update controls) | 09 | coordinator | done (Settings → About, `app_info`) |
| 2026-10-12 | Clicking a file gives no visible feedback (Files panel and SFTP tab) | FIL-07 (directory navigation), FIL-02 | 06 | SFTP tab | done in PR #18: selected style, pressed state, multi-select and keys, loading state, selection footer |
| 2026-10-12 | Autosave like Termius wherever possible, so editing feels fast | HST-02/03/04/05 editors (host panel, group editor, environment); design: docs/design/interaction-polish.md §3 | 04 | D | done on `claude/autosave`: per-field autosave (400 ms / blur), 10 s undo, route as one unit, secrets set explicitly; settings already applied on change; UI tests only, no IPC change |
| 2026-10-12 | Files section at Termius/Transmit quality: quiet toolbar, editable path, sortable table, context menu, inline rename, keyboard and type-ahead, transfer drawer, clear states, two panes with an active pane and swap | FIL-01, FIL-02, FIL-06, FIL-07, FIL-08 | 06 | SFTP tab | done in PR #42 and #48 (`docs/design/files.md`) |
| 2026-10-12 | Connect more than one SFTP server at once (location tabs per pane), and Open in SFTP from a host or a session | FIL-02, FIL-10 | 06 | SFTP tab | done on `claude/sftp-tab` (location tabs, Open in SFTP from the host menu, Host details, palette and Files panel) |

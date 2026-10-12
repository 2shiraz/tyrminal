# Owner requests during testing

Requests the owner makes while testing builds. Each is mapped to a feature-matrix row and an
agent (see `docs/work-split.md`); a request with no matching row gets a new `P-` row.

| Date | Request | Matrix row | Phase | Owner agent | Status |
|---|---|---|---|---|---|
| 2026-10-12 | Import a private key from a key file (not only pasted text) | KEY-01 (key import: file or pasted text) | 04 | D | requested |
| 2026-10-12 | Terminal output highlighting like Termius (IPs, numbers, keywords) | TRM-07 (output highlighting) | 05 | terminal input | first priority |
| 2026-10-12 | Files panel must not reconnect and reload when switching tabs | FIL-10 (terminal/SFTP switching) | 06 | SFTP tab | done (per-session panel memory) |
| 2026-10-12 | A dedicated SFTP tab like Termius: two switchable panes, host picker, transfers | FIL-02 (two-pane file manager) | 06 | SFTP tab | in progress |
| 2026-10-12 | Clicking a file gives no visible feedback (Files panel and SFTP tab) | FIL-07 (directory navigation), FIL-02 | 06 | SFTP tab | done in PR #18: selected style, pressed state, multi-select and keys, loading state, selection footer |

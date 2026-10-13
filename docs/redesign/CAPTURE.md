# Reproducible redesign evidence

The capture harness uses the existing production frontend build and existing test-only in-memory
backend. It makes no native SSH connection, accesses no user vault and executes no remote command.
It does not establish native or backend verification. Source: `tests/ui/redesign-capture.ts`,
with `tests/ui/redesign-capture.config.ts` isolated from existing visual regression baselines.

## Reproduce

Build the appropriate revision with `pnpm --filter @tyrminal/desktop build`, then:

```sh
cd tests/ui
REDESIGN_STAGE=before pnpm exec playwright test -c redesign-capture.config.ts
REDESIGN_STAGE=after pnpm exec playwright test -c redesign-capture.config.ts
```

On this machine, the Playwright-pinned Chromium revision 1194 is absent. Existing Chromium revision
1243 was used through the explicit executable override, without downloading another browser:

```sh
TYR_UI_PORT=4320 TYR_BROWSER_EXECUTABLE=/Users/shiraz/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell pnpm exec playwright test -c redesign-capture.config.ts
```

The preview server binds only `127.0.0.1`; sandbox loopback restriction required an approved
escalation. `reuseExistingServer: false` prevents accidentally capturing another checkout or build.

## Baseline matrix

Before images are `docs/redesign/before/<width>x<height>-<theme>-<state>.png`.
The same capture names and viewport dimensions are used for after images. There are 22 states in
each theme at 1360×860, minimum desktop 820×620, and wide desktop 1920×1080: **132 images**.

States: onboarding (no secrets entered), unlock (empty), empty host library, libraries with exactly
1/20/500 synthetic hosts, search results, no results, new host editor, terminal, connected split,
keyboard-active command palette, contextual files panel, appearance settings, terminal settings,
connecting, authenticating (empty secret field), authentication failure, unknown host-key trust,
changed-key warning, SFTP picker and SFTP local/remote panes.

Assertions verify visible relevant state, exact synthetic library cardinality, connection success,
split pane count, palette input focus, files grids and distinct host-key fingerprint counts.
Page errors fail tests. The harness never catches and skips failed screenshots. Existing terminal
demo output is cleared, including scrollback, and replaced with a command-free synthetic glyph
sample before capture; no secret is typed and recovery keys are not captured. Screenshot timing
includes 100 ms for xterm's asynchronous render and disables interface animations; this is still
evidence, not motion evidence.

Baseline build existed before app source edits; its `dist/index.html` mtime was
2026-10-13T19:59:11.149Z. Checkpoint HEAD: `8b8da8ae6a0c8dd019928fe97e9396d20c96e35e`.
Measured disk usage (`du -sk`): frontend dist 4040 KiB, assets 1720 KiB, fonts 2316 KiB. These are
filesystem allocation sizes, not transfer/gzip sizes or startup performance. Startup, frame-rate,
real GPU and native WebView responsiveness are not measured by this capture harness.

## Baseline visual observations

Representative individual images inspected through image tooling include the 1360 dark host list,
1360 light new-host editor, 820 dark changed-key warning, 1360 dark files panel, 1360 light appearance
settings, 820 dark SFTP panes and 1920 light split workspace. Findings:

- At 820×620 the changed-key alert extends above the pane; its critical heading is clipped.
  Both fingerprints and Close tab remain visible. The alert needs contained scrolling and stable
  focus; this is a pre-existing usability defect, not a justification for weaker verification.
- New-host editor has a label/helper collision at “Production host”; the field hierarchy is
  fragmented across many nested bordered groups.
- Host rows align, but repeated server icon tiles, badges, group framing and multiple toolbars add
  noise; top-level groups consume considerable height before hosts appear.
- Files alongside a split leaves little horizontal space in each terminal. Existing app text
  truncates predictably; workspace priority and contextual width need deliberate treatment.
- Appearance settings are legible but consume a second full sidebar, with substantial unused
  space and several repeated panel outlines. SFTP preserves independent local/remote context.

Individual inspection of every image is not claimed here. Windows/Linux native windows, high-DPI,
mobile soft keyboard, sync (not implemented), real transport, motion, transfers/errors and adversarial
long-name fixtures need separate evidence. Browser fixtures do not certify platform behavior.

## Actual execution history

- Sandbox run: blocked by `EPERM` on loopback preview bind.
- Escalated initial browser run: failed because pinned executable 1194 was absent.
- Existing-browser initial capture: 37 passed, 11 failed. Failures were outdated Linux-style
  Control shortcuts against the actual macOS shortcut model; no product assertions were weakened.
- Changed Files/SFTP opening to existing explicit buttons; rerun of 12 affected cases: **12 passed**
  in 19.7 seconds. A desktop-only intermediate rerun also passed 4/4 in 6.9 seconds.
- Final regeneration clears synthetic demo commands and waits for completed split connection.
  **48 passed in 37.5 seconds**; results are recorded in `capture-results.json` and the main
  redesign progress record.
- Delayed banner settlement added before sanitization; all 6 terminal/split capture cases passed
  again in 20.1 seconds. Final before evidence is command-free. Full-run metadata is preserved as
  `before-results.json`.
- First AFTER matrix: **48 passed in 51.3 seconds**, true macOS browser conventions, same 132 names
  and sizes. Full metadata saved as `after-results.json`. Initial minimum changed-key warning still
  clips its heading because focused Close tab scrolls the whole sheet; escalated for correction.
- Focused post-redesign layout/connection/host editor/interface scaling/accessibility: 43 passed,
  5 failed in 1.1 minutes. All 5 new layout tests passed; Files axe target-size defect, SFTP test
  platform-modifier mismatch, and one concurrent startup timeout require follow-up. The layout test
  was strengthened to require the warning heading visible before any scroll.

The installed `biome` command is absent; `pnpm exec biome check` was attempted and did not run.
Use the project's actual formatter/linter verification commands rather than adding a new dependency.

## Final after-captures (2026-10-14, second session)

The after set was regenerated from the final build: **72 passed in 44.7 seconds**, 156 images. The
132 that pair with the before set keep the same names and sizes. The other 24 are new and have no
before counterpart: `<size>-<mode>-theme-<verdigris|fjord|graphite|contrast>.png`, the Hosts list in
each non-default theme in both modes. The paired captures show Cobalt, the default theme.

Images looked at one by one for the final state, at 1360×860 unless noted: dark and light Hosts
with 20 hosts, the empty library, the host editor, terminal, split, palette, Files panel, Settings
(Appearance and Terminal, also at 1920×1080), connecting, password prompt, sign-in failure, first
trust and changed key (also at 820×620), onboarding, SFTP picker and panes, the Hosts list at
820×620, and the Verdigris dark and Graphite light theme captures. The rest of the 156 were not
individually inspected.

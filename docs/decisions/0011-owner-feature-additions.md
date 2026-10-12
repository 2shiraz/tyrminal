# ADR 0011: Owner-requested features P-23 to P-33

Status: accepted (owner request), 2026-10-12

## Context

The owner asked for these features, which are not in the reference matrix; P-28 to P-31 were
first chosen by the coordinator under the owner's standing request to add useful features, then
confirmed by the owner with P-32 and P-33. They are
recorded as product additions P-23 to P-33 in BUILD_SPEC §12.4 so they are tracked like every other row.
This ADR sets the security rules each one must follow. AGENTS.md and BUILD_SPEC §0.1 still apply.

## Decision

### P-23: command-finished notifications

- When a command that ran for at least a set time (default 10 s, configurable, can be turned off)
  finishes in a session the user is not looking at, the app shows a desktop notification and
  marks the tab.
- "Finished" comes only from shell-integration command marks (AUT-06/07). Without shell
  integration, no notification is shown. The app never guesses from output.
- The notification shows the tab title, the exit status and how long the command took. It never
  contains command text or output: operating systems keep notification history, and commands can
  carry secrets.
- Clicking it focuses the tab. Remote output cannot trigger a notification by itself: an OSC 9 or
  OSC 777 request from the server stays off unless the terminal escape permissions (P-15) allow it.
- Any notification plugin is a new dependency. Record its version, licence and reason here before
  merging.

  **Recorded (P-23 implementation):** `tauri-plugin-notification` `=2.6.0` (Apache-2.0 OR MIT), the
  Tauri project's own desktop notification plugin, so notifications go through the platform APIs
  (D-Bus on Linux, the notification center on macOS, toast notifications on Windows). It brings
  `notify-rust` 4.18.2 (MIT OR Apache-2.0), `mac-notification-sys` 0.6.15 (MIT),
  `tauri-winrt-notification` 0.8.1 (MIT OR Apache-2.0), `rand` 0.9.x with `rand_chacha`/`rand_core`/
  `ppv-lite86` (MIT OR Apache-2.0) and `zerocopy` 0.8.x (BSD-2-Clause OR Apache-2.0 OR MIT). It is
  used from Rust only: the renderer gets no notification permission and supplies no text. The
  `notify_command_finished` command takes the tab title, exit status and duration, the core builds
  the text (`crates/core/src/notify.rs`), and a window gets at most one notification every 3 s.
  No npm package is added. Desktop notifications cannot report a click to the app, so returning
  to the window within two minutes of a notification shows that tab.

### P-24: quick port forward from a detected listening port

- Session output is untrusted. Detection, for example `listening on http://localhost:3000`, may
  only offer a suggestion. It never opens a forward or a browser without the user clicking.
- The remote destination is always the server's loopback, at the detected port (1–65535).
  Output can never choose a different remote host.
- The local listener binds to `127.0.0.1` only, on the same port when it is free and otherwise on a
  free port. The listener goes through the existing local-forward path (FWD-01), over the
  already-verified connection, and stops when the session closes or the vault locks.
- "Open in browser" opens only `http://127.0.0.1:<local port>/`, built by the app and never copied
  from output.
- Suggestions can be turned off, and turned off for one host.

### P-25: paste safety (extends P-14)

- The paste review shown before a paste names the target session (host name, and the "production"
  label from P-26).
- The review also opens for a single-line paste that ends in a newline, because that runs a
  command.
- Pasted text is checked for C0/C1 control characters, ESC, bidirectional overrides and
  zero-width characters. Each one is shown visibly in the review and the user is warned.
- A bracketed-paste end marker (`ESC [ 201 ~`) inside pasted text is never sent as-is: the paste is
  refused, or the user removes it in the review.
- The user can lower these checks for one host, but cannot turn off the control-character
  warning.

### P-26: production host guardrails

- A host is "production" when it, or a group above it, carries a production flag. The flag can be
  set directly or derived from a configurable tag (default `prod`).
- Production sessions have a coloured tab and pane border together with a text label, so the state
  is not shown by colour alone (P-20).
- These actions ask for confirmation, naming the production hosts involved: broadcasting to a
  production pane, a multi-host snippet run, and connecting to a group that includes production
  hosts. Cancel has focus by default.
- The guardrails only add confirmations. They never relax any other check.
- Implementation (2026-10-12):
  - The vault stores the flag on host and group records. A host summary reports `production` as
    `host` or `group` (the nearest flag up the chain), or `null`.
  - The production tag is a preference (`productionTag`, default `prod`, empty to turn the tag
    rule off), validated like a host tag, and applied by the interface in one helper
    (`features/hosts/production.ts`).
  - Broadcast input reaches a production pane only after the confirmation for that tab. The
    consent is dropped whenever broadcasting stops, so turning it on again asks again.
  - The marking is red (apart from broadcast's amber) and always comes with the word
    "Production".

### P-27: security review

- It runs entirely on the device, over vault records the user has already unlocked. It makes no
  network request: the compromised-password check (SEC-11) stays a separate, opt-in action.
- Findings:
  - DSA keys;
  - RSA keys under 3072 bits;
  - private keys stored without a passphrase where that is known;
  - hosts signing in with a password;
  - user certificates that have expired or expire within 30 days;
  - known-host entries with no host that uses them;
  - known-host entries that are only `ssh-rsa` (SHA-1).
- The review never shows secret values.
- Each finding links to the existing flow that fixes it: generate key, deploy key, edit host,
  remove known host. The review never changes anything automatically.

### P-28: search across all open sessions

- One search box covers the scrollback of every open session and lists the matches by tab.
  Choosing a match focuses that tab and scrolls to it.
- The search runs only in memory over scrollback the app already holds. Nothing is indexed to
  disk, and search terms are never logged.
- Recordings (P-16) are not searched here.

### P-29: save or copy one command's output

- From a command mark (AUT-06), the user can copy that command's output or save it to a file.
  The copy or file holds the output only, without the prompt and the command line.
- Saving uses the system save dialog every time. There is no default folder and no automatic save.
- Without shell integration, the action is not offered. The app does not guess where output
  begins and ends.

### P-30: encrypted host and group notes

- Plain-text or Markdown notes on a host or group, stored as encrypted vault records like every
  other record. They are included in encrypted backups.
- Notes are shown in the host details panel and the connection side panel.
- Markdown is rendered without HTML, scripts or remote images. Links open only after a click and
  only for `http`, `https` and `ssh` links.
- A code block in a note can be pasted into a session through the paste review (P-14/P-25).
  It can never be run directly.

### P-31: tmux and screen session awareness

- On request, or when the session panel opens, the app lists the server's tmux and screen sessions
  over a separate exec channel on the verified connection. It never types into the user's shell.
- Session names from the server are untrusted. They are shown as plain text, and an attach command
  is built only from a name that matches a strict pattern; anything else is not offered.
- After an automatic reconnect (CON-13), the app may offer to reattach the session the user was
  in. It never reattaches without that choice.

### P-32: server at a glance

- Shows uptime, load, memory and disk use in the connection side panel, for SSH sessions on
  Linux servers. On other systems it says "Not available", and it is never offered for Telnet or
  serial sessions.
- Reads them over a separate exec channel on the verified connection, using a fixed command the
  app builds itself (for example reading `/proc/loadavg` and `/proc/meminfo`, and running
  `df -P`). The command never includes user or server input, and it never types into the user's
  shell.
- Output is untrusted. It is parsed strictly, and anything malformed shows as unavailable rather
  than as a guess.
- Refreshes no more often than every 5 s, and only while the panel is open. Stops when the
  session closes or the vault locks. Can be turned off for one host.

### P-33: container shells on the connected host

- Lists Docker or Podman containers over a separate exec channel on the verified connection,
  using a fixed listing command with JSON output.
- Container names and images come from the server and are shown as plain text only.
- A shell opens in a new tab as a new channel on the same verified connection. Its command is
  built only from a container ID that matches `^[0-9a-f]{12,64}$`; any other value is refused.
- The app never adds `sudo` and never retries with more privilege. A permission error is shown
  as it is.
- Listing and shells stop when the session closes or the vault locks.
- Implementation notes (2026-10-12):
  - Listing is one fixed command (`crates/core/src/containers.rs`). It tries Docker, then
    Podman, and prints one JSON object per line from the engine's own `--format` template.
    Entries without a container ID are left out and counted. Text keeps 256 characters with
    control and direction-override characters removed. A listing keeps at most 500 entries and
    1 MiB of output.
  - An engine does not end a process it started with `exec` when its client goes away. Closing
    the channel ends the client normally, so the shell and anything it runs would stay in the
    container. The fix has three parts:
    - The shell carries `TYRMINAL_SHELL=<random token>` (passed with `-e`), and its children
      inherit it.
    - When the client ends for any reason, the server ends every process in the container that
      carries the token: a hang-up first, then a kill after one second if any were found. The
      server-side shell catches its own hang-up, so the clean-up still runs.
    - The command is `sh -c '…'` with no single quote inside, so the user's login shell does not
      matter.
  - A container shell's channel is closed when its tab closes, because the connection stays open
    for the SSH session. `ShellWriter` sends EOF and close on drop for PTY command channels.
  - No new dependency.

## Consequences

Each feature starts as NOT_STARTED. It can reach VERIFIED only through real-backend tests: the
command finishing in a lab session for P-23, and the forward reaching a lab service for P-24.
Mocked UI tests can cover the review and the warnings but never verify a feature.

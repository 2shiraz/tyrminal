# ADR 0011: Owner-requested features P-23 to P-27

Status: accepted (owner request), 2026-10-12

## Context

The owner asked for five features that are not in the reference matrix. They are recorded as
product additions P-23 to P-27 in BUILD_SPEC §12.4 so they are tracked like every other row.
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

## Consequences

Each feature starts as NOT_STARTED. It can reach VERIFIED only through real-backend tests: the
command finishing in a lab session for P-23, and the forward reaching a lab service for P-24.
Mocked UI tests can cover the review and the warnings but never verify a feature.

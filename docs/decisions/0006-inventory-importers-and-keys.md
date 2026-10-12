# 0006 — Agent D: inventory presentation, importers, keys and snippets

Status: accepted (agent D, 2026-10-12). Living record: later slices append sections.

## Record kinds

Agent D's vault record kinds start at **200** (agent B uses 100+, the original kinds are 1–6), so
parallel branches never assign the same number.

| Kind | Record | Notes |
|---|---|---|
| 200 | `HostAppearanceRecord` (host id, OS) | One per host; deleted with the host and copied with it in the same transaction. Kept apart from `HostRecord` so host fields wait for agent B's (work-split ordering). |
| 202 | `ExecutionTargetRecord` (name, host ids) | Saved host selections for snippet runs; ids of deleted hosts are skipped and counted on read. |
| 201 | `KeyCertificateRecord` (key id, certificate line, parsed fields) | One per key; deleted with the key in the same transaction. Public data, still encrypted like every record. |
| 203 | `IdentityRecord` (label, user name, optional password, optional key id) | The password is write-only (never returned). A key an identity uses cannot be deleted. |
| 204 | `WorkflowRecord` (host id or group id; identity id; later environment and startup snippet) | One per host or group; deleted with its host or group and copied with a duplicated host in the same transaction; dropped when it becomes empty. |

## Dependencies

| Crate | Version | License | Used by | Reason |
|---|---|---|---|---|
| `zeroize` | 1.9.1 | Apache-2.0 OR MIT | `tyrminal-desktop` (adapter) | Holds a natively picked private-key file until import and clears it from memory. Already a dependency of `tyrminal-core` at the same version. |
| `quick-xml` | 0.42.0, `default-features = false` | MIT | `tyrminal-core` (`importers.rs`) | SecureCRT exports its sessions as XML. Already in the lockfile through `plist` → `tauri-utils`, so no new code is downloaded. It never resolves DTDs or external entities; on top of that the importer refuses any document with a DOCTYPE, accepts only the five predefined entities and character references, and bounds nesting (64) and element count (1,000,000) within the 1 MiB import limit. |

## Importers (IMP-04, IMP-05, IMP-06)

- **Input:** the text of a file the user picked in the import dialog. The page decodes UTF-16
  (byte-order mark, as `regedit` writes `.reg` files) or UTF-8 and sends text; the core validates
  every value as if typed into the host editor. Preview first, then one transaction.
- **PuTTY:** `.reg` exports of `HKCU\Software\SimonTatham\PuTTY\Sessions` (both
  `Windows Registry Editor Version 5.00` and `REGEDIT4`). We do not read the live registry: the
  Windows-only API path would need platform FFI (an ADR of its own) and a `.reg` file the user
  exports is reviewable. SSH sessions become hosts; telnet/serial/raw/rlogin sessions and
  `Default Settings` are listed as left out. `PublicKeyFile`, `PortForwardings` and proxies are
  reported per host, not imported (keys are imported in the keychain; tunnels and jump hosts are
  agent B's).
- **MobaXterm:** `MobaXterm.ini` or `.mxtsessions` exports: `[Bookmarks*]` sections, `SubRep`
  folders become groups, SSH (type 0) and SFTP (type 6) sessions become hosts. `[Passwords]` and
  `[Credentials]` are never read beyond noting that they exist.
- **SecureCRT:** "Export Settings" XML (`<key name="Sessions">` tree; folders become groups) or one
  session `.ini`. SSH2 sessions import; SSH1 is refused as insecure; other protocols are listed.
- **Encrypted exports:** both MobaXterm and SecureCRT can protect saved passwords with a master
  password. We import no saved passwords at all, encrypted or not, so no decryption is
  implemented; the preview says a password was not imported. Hosts ask for it on first use.

## Known-host conversion (SEC-03)

Hosts are offered only for records the user already trusted on a real connection ("trust
always"), and only when no host has that address and effective port. The preview shows the
trusted algorithm and fingerprint; importing reuses the same transactional `import_hosts`.
Hashed `known_hosts` entries do not exist in the vault (records store the host name), so there
is nothing to un-hash.

## Cloud discovery (IMP-07..IMP-13)

AWS, DigitalOcean and Azure discovery need those providers' APIs and real accounts. Agents must
not contact third parties, so these rows are BLOCKED until the owner authorizes a provider
sandbox. Nothing is stubbed in the UI.

## Keys (KEY-01, KEY-02, KEY-07, KEY-14) — slice 3

- **Key files (owner request via agent A):** "Choose key file…" opens a native dialog from Rust
  (`key_import_pick_file`; test builds read `TYRMINAL_E2E_KEY_FILE`). The adapter reads at most
  1 MiB of UTF-8 text, keeps it per window in a zeroizing buffer and returns only the file name
  and whether it is encrypted; `key_import_picked` sends it through the same core import as pasted
  text. A failed import keeps the file (so a passphrase can be added); success or closing the
  dialog drops it.
- **Generation:** Ed25519 (default), ECDSA P-256/P-384/P-521 and RSA 3072/4096 through `ssh-key`
  (already a dependency via russh). RSA runs on a blocking thread. No DSA, no RSA below 3072.
- **ML-DSA keys: BLOCKED.** There is no SSH standard for ML-DSA user keys, OpenSSH does not
  accept them, and neither russh nor ssh-key implements them. We do not invent SSH algorithms
  (spec §4.5).
- **PuTTY PPK v2/v3:** decoded by `ssh-key`'s `ppk` feature (already enabled). A PPK v3 file names
  its own Argon2 parameters and the library applies them unchecked, so `auth.rs` reads the header
  first and refuses more than 256 MiB of memory, 64 passes or 16 lanes before any work is done
  (PuTTY's defaults are 8 MiB, ~20 passes, 1 lane). Encryption is detected from the header, so an
  encrypted PPK asks for its passphrase like an encrypted OpenSSH key. The original text is
  stored, so the bound applies again at every decode.
- **Certificates:** an OpenSSH user certificate is attached to a key after checking that its CA
  signature verifies, it is a user (not host) certificate, it certifies exactly that key's public
  half and it has not expired. The check uses the stored public key, so an encrypted key needs no
  passphrase. CA trust and principals are the server's decision and are only displayed.
  **Using** the certificate to sign in needs a change on the connection path (vault
  `connection_plan`, `sessions.rs`), which agent B owns and is changing for jump hosts; it lands
  after B merges, with a lab CA (`TrustedUserCAKeys`) test.
- **Hardware keys (KEY-08..13): BLOCKED** — no FIDO2 device or platform key store is available to
  test, and the spec forbids advertising them untested.

## Algorithms (SEC-08..10)

- `mlkem768x25519-sha256` is first in the offer (`crates/ssh/src/algorithms.rs`); servers without
  it (OpenSSH < 9.9) negotiate `curve25519-sha256`. The lab test asserts the PQ exchange for
  OpenSSH ≥ 9.9 and the Curve25519 fallback otherwise. The sandbox lab is OpenSSH 9.6; the Docker
  lab (10.0p1) could not be built here because its image build has no trusted route to the Alpine
  mirror, so the PQ branch runs where that lab runs (CI).
- **SEC-09: BLOCKED** — russh 0.64 has no `sntrup761x25519-sha512`, no `mlkem1024nistp384-sha384`
  and no ML-DSA.
- **SEC-10:** a per-host switch that removes the PQ exchange from the offer is a host setting on
  the connection path; it follows agent B's merge. Disabling PQ never adds weaker algorithms: the
  remaining list is the same modern one.

## Snippet runs (SNP-05/06/07/10) — slice 4

- A run uses an exec channel on a session the window already owns and has connected, never a new
  connection: host trust and sign-in stay in the normal interactive path with its prompts.
- No PTY is requested, so `sudo`/`su` cannot prompt and fail instead; nothing is typed into a
  prompt for the user (spec: no automatic password injection).
- The snippet text is the exec command (the account's login shell runs it). It is the user's own
  saved text, read from the vault under the session's generation; nothing is interpolated.
- Output is untrusted: kept up to 64 KiB per stream, control characters and bidi overrides
  removed, shown as plain text. A run stops after 30 minutes or 64 MiB read; it can be cancelled
  by its window only. At most 64 runs at once; the dialog runs 8 hosts in parallel.

## Suggestions (AUT-02/03/04/12, P-14) — reassigned to agent D by agent A

- Explicit, not as-you-type: without shell integration (AUT-06/07) the app cannot know the
  current command line, so a picker opened by a shortcut is the honest form. It inserts text on
  the command line and never sends Enter.
- Remote file names are untrusted: they are listed through the session's existing SFTP channel,
  shown escaped, shell-quoted on insertion, and names containing control characters or bidi
  overrides cannot be inserted at all (an embedded newline would otherwise run a command in a
  shell without bracketed paste).
- Command knowledge is a static bundled list (`commands.ts`); nothing is fetched or learned.
- AUT-01 (history suggestions) stays with agent B, with the encrypted command history (LOG rows).

## Shell integration (AUT-06, AUT-07) — assigned to agent D by agent A

- **Opt-in, versioned, reviewed:** the scripts live in `crates/core/shell-integration/`
  (`tyrminal.bash`, `tyrminal.zsh`, version 1). The setup dialog shows the exact block (markers
  included) before anything is written; only its Install button writes. Remove takes the block
  out again. Startup files are never edited otherwise (spec §4.7).
- **What the script does:** prints OSC 133 marks (A prompt start, B prompt end, C command start,
  D;status command end) and OSC 7 (`file://host/percent-encoded-folder`) from `PROMPT_COMMAND`,
  `PS1`/`PS0` (Bash) or `precmd`/`preexec` hooks (Zsh). No `eval`, no command substitution, nothing
  sourced or downloaded; a unit test keeps it that way. Command boundaries need Bash 4.4+ (`PS0`);
  older Bash (macOS's 3.2) still reports the prompt and folder.
- **Where it goes:** a server's `~/.bashrc` over the session's verified connection (exec channels
  with fixed command text; the new content travels on standard input, as in key deployment), or
  `~/.bashrc` / `~/.zshrc` on this computer (macOS and Linux; not offered on Windows). The block
  sits between `# >>> tyrminal shell integration v<N> >>>` and `# <<< tyrminal shell integration
  <<<`; every other line is kept byte for byte, an older block is replaced, and a begin marker
  without its end (edited by hand) makes Tyrminal refuse to touch the file. The previous content
  is copied to `<file>.tyrminal-backup` (mode 0600) first; the file is rewritten in place so its
  mode, owner and any symlink stay; a new file is created 0600. Files over 1 MiB or not UTF-8 are
  not edited. The status reports the server account's login shell, since a login shell other than
  Bash only picks the block up where Bash starts interactively.
- **Reading the marks:** OSC 7/133 are untrusted terminal output. The renderer bounds them
  (4 KiB), accepts only absolute, well-formed UTF-8 folders without control or bidi characters,
  reads the command text from the screen between the B and C marks (2 KiB at most), and keeps all
  of it as plain text. The folder anchors relative path suggestions (still insert-only and
  reviewed); the last command and its status are shown in Suggestions. A server without the
  integration can print the same sequences; at worst relative path suggestions start elsewhere.
- **Using the folder elsewhere (2026-10-12):** the files panel opens in the session's reported
  folder (falling back to the login folder when SFTP cannot list it) and offers "Go to the shell's
  folder". Duplicating a tab keeps the folder. A local duplicate passes it to `session_open_local`
  as `startIn`; the core starts there only if it is an absolute path to an existing folder with
  no control characters (4 KiB at most), else in the home folder. An SSH duplicate types exactly
  `cd -- '<folder>'` and Enter into the new shell, single-quoted (a `'` in the name becomes
  `'\''`), and only at the new shell's first OSC 133 A mark (so only where the integration
  runs). It is dropped if the user types first or no mark arrives within 60 s, and reconnects
  do not repeat it. The folder came from the same server and passed the OSC 7 checks above.
- **Mark events for other features:** `shellContexts.onMark` delivers each validated mark
  (`prompt`, `command_start` with the command text, `command_end` with text and status, `folder`)
  with its session id. Listeners get only what passed the checks above, must treat it as server
  text and must never run or send it. A listener that throws does not affect the others. Command
  history (AUT-01) can build on it.
- **Command names** avoid the release policy's forbidden words: `prompt_marks_status`,
  `prompt_marks_install`, `prompt_marks_remove`. Test builds edit `TYRMINAL_E2E_HOME`, never the
  real home folder.

## Identities (KEY-15..17)

- An identity is a user name plus a password and/or a key; a key's attached certificate comes
  with it. Hosts and groups refer to one through their workflow record, so editing the identity
  changes every host that uses it on its next connection (KEY-16).
- **Precedence:** a host's own identity always wins. A group's identity applies to the hosts in it
  and its subgroups (nearest group first) whose sign-in method is "inherit from group", so a host
  with its own password or key keeps it. The identity's user name replaces the host's when set;
  an identity with a key signs in with the key, else with its password, else the user is asked.
- **Connection path:** `hop_plan` asks `identity_for_host` before using the host's own
  credentials (a few lines; noted under Requests in `docs/work-split.md`). Every hop of a jump
  chain resolves its own identity the same way.
- Deleting an identity removes its references in the same transaction and reports how many
  hosts and groups used it; they fall back to their own settings. There is one personal vault,
  so "accessible vaults" (KEY-17) is this vault.

## Environment variables (SNP-11..14)

- Stored per host or group in the workflow record (kind 204), encrypted like every record. Names
  are portable shell names (`[A-Za-z_][A-Za-z0-9_]*`, 64 bytes); values are one line of at most
  4096 bytes; 64 per target. Values are shown only in the editor; events carry names only.
- **Inheritance:** outermost group first, nearer groups override, the host overrides everything.
  The host's editor lists what it inherits, from which group, and what it overrides.
- **Delivery:** SSH `env` requests with want-reply on the session channel, before the shell
  (interactive sessions) or the exec request (snippet runs), via
  `VerifiedConnection::open_shell_with_env` / `open_command_with_env` in `crates/ssh/src/client.rs`.
  Each refusal (normally a name the server's `AcceptEnv` does not allow) is collected and
  reported: `SessionEvent::Environment { sent, rejected }` (names only) becomes an error notice
  in the window, and snippet results list refused names. Nothing is dropped silently, and
  nothing falls back to typing `export` into the shell. russh copies values into its own
  buffers while sending, which Tyrminal cannot zeroize.
- **Lab:** the lab servers already allow `AcceptEnv TYR_*`; the lab test checks an accepted group
  variable, a host override, and a refused name.

## OS logos on host tiles (HST-13, owner request)

The host tile showed two-letter OS marks to stay clear of vendor logos. The owner asked for the
real logos, so `OsIcon` now inlines path data from **Simple Icons 16.35.0** (CC0-1.0, the npm
package `simple-icons`; no runtime fetch and no package dependency: the paths are copied into the
component). Per-icon terms from its data file, recorded in NOTICE:

- No separate licence listed (CC0 via Simple Icons): Linux, Ubuntu, Red Hat, CentOS, AlmaLinux,
  Alpine Linux, Arch Linux, openSUSE, Raspberry Pi, FreeBSD, OpenBSD, Apple (for macOS; the
  Simple Icons "macOS" mark is a wordmark too small for a tile).
- Debian: CC BY-SA 3.0; Rocky Linux: CC BY-SA 4.0. Drawn unmodified with attribution in NOTICE.
- Fedora: custom brand terms (https://docs.fedoraproject.org/en-US/project/brand/). Windows: not
  in Simple Icons (Microsoft asked for its marks to be removed). Owner decision: both keep generic
  glyphs (an "f" mark and a window), with no official logo.
- Network devices and hosts without an OS: generic glyphs (a server for unknown).

The logos are trademarks of their owners and identify the host's OS only. A mark is drawn in its
brand colour where that colour keeps 3:1 against the tile in the theme, else in the text colour.
`HostOs` gains `rocky` and `alma`. Detecting the OS at connection time is a follow-up; the tile
uses the OS set on the host or its group.

# Tyrminal user guide

Tyrminal is a local-first SSH client. Your hosts, keys, passwords and snippets live in an
encrypted vault on this computer. There is no account, no cloud service and no telemetry; the
only network traffic is the SSH connections you start.

> Pre-release software: not yet independently security reviewed, installers unsigned. Use test
> servers and credentials you can rotate.

## Contents

1. [Installing and updating](#installing-and-updating)
2. [The vault](#the-vault)
3. [Home and quick connect](#home-and-quick-connect)
4. [Hosts and groups](#hosts-and-groups)
5. [Connecting and host keys](#connecting-and-host-keys)
6. [Keys](#keys)
7. [Identities](#identities)
8. [Terminals](#terminals)
9. [Files (SFTP)](#files-sftp)
10. [Snippets and broadcast](#snippets-and-broadcast)
11. [Tunnels, jump hosts and proxies](#tunnels-jump-hosts-and-proxies)
12. [Backup and restore](#backup-and-restore)
13. [Settings, privacy and diagnostics](#settings-privacy-and-diagnostics)
14. [Keyboard shortcuts](#keyboard-shortcuts)
15. [Troubleshooting](#troubleshooting)

## Installing and updating

Download the installer for your platform from the
[releases page](https://github.com/2shiraz/tyrminal/releases) and check it against
`SHA256SUMS.txt` (`shasum -a 256 <file>` on macOS, `Get-FileHash <file>` on Windows,
`sha256sum <file>` on Linux).

### Opening a pre-release build

Pre-releases are not yet signed with an Apple Developer ID or a Windows code-signing
certificate, so macOS and Windows warn that they cannot check who made the file. Check the
SHA-256 first; then:

- **macOS 15 and later:** opening the app shows "Apple could not verify 'Tyrminal' is free of
  malware" with **Move to Bin** and **Done**. Click **Done** (not Move to Bin). Open
  System Settings → Privacy & Security, scroll to "Tyrminal was blocked to protect your Mac" and
  click **Open Anyway**, confirm with your password, then click **Open Anyway** once more.
  macOS remembers the choice. Right-click → Open no longer skips this on macOS 15.
  If macOS says the app "is damaged", the download is still quarantined: after checking the
  SHA-256, run `xattr -dr com.apple.quarantine /Applications/Tyrminal.app` in Terminal and
  open it again.
- **Windows (Edge):** Edge may say the file "isn't commonly downloaded" or "could harm your
  device". In the downloads list, choose **…** → **Keep** → **Show more** → **Keep anyway**.
  When you run the installer, SmartScreen shows "Windows protected your PC": click
  **More info** → **Run anyway**.
- **Linux:** `sudo apt install ./tyrminal-<version>-linux-x64.deb`, or make the AppImage
  executable (`chmod +x`) and run it.

Signed and notarized builds remove these steps. The release workflow signs automatically once
the project's signing certificates are added as repository secrets.

Tyrminal never checks for or installs updates by itself. To update, download the newer version
and install it over the old one. Your vault and settings stay where they are. Settings → Privacy
shows the version you are using and opens the releases page when you ask.

Uninstalling removes the application, not your data. The vault lives in the application data
folder (`~/Library/Application Support/app.tyrminal.desktop` on macOS,
`%APPDATA%\app.tyrminal.desktop` on Windows, `~/.local/share/app.tyrminal.desktop` on Linux).
Delete that folder yourself if you want your data gone.

## The vault

On first start you choose a passphrase and get a **recovery key**: eleven groups of five
characters, shown once. Write it down and keep it away from this computer. Either the passphrase
or the recovery key opens the vault; without both, the data cannot be recovered by anyone.

The vault locks:

- after five minutes without activity,
- when the screen locks (macOS, Windows, and Linux desktops that report it),
- when you press **Lock** (Ctrl+Shift+L, ⌘⇧L on macOS),
- when you quit.

Locking ends open sessions. **Quick unlock** (Settings → Vault security, off by default) keeps
an unlock key in the operating system's keychain for this device; it never falls back to
storing anything in plain text. Settings → Vault security also changes the passphrase and issues
a new recovery key (the old one stops working at once).

## Home and quick connect

**Home** shows your recent connections and open sessions. To connect somewhere new, type in the
quick-connect box: a saved host's name finds it, and `user@host:port` offers **Save and
connect**, which saves a host that asks for the password and connects to it.

The **command palette** (Ctrl+Shift+K, ⌘K on macOS, or **Search…** at the top of the sidebar)
finds hosts to connect to, snippets to run in the current terminal, pages to open, and actions
such as splitting a pane, finding text, zooming, switching the theme, typing into every pane of
a tab, and installing a public key on the connected server.

## Hosts and groups

**Hosts** lists your saved servers as a grid or a list. Each host has an address, port, user name
and a way to sign in (password, stored password, or a key). Hosts can be put in **groups**,
tagged, searched, duplicated and edited in bulk; a group can open all of its hosts at once.

A group can give its hosts default values (**Defaults for hosts in this group**: user name, port
and a default key). A host uses its own value when it has one, otherwise the nearest group's.
Choose **Use the group's key** as a host's sign-in method to follow the group.

**Character encoding** and **Terminal type** are set per host, right under **Protocol**. Most
servers need neither changed: the defaults are UTF-8 and `xterm-256color`. Pick another encoding
(for example ISO-8859-1, Windows-1252, KOI8-R, Shift_JIS, EUC-KR, GBK or Big5) for an old system
that does not use UTF-8; Tyrminal converts its output for display and your typing back. A
character the encoding cannot represent is sent as `?`. The terminal type is the `TERM` value
the server sees; serial devices have none.

A host's **protocol** is SSH (the default), **Telnet** or a **serial device**:

- **Telnet** is for old equipment only. It is not encrypted: anything you type, including the
  password at the device's login prompt, can be read on the network. Tyrminal says so in the
  host editor and stores no credentials for Telnet hosts. The default port is 23.
- **Serial** connects to a device on this computer (a USB serial adapter or console port,
  e.g. `/dev/ttyUSB0` or `COM3`) with the speed, data bits, parity, stop bits and flow control
  you choose. Only real serial devices are opened.

**Import** reads an OpenSSH `config` file, a CSV file, a PuTTY `.reg` export, MobaXterm's
`MobaXterm.ini` or a `.mxtsessions` export, or a SecureCRT XML export or session `.ini`. It shows
a preview first and never runs anything from the file (`ProxyCommand`, `LocalCommand` and
similar are reported, not executed). Saved passwords are never imported; key files and tunnels
are listed per host so you can set them up. An OpenSSH `known_hosts` file can be imported too:
after a review, its keys become trusted server identities, and a key that differs from one you
already trust is never replaced.

## Connecting and host keys

The first time you connect to a server, Tyrminal shows its host-key fingerprint and asks whether
to trust it: **once** or **always**. Compare the fingerprint with one your server administrator
gave you. If a server's key later changes, the connection is stopped **before any password or
key is sent**, and you see the old and new fingerprints. The **Known hosts** page (in the
sidebar) lists trusted keys and removes one when you give a reason. A trusted server that no saved host points at
has a **Create host** button that opens the host editor with its address and port filled in.

The status bar shows the negotiated cipher and key exchange. A dropped connection reconnects
with growing pauses between attempts (**Reconnect now** and **Stop retrying** are offered while
it waits); the server's identity is checked again each time.

### Agent forwarding

For a server you trust, the host editor offers **Forward this host's key (agent forwarding)**.
It appears when the host signs in with a key from the keychain, and it is off by default. While
the session is open, that server (and anyone with administrator rights on it) can use **this
host's key**, and only that key, to sign in to other servers as you. It is never forwarded to
jump hosts, and the server cannot add or remove keys or see any other key.

## Keys

The **Keychain** page holds your keys. **Generate key** creates Ed25519 (recommended), ECDSA
or RSA (3072 or 4096 bits) keys. **Import key** accepts OpenSSH and PuTTY (`.ppk`, versions 2
and 3) private keys, pasted or chosen as a file; encrypted ones ask for their passphrase, which
can optionally be remembered in the vault. **Add certificate** attaches an OpenSSH user
certificate to a key after checking that it certifies that key and has not expired (signing in
with the certificate is not available yet). To install a public key on a server, connect to it and choose
**Install a public key on this server…** in the command palette: Tyrminal shows exactly what
will change in `~/.ssh/authorized_keys`, creates the folder and file with owner-only permissions
when missing, keeps every other entry, and then offers to sign in to that host with the key from
now on.

## Identities

An **identity** (Keychain → Identities) is a user name with a password and/or a key, saved once.
Choose **Identity…** in a host's or a group's menu to use it there: a host's own identity wins,
and a group's identity applies to the hosts in it that sign in with the group's settings.
Editing an identity changes every host that uses it from their next connection.

Deleting an identity that hosts or groups use asks what they should use instead: another
identity, or nothing (each host then signs in as the dialog lists, for example with its own
stored password or by asking). Nothing changes until you choose.

### Typing an identity's password at a sudo prompt

When a command such as `sudo` asks for a password in an SSH session, press **Ctrl+Shift+P**
(**Cmd+Shift+P** on macOS) or choose **Type the identity password into this terminal…** in the
command palette. A dialog names the identity the host uses and the host; **Type password** types
it. Enter is not pressed for you: check the prompt, then press Enter. Nothing is ever typed
automatically, because a server can print text that looks like a password prompt. A password
containing control characters is not typed.

## Terminals

Each tab holds one or more panes (split right or down). A pane is an SSH session or a local
terminal (Ctrl+Shift+T, ⌘T on macOS). Settings → Terminal sets the color scheme, font, size,
cursor and scrollback, and the shell for local terminals (only shells installed on this computer
are offered).

Safety features:

- Links open only after you confirm the real destination (http and https only).
- A server may write to your clipboard only if you allow it for that session; reads are never
  answered.
- Pasting several lines, or a lot of text, shows the text first.

## Files (SFTP)

Open the **Files** panel (Ctrl+Shift+O, ⌘⇧O on macOS) on a connected SSH session. You can:

- browse, create folders, rename, change permissions and delete;
- upload and download files and whole folders, with progress and Cancel;
- use **Two panes** to see this computer and the server side by side, and drag between them;
- drop files from your desktop onto the panel to upload them into the folder shown;
- **Copy to another server** between two connected sessions, without saving anything on this
  computer.

The panel remembers each session's place: switch to another tab and back and you find the same
folder, selection, scroll position, toggles and transfers, without the folder being listed
again. **Refresh** lists it again. The panel forgets a session when the session ends.

Every transfer is written under a temporary name and renamed into place only when complete, so
a cancelled, failed or interrupted transfer never leaves a half-written file. If the name
exists, Tyrminal asks: **Replace** or **Keep both** (which adds " (1)" and so on). Folders are
never merged or replaced. Symbolic links inside folders are skipped and counted, never followed.

**Edit** opens a remote file in a local application (Settings → Terminal → editors per file
type, chosen with the system app picker). Nothing is uploaded until you click **Save**, and
saving refuses if the file changed on the server since you opened it, unless you choose to
overwrite. The local copy is deleted when you close the edit, the session or Tyrminal.

## Snippets and broadcast

**Snippets** (Ctrl+Shift+S, ⌘⇧S on macOS) are saved commands, kept encrypted in the vault and
organized in folders. **Paste** inserts the text (as a bracketed paste when the terminal
supports it); **Run** inserts it and presses Enter. The panel always shows which session it
sends to, and nothing runs automatically.

**Broadcast** sends what you type to several sessions at once. The sessions that receive input
are marked while broadcast is on.

## Tunnels, jump hosts and proxies

The **Tunnels** page forwards ports through your SSH connections. **New tunnel** asks for a
name, the host it runs through, and a type:

- **Local**: a port on this computer reaches a destination as seen from the server (for
  example a database only the server can reach).
- **Remote**: a port on the server reaches a destination as seen from this computer.
- **SOCKS proxy**: applications on this computer use the tunnel as a SOCKS5 proxy (no user
  name or password).

Listeners stay on this computer (127.0.0.1) unless you choose another listen address; one that
other computers could reach asks **Allow connections from other computers?** first. An empty
listen port picks a free one. Start a saved tunnel on a connected session, or turn on **Start
with every connection**. The **Active** list shows each running tunnel's connections and
traffic, and stopping a session stops its tunnels.

In the host editor, **Advanced** (SSH hosts) sets:

- **Jump host**: connect through another saved host first (like `ProxyJump`). Chains of up to
  seven jump hosts work; every host's key is checked, in order, before anything is sent to it,
  and prompts say which hop they come from.
- **Proxy**: reach the host through an **HTTP (CONNECT)** or **SOCKS5** proxy, optionally with
  a user name and password. An HTTP proxy receives them unencrypted, so use one only on a
  network you trust. The server's key is still checked end to end. With a jump host, set the
  proxy on the jump host.

## Backup and restore

Settings → Backup **exports** the whole vault to one encrypted file, opened with the vault's
passphrase or recovery key at the time of the backup. **Restore** checks every item in the file
before replacing anything; a damaged or tampered file changes nothing.

## Settings, privacy and diagnostics

Settings has **Appearance** (theme: system, light or dark; reduce motion), **Terminal** (color
scheme, font and size, line height, letter spacing, padding, cursor, scrollback, font
ligatures, GPU rendering, copy on select, confirmation before multi-line pastes, the shell for
local terminals, and the editors for remote files), **Vault security**, **Backup and restore**
and **Privacy**.

Settings → Vault security also has a **Compromised-password check** (off by default). When you
turn it on and run it, Tyrminal computes the SHA-1 hash of each stored password on this
computer and sends only its first 5 characters (for example `5BAA6`) to the service address
shown; the match is made on your computer, and passwords, full hashes and names never leave it.
This build cannot contact a service yet, and the page says so.

Apart from that check, which only runs when you ask, Tyrminal makes no network connections of
its own. Settings → Privacy has:

- **Diagnostics** (off by default): keeps, in memory only, which action failed and its error
  code. It never keeps host names, user names, paths, commands, output or secrets. **Save
  diagnostic report…** writes them to a file you choose; nothing is sent anywhere. Turning
  diagnostics off forgets what was kept.
- **Updates**: the version you are using and a button that opens the releases page.

## Keyboard shortcuts

| Action | Windows and Linux | macOS |
|---|---|---|
| Command palette | Ctrl+Shift+K | ⌘K |
| New local terminal | Ctrl+Shift+T | ⌘T |
| Close pane | Ctrl+Shift+W | ⌘W |
| Split right / down | Alt+Shift+= / Alt+Shift+- | ⌘D / ⌘⇧D |
| Find in terminal | Ctrl+Shift+F | ⌘F |
| Zoom in / out / reset | Ctrl+= / Ctrl+- / Ctrl+0 | ⌘= / ⌘- / ⌘0 |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | ⌘⇧] / ⌘⇧[ |
| Move focus between panes | Alt+arrow keys | ⌘⌥ + arrow keys |
| Snippets panel | Ctrl+Shift+S | ⌘⇧S |
| Files panel | Ctrl+Shift+O | ⌘⇧O |
| Sidebar | Ctrl+Shift+B | ⌘B |
| Settings | Ctrl+, | ⌘, |
| Lock the vault | Ctrl+Shift+L | ⌘⇧L |
| Rename tab | Ctrl+Shift+R | ⌘⇧R |
| Type the identity password (asks first) | Ctrl+Shift+P | ⌘⇧P |
| Copy / paste in a terminal | Ctrl+Shift+C / Ctrl+Shift+V | ⌘C / ⌘V |

## Troubleshooting

| You see | What it means and what to do |
|---|---|
| "Tyrminal is already open" | Another window of Tyrminal is running with the same data. Switch to it. |
| The host key changed | Do not continue unless your administrator confirms the server was reinstalled or its key rotated. Then remove the old key on the Known hosts page (with a reason) and connect again. |
| "That did not unlock the vault" | The passphrase is wrong. Use the recovery key instead ("Use recovery key instead"). |
| "There is not enough space on this computer" | A download stopped because the disk is full. Nothing partial was left; free space and try again. |
| "The file changed on the server since you opened it" | Someone changed the file while you edited it. Download it again to compare, or choose to overwrite. |
| Quick unlock is unavailable | The OS keychain is not available (on Linux this needs a Secret Service such as GNOME Keyring). Use the passphrase. |
| Something else failed | Turn on Settings → Privacy → Diagnostics, repeat what failed, then save a diagnostic report and attach it to an issue. |

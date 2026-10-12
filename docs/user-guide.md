# Tyrminal user guide

Tyrminal is a local-first SSH client. Your hosts, keys, passwords and snippets live in an
encrypted vault on this computer. There is no account, no cloud service and no telemetry; the
only network traffic is the SSH connections you start.

> Pre-release software: not yet independently security reviewed, installers unsigned. Use test
> servers and credentials you can rotate.

## Contents

1. [Installing and updating](#installing-and-updating)
2. [The vault](#the-vault)
3. [Hosts and groups](#hosts-and-groups)
4. [Connecting and host keys](#connecting-and-host-keys)
5. [Keys](#keys)
6. [Terminals](#terminals)
7. [Files (SFTP)](#files-sftp)
8. [Snippets and broadcast](#snippets-and-broadcast)
9. [Backup and restore](#backup-and-restore)
10. [Settings, privacy and diagnostics](#settings-privacy-and-diagnostics)
11. [Keyboard shortcuts](#keyboard-shortcuts)
12. [Troubleshooting](#troubleshooting)

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

Locking ends open sessions. **Quick unlock** (Settings → Security, off by default) keeps an
unlock key in the operating system's keychain for this device; it never falls back to storing
anything in plain text. Settings → Security also changes the passphrase and issues a new
recovery key (the old one stops working at once).

## Hosts and groups

**Hosts** lists your saved servers as a grid or a list. Each host has an address, port, user name
and a way to sign in (password, stored password, or a key). Hosts can be put in **groups**,
tagged, searched, duplicated and edited in bulk; a group can open all of its hosts at once.

A **group** can also give its hosts defaults: a user name, port and key, and, under
**Defaults for hosts in this group**, a route (a jump host and/or a proxy) and an icon. Hosts
and subgroups use the nearest group's value unless they set their own, and the host editor
names the group a value comes from. In a host's **Advanced** section, choose between the
group's route and one for this host only (which can be "connect directly"). A group's jump
host is never used for that jump host itself, and a change that would make hosts connect
through each other in a loop is refused.

A host's **protocol** is SSH (the default), **Telnet** or a **serial device**:

- **Telnet** is for old equipment only. It is not encrypted: anything you type, including the
  password at the device's login prompt, can be read on the network. Tyrminal says so at the
  start of every Telnet session and stores no credentials for Telnet hosts. The default port
  is 23.
- **Serial** connects to a device on this computer (a USB serial adapter or console port,
  e.g. `/dev/ttyUSB0` or `COM3`) with the speed, data bits, parity, stop bits and flow control
  you choose. Only real serial devices are opened.

**Import** reads an OpenSSH `config` file or a CSV file. It shows a preview first and never runs
anything from the file (`ProxyCommand`, `LocalCommand` and similar are reported, not executed).
`ProxyJump` becomes a jump host: a hop that names another host of the file is that host, and
any other hop (`user@host:port`) is imported as a host of its own. A chain that cannot be
represented (a loop, more than seven jump hosts, or a host that two chains would route
differently) is imported without a jump host, and the preview says why.

## Connecting and host keys

The first time you connect to a server, Tyrminal shows its host-key fingerprint and asks whether
to trust it: **once** or **always**. Compare the fingerprint with one your server administrator
gave you. If a server's key later changes, the connection is stopped **before any password or
key is sent**, and you see the old and new fingerprints. Settings → Known hosts lists trusted
keys and removes one when you give a reason. A trusted server that no saved host points at
has a **Create host** button that opens the host editor with its address and port filled in.

The status bar shows the negotiated cipher and key exchange. A dropped connection reconnects
with growing pauses between attempts.

## Keys

Keys → **Generate** creates Ed25519 (recommended), ECDSA or RSA keys. **Import** accepts OpenSSH
private keys (encrypted ones ask for their passphrase, which can optionally be remembered in the
vault). **Deploy** adds a public key to a server's `~/.ssh/authorized_keys` after showing exactly
what will change; it creates the folder and file with owner-only permissions when missing and
keeps every other entry.

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

**Duplicate tab** (tab menu) opens the same destination again. When the shell integration
(Suggestions → shell integration) reports the shell's current folder, the copy starts there:

- A local terminal starts directly in that folder (if it still exists).
- An SSH tab types `cd -- '<folder>'` into the new shell at its first prompt. It does this only
  when that prompt carries the integration's mark, and not if you start typing first.

## Files (SFTP)

Open the **Files** panel (Ctrl+Shift+O, ⌘⇧O on macOS) on a connected SSH session. You can:

- browse, create folders, rename, change permissions and delete;
- upload and download files and whole folders, with progress and Cancel;
- use **Two panes** to see this computer and the server side by side, and drag between them;
- drop files from your desktop onto the panel to upload them into the folder shown;
- **Copy to another server** between two connected sessions, without saving anything on this
  computer.

A session opens in its shell's current folder when the shell integration reports one, otherwise
in the login folder. The terminal-folder button returns to the shell's folder.

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
sends to. Nothing runs automatically except the startup snippets you choose for a host or group
(below). A snippet with several lines, or one that uses a variable the server refused, is shown
for review before it is sent.

**Environment variables.** In the Hosts view, choose **Environment…** from a host's or group's
menu. Hosts get their groups' variables (the nearest group wins) and can set their own. Each
variable is requested from the server when a session opens. The server applies only names its
configuration allows (OpenSSH: `AcceptEnv` in `sshd_config`). Any name it refuses is reported
when you connect and is not set. Values are stored encrypted, but they are not a secret store:
the remote shell can print them. Snippets can use them as `$NAME`; the run review lists each
variable a snippet uses and whether this session set it.

**Startup snippets.** The same dialog chooses snippets to run when a session to the host opens:
the group's list, nothing, or a list of your own, in order. They are typed into the shell only
after the server's host key is trusted and you are signed in, each followed by Enter. A snippet
deleted later is skipped.

**Broadcast** sends what you type to several sessions at once. The sessions that receive input
are marked while broadcast is on.

## Backup and restore

Settings → Backup **exports** the whole vault to one encrypted file, opened with the vault's
passphrase or recovery key at the time of the backup. **Restore** checks every item in the file
before replacing anything; a damaged or tampered file changes nothing.

## Settings, privacy and diagnostics

Tyrminal makes no network connections of its own. Settings → Privacy has:

- **Diagnostics** (off by default): keeps, in memory only, which action failed and its error
  code. It never keeps host names, user names, paths, commands, output or secrets. **Save
  diagnostic report…** writes them to a file you choose; nothing is sent anywhere. Turning
  diagnostics off forgets what was kept. Session recording and command history are separate
  settings.
- **Updates**: the version you are using and a button that opens the releases page.

Settings → About (or the version at the foot of the sidebar) shows which build you are running:
version, channel (Pre-release or Release), build commit and date, OS and architecture, and the
Tauri and WebView versions. **Copy version info** copies exactly those lines for a bug report;
it never includes hosts, paths, user names or vault data. The releases page and the licences
open in your browser only when you click them.

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
| Copy / paste in a terminal | Ctrl+Shift+C / Ctrl+Shift+V | ⌘C / ⌘V |

## Troubleshooting

| You see | What it means and what to do |
|---|---|
| "Tyrminal is already open" | Another window of Tyrminal is running with the same data. Switch to it. |
| The host key changed | Do not continue unless your administrator confirms the server was reinstalled or its key rotated. Then remove the old key in Settings → Known hosts (with a reason) and connect again. |
| "That did not unlock the vault" | The passphrase is wrong. Use the recovery key instead ("Use recovery key instead"). |
| "There is not enough space on this computer" | A download stopped because the disk is full. Nothing partial was left; free space and try again. |
| "The file changed on the server since you opened it" | Someone changed the file while you edited it. Download it again to compare, or choose to overwrite. |
| Quick unlock is unavailable | The OS keychain is not available (on Linux this needs a Secret Service such as GNOME Keyring). Use the passphrase. |
| Something else failed | Turn on Settings → Privacy → Diagnostics, repeat what failed, then save a diagnostic report and attach it to an issue together with Settings → About → Copy version info. |

# User guide

Task-oriented notes for features as they land. The README covers installation.

## Typing an identity's password at a sudo prompt

When a command such as `sudo` asks for a password in an SSH session, press **Ctrl+Shift+P**
(**Cmd+Shift+P** on macOS) or choose **Type the identity password into this terminal…** in the
command palette. A dialog names the identity the host uses and the host. Click **Type password**
to type it.

- Enter is not pressed for you. Check the prompt, then press Enter.
- Nothing is ever typed automatically. A server can print text that looks like a password
  prompt, so only use this at a prompt you expect.
- It works in SSH sessions to saved hosts that use an identity (their own, or their group's)
  with a stored password. A password containing control characters is not typed.

## Checking stored passwords against breach lists

**Settings → Security → Compromised-password check** looks up the passwords stored in your vault
(host, identity and proxy passwords, remembered key passphrases) in a public list of passwords
from data breaches. It is off until you turn it on, and runs only when you click **Check stored
passwords**.

What is sent: for each stored password, only the first 5 characters of its SHA-1 hash (for
example `5BAA6`) go to the service address shown. The answer lists every known hash starting with
those characters, padded with decoys, and the match is made on your computer. Passwords, full
hashes and names never leave it; the service does see your IP address. The address can be
changed to another `https://` service that speaks the same range protocol.

This build cannot contact a service yet (it has no HTTPS client); the page says so and the check
button stays disabled.

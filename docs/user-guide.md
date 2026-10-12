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

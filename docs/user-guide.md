# User guide

Task-oriented notes for features as they land. The README covers installation.

## Identities

An identity is a user name, a password and a key saved once under **Keychain → Identities**.
Every part is optional except the name.

- **Use one for a host:** in the host editor choose **Identity** and pick it. The host signs in
  with the identity's key, or its password if it has no key. If the host leaves **User name**
  empty, the identity's user name is used.
- **Use one for a group:** in the group editor set **Default sign-in** to the identity. Hosts in
  the group (and its subgroups) that keep **Use the group's identity** use it.
- **Change it once:** editing an identity changes every host and group that uses it, the next
  time they connect.
- **Delete:** an identity in use cannot be deleted. Choose another sign-in method for its hosts
  and groups first. A key that an identity uses cannot be deleted either.

### Typing an identity's password at a sudo prompt

When a command such as `sudo` asks for a password in an SSH session, press **Ctrl+Shift+P**
(**Cmd+Shift+P** on macOS) or choose **Type the identity password into this terminal…** in the
command palette. A dialog names the identity and the host; **Type password** types it.

- Enter is not pressed for you. Check the prompt, then press Enter.
- Nothing is ever typed automatically. A server can print text that looks like a password prompt,
  so only use this at a prompt you expect.
- It works for hosts that use an identity with a stored password. A password containing control
  characters is not typed.

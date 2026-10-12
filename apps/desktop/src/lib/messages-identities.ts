// User-visible strings for reusable identities (KEY-15..18), kept apart from the other message
// modules so parallel branches never edit the same object. Same rules: stable keys,
// interpolation through functions.

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

export const msgI = {
  identities: {
    title: "Identities",
    intro: "A user name, password and key saved once. Hosts and groups that use an identity follow its changes.",
    add: "New identity",
    emptyTitle: "No identities yet",
    emptyBody: "Save a user name with a password or key once, then choose it for many hosts or a whole group.",
    editTitle: "Edit identity",
    newTitle: "New identity",
    label: "Name",
    username: "User name",
    usernameHint: "Optional. Hosts that set their own user name keep it.",
    password: "Password",
    passwordStored: "A password is stored. Leave this empty to keep it.",
    passwordHint: "Optional. Used to sign in when no key is chosen, and for typing into sudo prompts on request.",
    removePassword: "Remove the stored password",
    key: "Key",
    keyNone: "No key",
    keyHint: "Signs in with this key; its certificate, if attached, goes with it.",
    usedBy: (hosts: number, groups: number) =>
      hosts === 0 && groups === 0
        ? "Not used yet"
        : `Used by ${[hosts > 0 ? plural(hosts, "host", "hosts") : "", groups > 0 ? plural(groups, "group", "groups") : ""].filter(Boolean).join(" and ")}`,
    hasPassword: "password stored",
    keyLabel: (label: string) => `key ${label}`,
    keyMissing: "key missing",
    deleteTitle: (label: string) => `Delete ${label}?`,
    deleteBody: "Only an identity that no host or group uses can be deleted. Nothing falls back to another credential.",
    deleteInUse: (hosts: number, groups: number) =>
      `${plural(hosts, "host", "hosts")} and ${plural(groups, "group", "groups")} use this identity. Choose another sign-in method for them first.`,
  },
  hosts: {
    authIdentity: "Identity",
    authIdentityHint: "Uses the identity's key, else its password. Edits to the identity apply here too.",
    authIdentityNone: "Create an identity in the Keychain first.",
    chooseIdentity: "Choose an identity",
    summary: (label: string) => `Identity: ${label}`,
    summaryMissing: "Identity missing",
    inheritTitle: "Use the group's identity",
    inheritHint: (label: string) => `Currently: identity ${label}.`,
    identityUser: (user: string) => `From the identity: ${user}`,
    groupCredential: "Default sign-in",
    groupCredentialNone: "None",
    groupKeys: "Keys",
    groupIdentities: "Identities",
  },
  insert: {
    title: "Type identity password",
    palette: "Type the identity password into this terminal…",
    body: (identity: string, host: string) => `Types the password of identity “${identity}” into ${host}.`,
    noEnter: "Enter is not pressed for you: check the prompt, then press Enter in the terminal.",
    warning:
      "Only use this at a password prompt you expect, such as sudo. The server controls what the terminal shows and can print text that looks like a prompt.",
    confirm: "Type password",
    none: "This host does not use an identity, so there is no password to type.",
    noPassword: (identity: string) => `Identity “${identity}” has no stored password.`,
    needsSsh: "Open an SSH session to a saved host first.",
    done: (identity: string) => `Typed the password of “${identity}”. Press Enter to submit it.`,
  },
};

// User-visible strings for autosave (host details, group editor, environment), kept apart from
// messages.ts so parallel branches never edit the same object.

/** What is still unsaved when the user leaves an autosaving editor. */
export interface Unsaved {
  password: boolean;
  note: boolean;
}

/** The wording of the leave prompt for what is unsaved (`null`: nothing to ask about). */
export function discardWording(unsaved: Unsaved) {
  if (unsaved.password && unsaved.note) return msgAutosave.discard.both;
  if (unsaved.password) return msgAutosave.discard.password;
  if (unsaved.note) return msgAutosave.discard.note;
  return null;
}

export const msgAutosave = {
  saving: "Saving…",
  saved: "Saved",
  undone: "Change undone",
  failed: "Couldn't save –",
  retry: "Retry",
  undo: "Undo",
  undoLabel: "Undo the last change",
  done: "Done",
  // Secrets are set on purpose, never autosaved.
  setPassword: "Set password",
  passwordHint: "Not saved until you press Set password or Enter.",
  passwordReplaceHint: "A password is stored. Type a new one and press Set password to replace it.",
  passwordNeeded: "Set a password to use this sign-in.",
  removePassword: "Remove stored password",
  removesPassword: "This change removes the stored password from the vault, so it is not saved on its own.",
  removesProxyPassword: "This change removes the stored proxy password from the vault, so it is not saved on its own.",
  removeProxyPassword: "Remove proxy password",
  setProxyPassword: "Set proxy password",
  // Leaving with something that is not autosaved: a typed, unset password and/or note edits.
  discard: {
    password: {
      title: "Discard the password you typed?",
      body: "Everything else is saved. The password you typed has not been set.",
      action: "Discard password",
    },
    note: {
      title: "Discard your note changes?",
      body: "Everything else is saved. Your changes to the note have not been saved.",
      action: "Discard note changes",
    },
    both: {
      title: "Discard the password and note changes?",
      body: "Everything else is saved. The password you typed has not been set, and your changes to the note have not been saved.",
      action: "Discard both",
    },
  },
  keepEditing: "Keep editing",
  // Per-field validation: an invalid field is shown here and not saved.
  address: "Enter a host name or an IP address, without a scheme, user or path.",
  addressEmpty: "Enter the server's address.",
  label: "Enter a name without control or invisible characters.",
  labelDefault: "Defaults to the address.",
  username: "No spaces, control characters or leading hyphen.",
  keyMissing: "Choose a key. Until you do, the host keeps its current sign-in.",
  tags: "Tags are 32 characters at most, 16 per host, without control characters.",
  proxyHost: "Enter the proxy's host name or IP address.",
  routeHeld: "The jump host and proxy are saved together once every part is valid.",
  newHostHint: "Enter an address to save this host. Everything you change is saved as you go.",
  envName: "Letters, digits and underscores, not starting with a digit.",
  envHeld: "The variables are saved once every name is valid.",
  groupName: "Enter a name without “/”.",
  newGroupHint: "Enter a name to create the group. Everything you change is saved as you go.",
};

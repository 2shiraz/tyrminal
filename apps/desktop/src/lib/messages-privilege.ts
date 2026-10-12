// User-visible strings for privilege-prompt assistance (KEY-18), kept apart from the other
// message modules so parallel branches never edit the same object. Same rules: stable keys,
// interpolation through functions.

export const msgP = {
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

// User-visible strings for deleting an identity that is in use (BUILD_SPEC §10.2), kept apart
// from the other message modules so parallel branches never edit the same object.

import type { SignInAfter } from "@tyrminal/contracts";

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

export const msgI = {
  deletion: {
    title: (label: string) => `Delete ${label}?`,
    unused: "Nothing uses this identity.",
    loading: "Checking where this identity is used…",
    used: (hosts: number, groups: number) =>
      `${[hosts > 0 ? plural(hosts, "host", "hosts") : "", groups > 0 ? plural(groups, "group", "groups") : ""].filter(Boolean).join(" and ")} use this identity. Choose what they use instead.`,
    usersLabel: "Used by",
    group: "group",
    fromGroup: "from a group",
    reassign: "Use another identity instead",
    reassignHint: "Every host and group that names this identity names the one you choose.",
    chooseOther: "Identity to use instead",
    noOther: "There is no other identity to choose.",
    remove: "Remove it from them",
    removeHint: "Each host then signs in as listed below.",
    after: (what: string) => `then: ${what}`,
    confirm: "Delete identity",
  },
  signIn: (after: SignInAfter): string => {
    switch (after.kind) {
      case "identity":
        return `identity ${after.label}`;
      case "key":
        return after.label ? `key ${after.label}` : "a key";
      case "stored_password":
        return "its own stored password";
      case "ask_password":
        return "asks for the password";
    }
  },
};

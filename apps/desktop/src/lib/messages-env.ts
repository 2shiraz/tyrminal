// User-visible strings for startup snippets (SNP-08) and variable references in snippet reviews
// (SNP-14), kept apart from messages.ts so parallel branches never edit the same object.

export const msgEnv = {
  save: "Save",
  startup: "Startup snippets",
  startupHint: "Typed into the shell once it opens, in this order, each followed by Enter. Never before the server's host key is trusted. Each one is noted in the connection log.",
  startupInherit: "Use the group's list",
  startupInheritFrom: (group: string | null) => (group ? `Currently the list from ${group}` : "No group sets a list"),
  startupInheritTop: "Hosts in this group use it unless a subgroup or host sets its own",
  startupNone: "Run nothing",
  startupList: "Run these snippets",
  startupMissing: "Deleted snippet (skipped)",
  startupPick: "Add a snippet",
  startupRemove: (name: string) => `Remove ${name} from startup`,
  startupUp: (name: string) => `Move ${name} earlier`,
  startupTooMany: "16 snippets at most",
  startupTooLong: (line: number) => `Line ${line} is longer than 1000 bytes; terminals in line mode can't take it, so this snippet is not typed at startup.`,
  noSnippets: "Save a snippet first to run it at startup.",
  // Variables referenced by snippets.
  refs: "Variables this snippet uses",
  refSet: "set by Tyrminal",
  refRefused: "refused by the server",
  refUnknown: "not set by Tyrminal",
  refsHint: "Variables Tyrminal did not set may still come from the server's own shell configuration.",
};

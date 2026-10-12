// User-visible strings for snippet runs on hosts without an open session, by group and on every
// open session (SNP-05/06/07), kept apart from messages-d.ts so parallel branches never edit the
// same object.

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export const msgRuns = {
  runAllOpen: "Run on all open sessions",
  paletteRunAllOpen: "Run a snippet on all open sessions…",
  pickTitle: "Run a snippet on all open sessions",
  pickSnippet: "Snippet",
  pickNone: "Choose a snippet…",
  next: "Review",
  selectAll: "Select all",
  selectGroup: (name: string) => `Select group ${name}`,
  ungrouped: "Not in a group",
  targetLabel: (name: string, hosts: number, groups: number) =>
    `${name} (${[...(hosts > 0 ? [count(hosts, "host", "hosts")] : []), ...(groups > 0 ? [count(groups, "group", "groups")] : [])].join(", ")})`,
  targetMissing: (n: number) => (n === 1 ? "1 saved host or group no longer exists" : `${n} saved hosts or groups no longer exist`),
  closedNote: (n: number) =>
    n === 1
      ? "1 host has no open session: Tyrminal connects to it for this run and disconnects after. An unknown host key is asked about first."
      : `${n} hosts have no open session: Tyrminal connects to them for this run and disconnects after. An unknown host key is asked about first.`,
  concurrency: "Hosts at once",
  skipInput: "Skip hosts that need sign-in input",
  skipInputHint: "Hosts without a saved password, key or identity are skipped instead of asking.",
  queued: "Queued",
  connecting: "Connecting",
  waitingTrust: "Waiting for your decision",
  waitingSignIn: "Waiting for sign-in",
  cancelled: "Cancelled",
  skipped: (reason: string) => `Skipped: ${reason}`,
  needsSignIn: "needs sign-in",
  trustTitle: (host: string) => `Host key of ${host}`,
  trustBody: (host: string, endpoint: string) => `${host} (${endpoint}) presented a key Tyrminal has not seen before. Compare the fingerprint with one you trust.`,
  trustOnce: "Trust once",
  trustAlways: "Trust always",
  skipHost: "Skip this host",
  signInTitle: (host: string) => `Sign in to ${host}`,
  signInBody: (user: string, host: string) => `${host} asks ${user} to sign in.`,
  password: "Password",
  passphrase: "Key passphrase",
  answer: "Answer",
  signIn: "Sign in",
  copyOf: (host: string) => `Copy the output of ${host}`,
  saveOf: (host: string) => `Save the output of ${host}`,
  copy: "Copy",
  save: "Save…",
  copied: "Output copied",
  saved: (file: string) => `Output saved to ${file}`,
};

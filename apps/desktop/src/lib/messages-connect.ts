// Strings for the connection sheet (features/terminal/ConnectionSheet.tsx). Existing prompt titles,
// button names and the reconnect sentence stay in messages.ts so tests and guides keep matching.

export const msgConnect = {
  connectingTo: (label: string) => `Connecting to ${label}`,
  steps: "Connection steps",
  step: {
    resolving: { now: "Looking up the address", done: "Address found" },
    connecting: { now: "Connecting", done: "Connected" },
    keys: { now: "Agreeing on keys", done: "Keys agreed" },
    verifying_host: { now: "Checking server identity", done: "Server identity checked" },
    authenticating: { now: "Signing in", done: "Signed in" },
    opening_channel: { now: "Opening the shell", done: "Shell opened" },
  },
  stillWaiting: (seconds: number) => `still waiting, ${seconds} s`,
  ms: (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`),
  hop: (label: string, index: number, total: number) =>
    index === total ? `${label}, destination` : `${label}, jump host ${index} of ${total - 1}`,
  cancel: "Cancel",
  log: "Connection log",
  hideLog: "Hide log",
  logEmpty: "Nothing logged yet.",
  newServer: "new server",
  fingerprintFrom: (algorithm: string, address: string) => `${algorithm} fingerprint, from ${address}`,
  fingerprintLabel: "Fingerprint to compare",
  // Titles by cause; the core's message under the title says exactly what happened.
  failed: {
    AUTH_FAILED: "The server did not accept the sign-in",
    UNREACHABLE: "Could not reach the server",
    TIMEOUT: "The connection timed out",
    HOST_KEY_REJECTED: "The server's identity was not trusted",
    KEY_INVALID: "The key could not be used",
    CHANNEL_DENIED: "The server refused a shell",
    PROTOCOL_ERROR: "The server answered in a way Tyrminal could not use",
  } as Record<string, string>,
  lost: "Connection lost",
  lostAt: (label: string, time: string) => `${label} stopped responding at ${time}.`,
  dropped: "Connection dropped",
  attemptFailed: (n: number) => `Attempt ${n}`,
  schedule: "Tyrminal waits about 1, 2, 4, 8, 16 and 30 s between attempts, then stops.",
  cancelled: "Connection cancelled",
  cancelledBody: "Nothing more was sent to the server.",
  // connection track
  track: { resolve: "Address", connect: "Connect", verify: "Identity", auth: "Sign in", shell: "Shell" },
  via: (identity: string) => `SSH ${identity}`,
};

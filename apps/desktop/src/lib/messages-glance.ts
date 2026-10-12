// User-visible strings for server at a glance (P-32), in their own module so parallel branches
// never edit the same object. Same rules as messages.ts: stable keys, interpolation through
// functions.

export const msgG = {
  panel: "Server",
  open: "Server at a glance",
  close: "Close server panel",
  noSession: "Shows uptime, load, memory and disk use of the server behind the focused SSH session.",
  uptime: "Uptime",
  load: "Load",
  loadHint: "Average number of processes running or waiting, over 1, 5 and 15 minutes.",
  memory: "Memory",
  disks: "Disks",
  noDisks: "No filesystems reported.",
  unavailable: "Unavailable",
  used: (used: string, total: string) => `${used} of ${total} used`,
  notLinux: "Not available. This works on Linux servers only.",
  malformed: "Not available. The server's answer was not in the expected form.",
  failed: "Not available. The server did not answer the request.",
  off: "Off for this host.",
  enabled: "Show for this host",
  enabledHint: "Reads the values every 5 s while this panel is open, on a separate channel; nothing is typed into your shell.",
  refreshed: "Refreshes every 5 s while open.",
  days: (d: number, h: number) => `${d} d ${h} h`,
  hours: (h: number, m: number) => `${h} h ${m} min`,
  minutes: (m: number) => `${m} min`,
};

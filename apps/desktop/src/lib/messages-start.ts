// User-visible strings for the new-tab page ("+" in the tab strip), in their own module so parallel
// branches never edit the same object. Same rules as messages.ts: stable keys, interpolation
// through functions.

export const msgStart = {
  tabTitle: "New tab",
  identity: "Choose what to open",
  heading: "Open in this tab",
  searchLabel: "Find a host or connect to an address",
  searchPlaceholder: "Find a host or ssh user@hostname…",
  connect: "Connect",
  matches: "Matching hosts",
  noMatch: "No saved host matches.",
  quick: (target: string) => `Connect to ${target}`,
  actions: "Open",
  local: "Local terminal",
  sftp: "SFTP",
  serial: "Serial",
  serialHint: "A new host for a serial device",
  hosts: "Hosts",
  recent: "Recent connections",
  noRecent: "Hosts you connect to appear here.",
  noDetach: "A new tab page stays in this window. Open something in it first.",
};

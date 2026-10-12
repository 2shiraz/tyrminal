// User-visible strings for LAN discovery (HST-14), kept apart from messages.ts so parallel
// branches do not edit the same object. Same rules: stable keys, interpolation through functions.

export const msgDiscovery = {
  open: "Find on network…",
  title: "Find SSH servers on a network",
  intro:
    "Tyrminal asks the network you choose which computers announce an SSH server (DNS-SD, _ssh._tcp) and listens for 30 seconds. Nothing is sent until you press Start, and nothing is saved or connected to until you add a host.",
  untrusted: "Any computer on the network can announce any name. Check the address before you connect; the server's key is verified on the first connection as for every host.",
  network: "Network",
  networkOption: (id: string, addresses: string[]) => (addresses.length > 0 ? `${id} (${addresses.slice(0, 2).join(", ")})` : id),
  noNetworks: "No connected network was found on this computer.",
  start: "Start",
  stop: "Stop",
  listening: (seconds: number) => `Listening… ${seconds} s left`,
  finished: (count: number) => (count === 0 ? "Finished. No SSH servers answered." : `Finished. ${count === 1 ? "1 server" : `${count} servers`} found.`),
  idle: "Not started.",
  results: "Servers found",
  truncated: "More servers answered than can be listed; only the first ones are shown.",
  destination: (host: string, address: string | undefined, port: number) => [host, address].filter(Boolean).join(" · ") + ` port ${port}`,
  add: "Add host",
  addLabel: (name: string) => `Add ${name} as a host`,
};

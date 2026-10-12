// Agent B's user-visible strings (tunnels, history and logs), kept apart from messages.ts so the
// two parallel branches never edit the same object. Same rules: stable keys, interpolation
// through functions.

import type { TunnelKind, TunnelState } from "@tyrminal/contracts";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** host:port, with IPv6 literals in brackets. */
export function endpoint(host: string, port: number | string): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export const msgB = {
  advanced: {
    title: "Advanced",
    jumpHost: "Jump host",
    direct: "None (connect directly)",
    jumpHint: "Connect through another saved host first (ProxyJump).",
    via: (label: string) => `Connects through ${label} first. Each host's key is checked before anything is sent to it.`,
    missingJump: "Deleted host",
  },
  tunnels: {
    title: "Tunnels",
    subtitle: "Forward ports through your SSH connections. Listeners stay on this computer unless you approve otherwise.",
    add: "New tunnel",
    saved: "Saved tunnels",
    running: "Active",
    emptyTitle: "No tunnels yet",
    emptyBody: "Save a forwarding rule for a host, then start it on a connected session.",
    kind: "Type",
    kinds: {
      local: "Local",
      remote: "Remote",
      dynamic: "SOCKS proxy",
    } satisfies Record<TunnelKind, string>,
    kindHelp: {
      local: "Opens a port on this computer. Connections to it go through the server to the destination.",
      remote: "Opens a port on the server. Connections to it come back through this computer to the destination.",
      dynamic: "Opens a SOCKS5 proxy on this computer. Each connection goes wherever the application asks, through the server.",
    } satisfies Record<TunnelKind, string>,
    states: {
      running: "Running",
      stopped: "Stopped",
      session_ended: "Session ended",
      failed: "Failed",
    } satisfies Record<TunnelState, string>,
    name: "Name",
    host: "Host",
    chooseHost: "Choose a host",
    noHosts: "Add a host first. A tunnel always runs through one of your saved hosts.",
    hostMissing: "Host deleted",
    listenAddress: "Listen address",
    listenAddressLocalHint: "127.0.0.1 or localhost keeps it on this computer.",
    listenAddressRemoteHint: "localhost keeps it on the server's loopback. * or 0.0.0.0 lets others reach it (if the server allows).",
    listenPort: "Listen port",
    listenPortHint: "Leave empty to pick a free port when it starts.",
    destHost: "Destination host",
    destHostLocalHint: "As seen from the server, for example localhost or db.internal.",
    destHostRemoteHint: "As seen from this computer, for example localhost.",
    destPort: "Destination port",
    autoStart: "Start with every connection",
    autoStartHint: "Starts whenever a session to this host connects.",
    editorNew: "New tunnel",
    editorEdit: "Edit tunnel",
    start: "Start",
    startOn: (name: string, host: string) => `Start ${name} on ${host}`,
    stop: "Stop",
    stopNamed: (name: string) => `Stop ${name}`,
    connect: "Connect",
    connectFirst: (host: string) => `Connect to ${host} to start this tunnel.`,
    more: (name: string) => `Actions for ${name}`,
    edit: "Edit",
    duplicate: "Duplicate",
    delete: "Delete",
    deleteTitle: (name: string) => `Delete ${name}?`,
    deleteBody: "The rule is removed from your vault. A running forward of it keeps running until you stop it or the session ends.",
    clearEnded: "Clear ended",
    autoBadge: "Auto-start",
    exposedBadge: "Reachable from network",
    started: (name: string, where: string) => `${name} is listening on ${where}`,
    stopped: (name: string) => `${name} stopped`,
    mapping: (kind: TunnelKind, listen: string, dest: string) =>
      kind === "dynamic" ? `SOCKS5 on ${listen}` : kind === "remote" ? `server ${listen} → ${dest}` : `${listen} → ${dest}`,
    autoPort: "auto",
    invalidPort: "Enter a port from 1 to 65535.",
    invalidListenPort: "Enter a port from 1 to 65535, or leave it empty.",
    counters: (open: number, total: number, sent: number, received: number) =>
      `${open} open · ${total} total · ${bytes(sent)} sent · ${bytes(received)} received`,
    refused: (n: number) => `${n} over the limit`,
    failedConnections: (n: number) => `${n} could not connect`,
    activeEmpty: "Nothing is running. Start a saved tunnel on a connected session.",
    exposeTitle: "Allow connections from other computers?",
    exposeBody: (where: string) =>
      `This listener (${where}) can be reached from other computers on your network, not just this one. Anyone who can reach it can use your SSH connection through it.`,
    exposeRemoteBody: (where: string) =>
      `The server will listen on ${where}, which other machines on its network may reach (if the server allows it). Anyone who can reach it can connect to the destination through this computer.`,
    exposeConfirm: "Allow and save",
    exposeApproved: "You approved a listener that other computers can reach.",
    sessionsFor: (n: number) => (n === 1 ? "1 connected session" : `${n} connected sessions`),
    socksNote: "Applications use it as a SOCKS5 proxy with no user name or password.",
  },
};

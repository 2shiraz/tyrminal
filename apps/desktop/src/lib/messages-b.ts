// Agent B's user-visible strings (tunnels, history and logs), kept apart from messages.ts so the
// two parallel branches never edit the same object. Same rules: stable keys, interpolation
// through functions.

import type { TunnelKind, TunnelState } from "@tyrminal/contracts";

export function bytes(n: number): string {
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
  hops: {
    position: (index: number, total: number, label: string) =>
      index === total ? `Destination (hop ${index} of ${total}): ${label}` : `Jump host ${index} of ${total - 1}: ${label}`,
  },
  advanced: {
    title: "Advanced",
    jumpHost: "Jump host",
    direct: "None (connect directly)",
    jumpHint: "Connect through another saved host first (ProxyJump).",
    via: (label: string) => `Connects through ${label} first. Each host's key is checked before anything is sent to it.`,
    missingJump: "Deleted host",
    proxy: "Proxy",
    proxyKinds: { none: "None", http: "HTTP (CONNECT)", socks5: "SOCKS5" },
    proxyHint: "Reach this host through an HTTP or SOCKS5 proxy. The server's key is still checked end to end.",
    proxyWithJump: "Used only when this host is the first hop. With a jump host, set the proxy on the jump host.",
    proxyHost: "Proxy host",
    proxyPort: "Proxy port",
    proxyUser: "Proxy user name",
    proxyUserHint: "Leave empty if the proxy needs no sign-in.",
    proxyPassword: "Proxy password",
    proxyPasswordKeep: "Leave empty to keep the stored password.",
    httpCleartext: "An HTTP proxy receives the user name and password unencrypted (base64). Use it only on a network you trust.",
    keyExchange: "Post-quantum key exchange",
    keyExchangeModes: {
      prefer_post_quantum: "Use when offered (recommended)",
      require_post_quantum: "Require",
      classic: "Off (compatibility)",
    },
    keyExchangeHints: {
      prefer_post_quantum:
        "ML-KEM-768 with X25519 protects against later decryption by a quantum computer. Servers without it use X25519.",
      require_post_quantum: "Connects only to servers that offer it. Otherwise the connection stops before you sign in.",
      classic: "For servers that fail with post-quantum key exchange. The connection uses X25519 only.",
    },
  },
  quick: {
    region: "Port forwarding suggestions",
    offer: (port: number) => `Something on the server says it is listening on port ${port}. Forward it to this computer?`,
    forward: "Forward",
    notNow: "Not now",
    muteHost: "Don't suggest for this host",
    mutedHost: "Port suggestions are off for this host. Turn them back on in the host's settings.",
    active: (remote: number, local: number) => `Server port ${remote} is forwarded to 127.0.0.1:${local} on this computer.`,
    open: "Open in browser",
    opened: (url: string) => `Opened ${url}`,
    stop: "Stop",
    failed: "The port could not be forwarded.",
    setting: "Forwarding suggestions",
    settingHint: "When a program on a server says it is listening on a port, offer to forward it. Nothing is forwarded until you choose to.",
    hostSetting: "Forwarding suggestions for this host",
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
  recordings: {
    title: "Recordings",
    subtitle: "What your sessions printed, encrypted in this vault. Typed input is never recorded.",
    settingsTitle: "Recording",
    record: "Record sessions",
    recordHint: "Records the output of new SSH and local terminal sessions. Off by default.",
    keep: "Keep per host",
    keepHint: "Older recordings that are not bookmarked are deleted when a new one ends.",
    keepValue: (n: number) => (n === 1 ? "1 recording" : `${n} recordings`),
    limit: "Size limit per recording",
    limitHint: "A recording that reaches it ends; the session goes on unrecorded.",
    limitValue: (mib: number) => `${mib} MiB`,
    turnedOn: "New sessions will be recorded.",
    turnedOff: "Recording is off. Existing recordings are kept.",
    storage: (count: number, total: number) =>
      count === 0 ? "No recordings stored" : `${count === 1 ? "1 recording" : `${count} recordings`} · ${bytes(total)} on this computer`,
    deleteAll: "Delete all recordings",
    deleteAllTitle: "Delete every recording?",
    deleteAllBody:
      "This permanently deletes every recording in this vault, including bookmarked ones. Sessions being recorded now are kept. Recording stays on or off as it is.",
    deleteAllConfirm: "Delete all",
    deletedAll: (n: number) => (n === 1 ? "Deleted 1 recording." : `Deleted ${n} recordings.`),
    search: "Search recordings",
    searchPlaceholder: "Search by host or comment",
    filterAll: "All",
    filterBookmarked: "Bookmarked",
    filter: "Show",
    emptyTitle: "No recordings yet",
    emptyOffBody: "Turn on recording above, then connect to a host or open a local terminal.",
    emptyOnBody: "Sessions you open from now on will appear here.",
    noMatches: "No recordings match.",
    open: "Open",
    openNamed: (title: string) => `Open recording of ${title}`,
    bookmark: "Bookmark",
    unbookmark: "Remove bookmark",
    bookmarkNamed: (title: string) => `Bookmark recording of ${title}`,
    unbookmarkNamed: (title: string) => `Remove bookmark from recording of ${title}`,
    comment: "Comment",
    editComment: "Edit comment",
    commentTitle: "Bookmark and comment",
    commentLabel: "Comment",
    commentHint: "Shown in the list and searched. Up to 2,000 characters.",
    saveComment: "Save",
    delete: "Delete",
    deleteNamed: (title: string) => `Delete recording of ${title}`,
    deleteTitle: "Delete this recording?",
    deleteBody: (title: string) => `The recording of ${title} is deleted permanently.`,
    more: (title: string) => `More actions for recording of ${title}`,
    states: {
      recording: "Recording",
      complete: "Complete",
      size_limit: "Size limit reached",
      incomplete: "Incomplete",
      damaged: "Damaged",
      unreadable: "File missing",
    } as Record<string, string>,
    local: "Local terminal",
    duration: (ms: number) => {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s} s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m} min ${s % 60} s`;
      return `${Math.floor(m / 60)} h ${m % 60} min`;
    },
    // playback
    back: "Back to recordings",
    playerLabel: (title: string) => `Recording of ${title}`,
    replay: "Replay",
    replaying: "Replaying…",
    stopReplay: "Stop",
    speed: "Speed",
    showAll: "Show all",
    find: "Find in recording",
    findNext: "Next match",
    findPrevious: "Previous match",
    noMatch: "No match",
    readOnly: "Read-only playback. Links, clipboard requests and other terminal actions are turned off.",
    truncated: "This recording is longer than one playback shows. The first 16 MiB of output are shown.",
    incompleteNote: "This recording stops early: the application closed while it was being recorded. Everything shown was verified.",
    damagedNote: "Part of this recording failed verification. Only what came before that point is shown.",
    sizeLimitNote: "This recording reached its size limit; later output was not recorded.",
    recordingNote: "This session is still being recorded. Showing what has been recorded so far.",
  },
};

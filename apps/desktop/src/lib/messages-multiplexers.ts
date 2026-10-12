// User-visible strings for tmux and screen session awareness (P-31), kept apart from the other
// message modules so parallel branches never edit the same object.

import type { MultiplexerKind, MultiplexerUnavailable } from "@tyrminal/contracts";

const kinds: Record<MultiplexerKind, string> = { tmux: "tmux", screen: "screen" };

export const msgMx = {
  title: "tmux and screen",
  hint: "Sessions on this server, listed without typing anything into your shell.",
  refresh: "Refresh sessions",
  loading: "Listing sessions…",
  kind: (k: MultiplexerKind) => kinds[k],
  none: "No tmux or screen sessions are running.",
  notInstalled: "Neither tmux nor screen is installed on this server.",
  unavailable: { failed: "Could not list sessions.", malformed: "The server's answer could not be read." } as Record<MultiplexerUnavailable, string>,
  truncated: "Some sessions are not shown.",
  attached: "attached",
  windows: (n: number) => (n === 1 ? "1 window" : `${n} windows`),
  attach: "Attach",
  attachLabel: (kind: MultiplexerKind, name: string) => `Attach to ${kinds[kind]} session ${name}`,
  notAttachable: "Its name has characters Tyrminal will not put in a command. Attach to it yourself.",
  attachedNotice: (name: string) => `Typed the command to attach to ${name}.`,
  reattachTitle: "Reattach after reconnecting",
  reattachBody: (kind: MultiplexerKind, name: string) => `Before the connection dropped you were in ${kinds[kind]} session ${name}. Attach to it again?`,
  reattach: "Reattach",
  dismiss: "Not now",
};

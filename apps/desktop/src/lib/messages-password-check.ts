// User-visible strings for the compromised-password check (SEC-11), kept apart from the other
// message modules so parallel branches never edit the same object.

import type { StoredPasswordKind } from "@tyrminal/contracts";

const kinds: Record<StoredPasswordKind, string> = {
  host: "Host password",
  identity: "Identity password",
  proxy: "Proxy password",
  key_passphrase: "Key passphrase",
};

export const msgPC = {
  title: "Compromised-password check",
  body: "Look up the passwords stored in this vault in a public list of passwords from data breaches.",
  whatIsSent:
    "Only when you run a check: for each stored password, Tyrminal computes its SHA-1 hash on this computer and sends only the first 5 characters (for example 5BAA6) to the address below. The service answers with every known hash that starts with them, padded with decoys, and the comparison happens here. Passwords, full hashes and names never leave this computer. The service does see your IP address and when you check.",
  enable: "Allow compromised-password checks",
  enableHint: "Off by default. Nothing is sent until you turn this on and run a check.",
  serviceGroup: "Service",
  storedGroup: "Stored passwords",
  endpoint: "Service address",
  endpointHint: "An https:// address; the 5 characters are added to its end.",
  endpointInvalid: "Use an https:// address without a user name, query or fragment.",
  useEndpoint: "Use this address",
  stored: (n: number) => (n === 1 ? "1 stored password to check." : `${n} stored passwords to check.`),
  run: "Check stored passwords",
  checking: "Checking…",
  unavailable: "Not available in this build",
  kind: (k: StoredPasswordKind) => kinds[k],
  found: (count: number) => `Seen ${count.toLocaleString("en-US")} times in breaches. Change it.`,
  notFound: "Not found",
  summary: (found: number, total: number, requests: number) =>
    `${found} of ${total} stored passwords found in breaches (${requests} ${requests === 1 ? "request" : "requests"} sent).`,
};

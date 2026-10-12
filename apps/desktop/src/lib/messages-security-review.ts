// User-visible strings for the security review (P-27), kept apart from the other message modules
// so parallel branches never edit the same object.

import type { FindingSeverity } from "@tyrminal/contracts";

const severities: Record<FindingSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Note",
};

const usedBy = (n: number) => (n === 0 ? "No host uses it." : n === 1 ? "Used by 1 host." : `Used by ${n} hosts.`);

export const msgSR = {
  title: "Security review",
  body: "Checks the keys, sign-in methods, certificates and trusted host keys in this vault. It runs on this computer only, sends nothing, and changes nothing until you choose a fix.",
  run: "Review again",
  running: "Reviewing…",
  severity: (s: FindingSeverity) => severities[s],
  summary: (findings: number) => (findings === 1 ? "1 thing to look at" : `${findings} things to look at`),
  scope: (keys: number, hosts: number, certificates: number, knownHosts: number) =>
    `Reviewed ${keys} ${keys === 1 ? "key" : "keys"}, ${hosts} SSH ${hosts === 1 ? "host" : "hosts"}, ${certificates} ${certificates === 1 ? "certificate" : "certificates"} and ${knownHosts} trusted host ${knownHosts === 1 ? "key" : "keys"}.`,
  clean: "Nothing needs attention.",
  dsa: {
    title: (label: string) => `DSA key "${label}"`,
    body: (n: number) =>
      `DSA keys are limited to 1024 bits and SHA-1, and current OpenSSH servers refuse them. Generate a new key, deploy it, then switch the hosts to it. ${usedBy(n)}`,
  },
  shortRsa: {
    title: (label: string, bits: number) => `${bits}-bit RSA key "${label}"`,
    body: (n: number) => `RSA keys should be at least 3072 bits. Generate a new key, deploy it, then switch the hosts to it. ${usedBy(n)}`,
  },
  noPassphrase: {
    title: (label: string) => `Key "${label}" has no passphrase of its own`,
    body: (stored: boolean, n: number) =>
      `${stored ? "Its passphrase is stored with it, so" : "It"} is protected only by the vault's encryption. That is how Tyrminal keeps the keys it generates; a key you also use outside Tyrminal is safer with its own passphrase. ${usedBy(n)}`,
  },
  password: {
    title: (label: string) => `"${label}" signs in with a password`,
    body: (stored: boolean) =>
      `${stored ? "The password is stored in the vault." : "The password is asked for on each connection."} A key is stronger: connect, deploy a key from the session menu, then choose the key here.`,
  },
  certExpired: {
    title: (label: string) => `Certificate of "${label}" has expired`,
    body: (date: string) => `It was valid until ${date}. Servers that require it will refuse the key. Attach a renewed certificate in the keychain.`,
  },
  certExpiring: {
    title: (label: string) => `Certificate of "${label}" expires soon`,
    body: (date: string) => `It is valid until ${date}. Attach a renewed certificate in the keychain before then.`,
  },
  unusedKnownHost: {
    title: (endpoint: string) => `Trusted key for ${endpoint} is not used by any host`,
    body: (algorithm: string, fingerprint: string) =>
      `${algorithm} · ${fingerprint}. If you no longer connect there, removing it means a future connection asks you to verify the server again.`,
  },
  rsaOnlyKnownHost: {
    title: (endpoint: string) => `${endpoint} is trusted only by an RSA host key`,
    body: (fingerprint: string) =>
      `${fingerprint}. Tyrminal accepts it only with SHA-2 signatures, never SHA-1. If the server also has an Ed25519 key, removing this entry lets you verify and trust that key on the next connection.`,
  },
  endpoint: (host: string, port: number) => (port === 22 ? host : `${host}:${port}`),
  unknownKey: "(key no longer in the keychain)",
  actions: {
    generate: "Generate a key",
    keychain: "Open keychain",
    editHost: "Edit host",
    remove: "Remove…",
  },
};

// Agent D's user-visible strings (inventory presentation, importers, keys and snippets beyond the
// original set), kept apart from messages.ts so parallel branches never edit the same object.
// Same rules: stable keys, interpolation through functions.

import type { HostOs } from "@tyrminal/contracts";

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

export const osNames: Record<HostOs, string> = {
  linux: "Linux",
  ubuntu: "Ubuntu",
  debian: "Debian",
  fedora: "Fedora",
  red_hat: "Red Hat Enterprise Linux",
  centos: "CentOS",
  alpine: "Alpine Linux",
  arch: "Arch Linux",
  suse: "SUSE",
  raspberry_pi: "Raspberry Pi OS",
  free_bsd: "FreeBSD",
  open_bsd: "OpenBSD",
  macos: "macOS",
  windows: "Windows",
  network_device: "Network device",
};

export const msgD = {
  inventory: {
    sortAddress: "Address",
    sortGroup: "Group",
    selectAll: "Select all shown hosts",
    selectAllShort: "Select all",
    os: "Operating system",
    osUnset: "Not set",
    setOs: "Set OS",
    setOsTitle: (n: number) => `Set the OS of ${plural(n, "host", "hosts")}`,
    setOsHelp: "Chooses the icon on the host tile. It does not change how Tyrminal connects.",
    osChanged: (n: number) => `${plural(n, "host", "hosts")} changed`,
    osLabel: (name: string) => `Operating system: ${name}`,
    connectSelected: "Connect",
    connectGroup: "Connect to every host",
    connectAllTitle: (n: number) => `Open ${plural(n, "session", "sessions")}?`,
    connectAllGroupBody: (group: string) => `Every host in “${group}” and its subgroups:`,
    connectAllSelectionBody: "The selected hosts:",
    connectAllConfirm: (n: number) => `Open ${plural(n, "session", "sessions")}`,
    connectAllNone: "There are no hosts in this group or its subgroups.",
    connectAllTooMany: (free: number) =>
      free === 0
        ? "No more sessions can be opened. Close some tabs first."
        : `Only ${plural(free, "more session", "more sessions")} can be open at once. Select fewer hosts or close some tabs.`,
    connectAllNote: "Each host opens in its own tab and asks for any password or host-key decision there.",
    connectAllDone: (n: number) => `Opening ${plural(n, "session", "sessions")}`,
  },
  import: {
    body: "From another SSH client's saved sessions, an OpenSSH config, a CSV file, or hosts you already trusted. You see a preview first; nothing in a file is run, and stored passwords are never imported.",
    putty: "PuTTY (.reg export)",
    mobaxterm: "MobaXterm (.ini, .mxtsessions)",
    securecrt: "SecureCRT (.xml export, session .ini)",
    knownHosts: "Trusted known hosts",
    puttyHint: "In PuTTY's registry, export HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions (regedit → Export, or reg export). SSH sessions become hosts; key files and tunnels are listed but not imported.",
    mobaxtermHint: "Choose MobaXterm.ini or a file exported with Sessions → Export. SSH and SFTP sessions become hosts in their folders; saved passwords are never imported.",
    securecrtHint: "Choose the XML file from Tools → Export Settings, or one session's .ini file. SSH2 sessions become hosts in their folders; saved passwords are never imported.",
    knownHostsHint: "Servers whose keys you trusted on a connection but that have no host entry. Each becomes a host; set its user name before connecting.",
    knownHostsNone: "Every trusted known host already has a host entry.",
  },
};

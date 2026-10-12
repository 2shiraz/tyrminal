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
};

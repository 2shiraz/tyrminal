// User-visible strings for production host guardrails (P-26), kept apart from messages.ts so
// parallel branches do not edit the same object. Stable keys, interpolation through functions.

export const msgProduction = {
  label: "Production",
  hostSwitch: "Production host",
  hostHint: "Production sessions are marked, and broadcasting, multi-host runs and group connects ask first.",
  inheritedGroup: "This host is a production host through its group.",
  inheritedTag: (tag: string) => `This host is a production host through its “${tag}” tag.`,
  groupSwitch: "Production group",
  groupHint: "Every host in this group and its subgroups is a production host.",
  settingTag: "Production tag",
  settingTagHint: "Hosts with this tag are production hosts too. Leave empty to use only the production switch.",
  confirmCancel: "Cancel",
  confirmHosts: (count: number) => (count === 1 ? "This includes a production host:" : `This includes ${count} production hosts:`),
  broadcastTitle: "Broadcast to production?",
  broadcastBody: "What you type will also be sent to these production sessions.",
  broadcastConfirm: "Broadcast",
  runTitle: "Run on production hosts?",
  runBody: "The snippet will run on these production hosts as well.",
  runConfirm: "Run anyway",
  connectTitle: "Connect to production hosts?",
  connectBody: "Sessions will open to these production hosts as well.",
  connectConfirm: "Connect",
};

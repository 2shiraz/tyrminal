// User-visible strings for group defaults of route and appearance (HST-05), kept apart from
// messages.ts so parallel branches never edit the same object.

export const msgDefaults = {
  routeInherit: "Use the group's route",
  routeInheritFrom: (group: string, summary: string) => `From ${group}: ${summary}`,
  routeOwn: "Set a route for this host",
  routeVia: (label: string) => `through ${label}`,
  routeProxy: (kind: string, host: string) => `${kind} proxy ${host}`,
  routeDirect: "directly",
  section: "Defaults for hosts in this group",
  sectionHint: "Hosts that do not set these themselves use the nearest group's. Jump host and proxy go together as one route.",
  inheritedRoute: (group: string, summary: string) => `Without a route here, hosts use ${group}'s: ${summary}.`,
  os: "Icon",
  osNone: "None (use the parent group's)",
  inheritedOs: (group: string, os: string) => `Without an icon here, hosts show ${group}'s: ${os}.`,
};

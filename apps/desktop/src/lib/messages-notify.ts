// UI strings for command-finished notifications (P-23).

export const msgN = {
  settingTitle: "Notify when a long command finishes",
  settingHint: "Needs shell integration. Shows the tab, exit status and duration when you are not looking at that tab; never the command or its output.",
  minSeconds: "For commands that run at least",
  seconds: "seconds",
  finishedOk: (tab: string) => `Command finished in ${tab}`,
  finishedFailed: (tab: string, code: number) => `Command failed in ${tab} (exit status ${code})`,
  badgeOk: "command finished",
  badgeFailed: (code: number) => `command failed with exit status ${code}`,
};

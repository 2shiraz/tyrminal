// User-visible strings for search across sessions (P-28) and command output (P-29), kept apart
// from messages.ts so parallel branches never edit the same object.

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

export const msgOutput = {
  searchTitle: "Search all sessions",
  searchLabel: "Text to find in every open session",
  searchHint: "Searches the scrollback of every open terminal, in memory only. Nothing is saved or logged.",
  caseSensitive: "Match case",
  searchSummary: (matches: number, tabs: number) => `${plural(matches, "match", "matches")} in ${plural(tabs, "tab", "tabs")}`,
  searchNone: "No matches in any open session.",
  searchSearching: "Searching…",
  searchCapped: (shown: number) => `Showing the first ${shown} matches.`,
  searchMore: "More…",
  searchEmpty: "Type to search.",
  paletteSearch: "Search all sessions…",
  outputTitle: "Command output",
  outputIntro: "Copy or save what one command printed, without the prompt or the command line. The shell integration marks where each command's output starts and ends.",
  outputNone: "No commands yet. Commands appear here as you run them with shell integration on.",
  outputUnread: "(command line not read)",
  outputRunning: "Still running",
  outputGone: "No longer in the scrollback",
  outputExit: (status: number | null) => (status === null ? "Finished" : status === 0 ? "Exit 0" : `Exit ${status}`),
  copy: "Copy output",
  copyOf: (command: string) => `Copy the output of ${command}`,
  save: "Save output…",
  saveOf: (command: string) => `Save the output of ${command} to a file`,
  copied: "Output copied",
  saved: (file: string) => `Output saved to ${file}`,
  paletteOutput: "Copy or save a command's output…",
};

// User-visible strings for selecting and opening several hosts at once, kept apart from
// messages.ts so parallel branches do not edit the same object. Stable keys, interpolation
// through functions.

export const msgSelect = {
  connectN: (n: number) => (n === 1 ? "Connect" : `Connect ${n} hosts`),
  layout: "Open as",
  tabs: "In separate tabs",
  moreWays: "More ways to open",
  dontAskAgain: "Open and don't ask again",
  dontAskAgainProduction: "Open and don't ask again, production hosts too",
  split: "In one tab, split",
  openInSftp: (n: number) => (n === 1 ? "Open in SFTP" : `Open ${n} in SFTP`),
  connectInSplit: "Connect in split",
  clear: "Clear",
  /** Read after a selected host's name by assistive technology. */
  selectedNote: "Selected",
  /** Shown on hosts the first few times: there is no Connect button on rows and cards. */
  doubleClickHint: "Double-click to connect",
  /** Home tiles and palette hints. */
  inSplit: "split",
  inSftp: "SFTP",
  splitNote: "The hosts open side by side in one tab; each asks for any password or host-key decision in its own pane.",
};

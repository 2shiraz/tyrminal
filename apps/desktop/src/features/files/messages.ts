// User-visible strings of the redesigned file browser (Files panel and SFTP tab), kept apart from
// lib/messages.ts so parallel branches do not edit the same object. Same rules: stable keys,
// interpolation through functions.

export const msgFiles = {
  // Header and toolbar
  on: (label: string) => `on ${label}`,
  uploadMenu: "Upload",
  uploadFiles: "Upload files…",
  uploadFolder: "Upload folder…",
  downloadFolder: "Download this folder…",
  newFolder: "New folder",
  viewOptions: "View options",
  showHidden: "Show hidden files",
  showLocal: "Show this computer",
  // Path bar
  path: "Folder on the server",
  pathEdit: "Edit path",
  pathCrumbs: "Folder path",
  pathHint: "Type a folder path and press Enter. Escape cancels.",
  // Table
  columns: { name: "Name", modified: "Date Modified", size: "Size", mode: "Permissions", modeShort: "Mode" },
  sortBy: (column: string) => `Sort by ${column}`,
  rowMenu: (name: string) => `More actions for ${name}`,
  folderMenu: "Folder actions",
  renameField: (name: string) => `New name for ${name}`,
  renameHint: "Enter saves, Escape cancels.",
  // Row and folder menus
  open: "Open",
  download: "Download…",
  edit: "Edit…",
  rename: "Rename",
  permissions: "Permissions…",
  delete: "Delete…",
  deleteMany: (n: number) => `Delete ${n} items?`,
  copyPath: "Copy path",
  copyTo: "Copy to another server…",
  toLocal: "Download to this computer",
  refresh: "Refresh",
  pathCopied: "Path copied",
  // States
  emptyTitle: "This folder is empty",
  emptyBody: "Drop files here or use Upload.",
  emptyBodyReadOnly: "Nothing is in this folder.",
  onlyHidden: (n: number) => (n === 1 ? "1 hidden item. Turn on Show hidden files to see it." : `${n} hidden items. Turn on Show hidden files to see them.`),
  loadFailed: "Could not open this folder",
  retry: "Try again",
  // Transfers
  showTransfers: "Show transfers",
  hideTransfers: "Hide transfers",
  summary: (running: number, failed: number) =>
    [running > 0 ? `${running} running` : null, failed > 0 ? `${failed} failed` : null].filter(Boolean).join(" · ") || "All finished",
  rate: (perSecond: string) => `${perSecond}/s`,
  percent: (n: number) => `${n}%`,
  // SFTP tab
  swap: "Swap panes",
  copyToOther: (where: string) => `Copy to ${where}`,
};

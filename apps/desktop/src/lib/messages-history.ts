// User-visible strings for command history (AUT-01), kept in their own module so parallel
// branches never edit the same object. Same rules as messages.ts: stable keys, interpolation
// through functions.

export const msgH = {
  group: "History",
  manage: "History…",
  title: "Command history",
  enabled: "Remember commands for suggestions",
  enabledHint:
    "Keeps the commands you run, per host, encrypted in this vault, and offers them here. Needs shell integration: only the command line the shell shows at its prompt is kept, never what you type while a command runs (such as a password). Lines that start with a space are not remembered.",
  offNote: "History is off. Nothing new is remembered or suggested; what is listed below stays until you delete it.",
  filter: "Filter commands",
  empty: "No commands remembered yet.",
  noneMatch: "No remembered command matches.",
  local: "Local terminal",
  deletedHost: "Deleted host",
  uses: (n: number) => (n === 1 ? "used once" : `used ${n} times`),
  remove: (command: string) => `Forget ${command}`,
  clear: "Clear history…",
  clearTitle: "Clear command history?",
  clearBody: "Every remembered command is deleted from this vault. This cannot be undone.",
  cleared: (n: number) => (n === 1 ? "1 command deleted" : `${n} commands deleted`),
  back: "Back to suggestions",
  insertHint: "A remembered command is put on the command line for you to review; it is never run.",
};

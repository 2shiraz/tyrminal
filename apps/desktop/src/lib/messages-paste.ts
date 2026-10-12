// UI strings for paste safety (P-25).

export const msgP = {
  title: (label: string) => `Paste into ${label}?`,
  target: (label: string, identity: string) => `Goes to ${label} · ${identity}`,
  lines: (n: number) => `This paste has ${n} lines. In a shell, each line can run as a command.`,
  runsAtOnce: "This line ends with a newline, so it runs as soon as it is pasted.",
  hidden: (n: number) =>
    n === 1
      ? "This paste contains 1 hidden character that would not show on screen. It is marked below."
      : `This paste contains ${n} hidden characters that would not show on screen. They are marked below.`,
  hiddenKinds: {
    control: "control character",
    escape: "escape (starts a terminal command sequence)",
    c1: "C1 control character",
    bidi: "text direction override (can make text look different from what runs)",
    "zero-width": "zero-width character",
  } as Record<string, string>,
  bracketEnd:
    "This paste contains a bracketed-paste end marker (ESC [201~). It would end the paste early and run the rest as if you typed it, so it cannot be pasted as it is.",
  removeBracketEnd: "Remove the end marker",
  bracketed: "The terminal asked for bracketed paste, so the shell should insert the text without running it.",
  send: "Paste",
  preview: "Text to be pasted",
};

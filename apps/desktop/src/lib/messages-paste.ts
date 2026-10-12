// User-visible strings for paste safety (P-25), kept apart from messages.ts so parallel branches
// never edit the same object.

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

export const msgPaste = {
  titleBracketEnd: "This paste would end bracketed paste early",
  titleHidden: "This paste has hidden characters",
  titleMultiline: "Paste several lines?",
  titleLarge: "Paste a large amount of text?",
  titleTrailingNewline: "Paste and run this line?",
  target: "Pasting into",
  multiline: (lines: number) => `This paste has ${lines} lines. In a shell, each line can run as a command.`,
  large: (chars: number) => `This paste is ${chars.toLocaleString("en-US")} characters long.`,
  trailingNewline: "This line ends in a newline, so the shell runs it as soon as it is pasted.",
  hidden: (count: number) =>
    `${plural(count, "control or invisible character", "control or invisible characters")} shown as ␛ or <U+…> below. They can change what the shell receives, or make the text read differently from what runs.`,
  bracketEnd:
    "The text contains the bracketed-paste end marker (ESC [201~). Sent as it is, everything after it would run as typed input. It cannot be pasted with the marker in it.",
  removeMarker: "Remove the marker and paste",
  textLabel: "Text to paste, with hidden characters shown",
  // Host settings
  hostSection: "Paste review",
  hostSkipMultiline: "Paste several lines or a large text without review",
  hostSkipTrailingNewline: "Paste one line ending in a newline without review",
  hostHint: "Pastes with control or invisible characters are always reviewed, on every host.",
};

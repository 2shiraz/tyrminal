// UI strings for terminal input and connection tools: broadcast target choice, highlighting
// rules, the connection side panel, connection details and palette additions.

export const msgI = {
  broadcast: {
    include: (label: string) => `Send typed input to ${label}`,
    excludedNote: (n: number) => (n === 1 ? "1 pane left out: it keeps its own input." : `${n} panes left out: they keep their own input.`),
    needTwo: "Choose at least two panes.",
    excluded: "Left out of broadcast",
  },
  highlight: {
    kind: "Match as",
    word: "Word",
    pattern: "Pattern",
    patternLabel: "Pattern to highlight",
    patternHint:
      "A regular expression. To keep matching fast, groups cannot be repeated, and backreferences and lookaround are not available. Patterns run apart from the terminal and one that takes too long is switched off.",
    patternSample: (text: string) => `/${text}/`,
    patternLimit: "8 patterns at most.",
    slow: "Off: took too long. Edit the rules to try again.",
    slowNotice: (text: string) => `The highlight pattern /${text}/ took too long and was switched off.`,
    duplicate: "This rule is already in the list.",
  },
  details: {
    action: "Connection details…",
    link: "Show connection details",
    title: (label: string) => `Connection details: ${label}`,
    listLabel: "Connection steps",
    loading: "Loading…",
    empty: "No details were recorded for this connection.",
    copy: "Copy",
    copied: "Copied the connection details.",
    copyFailed: "The clipboard is not available. Select the lines to copy them.",
    note: "What happened while connecting, step by step. Passwords, passphrases and keys are never included.",
  },
  palette: {
    nextTab: "Next tab",
    prevTab: "Previous tab",
    renameTab: "Rename tab…",
    closeTab: "Close tab",
    closeOtherTabs: "Close other tabs",
    focusLeft: "Focus pane on the left",
    focusRight: "Focus pane on the right",
    focusUp: "Focus pane above",
    focusDown: "Focus pane below",
    moveLeft: "Move pane left",
    moveRight: "Move pane right",
    moveUp: "Move pane up",
    moveDown: "Move pane down",
    copy: "Copy selection",
    paste: "Paste",
    groupTabs: "Tabs and panes",
  },
};

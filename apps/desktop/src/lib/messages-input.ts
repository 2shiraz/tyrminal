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
};

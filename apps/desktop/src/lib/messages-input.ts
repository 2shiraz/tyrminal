// UI strings for terminal input and connection tools: broadcast target choice, highlighting
// rules, the connection side panel, connection details and palette additions.

export const msgI = {
  broadcast: {
    include: (label: string) => `Send typed input to ${label}`,
    excludedNote: (n: number) => (n === 1 ? "1 pane left out: it keeps its own input." : `${n} panes left out: they keep their own input.`),
    needTwo: "Choose at least two panes.",
    excluded: "Left out of broadcast",
  },
};

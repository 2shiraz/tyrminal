// Agent C's UI strings (workspaces, layouts, terminal polish). Kept apart from messages.ts so
// parallel branches do not edit the same file.

export const msgC = {
  status: {
    attention: "needs your input",
    bad: "disconnected",
    busy: "connecting",
    unread: "new output",
    /** Spoken after a tab or session name, e.g. "web-1 (new output, needs your input)". */
    describe(s: { indicator: string; unread: boolean }): string {
      const parts: string[] = [];
      if (s.unread) parts.push(msgC.status.unread);
      if (s.indicator === "attention") parts.push(msgC.status.attention);
      else if (s.indicator === "bad") parts.push(msgC.status.bad);
      else if (s.indicator === "busy") parts.push(msgC.status.busy);
      return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
    },
    panesNeedInput: (n: number) => (n === 1 ? "1 pane needs your input" : `${n} panes need your input`),
    panesDisconnected: (n: number) => (n === 1 ? "1 pane disconnected" : `${n} panes disconnected`),
  },
  tabs: {
    duplicate: "Duplicate tab",
    duplicateFull: (panes: number) => `Not enough room: a copy needs ${panes} more panes and at most 16 can be open.`,
  },
  panes: {
    full: "At most 16 panes can be open. Close one first.",
    dragToSwap: "Drag onto another pane to swap places",
    toNewTab: "Move pane to a new tab",
    focusLayout: "Focus layout",
    leaveFocus: "Leave focus layout",
    list: "Panes in this tab",
    listTitle: (n: number) => `${n} panes`,
    arrangeGrid: "Arrange panes in a grid",
    arrangeColumns: "Arrange panes side by side",
    arrangeRows: "Arrange panes stacked",
    moveLeft: "Move pane left",
    moveRight: "Move pane right",
    moveUp: "Move pane up",
    moveDown: "Move pane down",
    splitRightWith: "Split right with…",
    splitDownWith: "Split down with…",
    pickTitle: (where: string) => `Open in a new pane ${where}: pick a host or a local shell`,
    right: "to the right",
    below: "below",
  },
  restore: {
    title: "Not connected",
    body: (where: string) => `Restored from a saved layout. Connect to open a new session to ${where}. Nothing runs until you do, and nothing from an earlier session is replayed.`,
    connect: "Connect",
    connectAll: "Connect all in this tab",
    waiting: (label: string) => `${label}, not connected`,
    missingHost: "Missing host",
  },
  layouts: {
    group: "Layouts",
    open: (name: string) => `Open layout “${name}”`,
    save: "Save layout",
    saveAs: "Save layout as…",
    saveNamed: (name: string) => `Save layout “${name}”`,
    delete: (name: string) => `Delete layout “${name}”`,
    nameLabel: "Layout name",
    saveTitle: "Save the open tabs as a layout",
    saveBody:
      "Saves the tabs, how their panes are arranged and where each pane connects. Not saved: commands, output, directories or anything typed. Opening the layout later shows every pane disconnected until you choose Connect.",
    saved: (name: string) => `Saved layout “${name}”.`,
    deleted: (name: string) => `Deleted layout “${name}”.`,
    full: (n: number) => `Not enough room: this layout has ${n} panes and at most 16 can be open.`,
    unsaved: "Unsaved changes",
    summary: (tabs: number, panes: number) => `${tabs === 1 ? "1 tab" : `${tabs} tabs`}, ${panes === 1 ? "1 pane" : `${panes} panes`}`,
    current: (name: string) => `Layout: ${name}`,
    menu: (name: string) => `Layout ${name}`,
  },
};

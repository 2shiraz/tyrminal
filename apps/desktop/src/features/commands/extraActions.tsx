// Palette entries for every remaining application action (UX-03): tab and pane navigation,
// copy and paste, and the connection details of the focused session (CON-15). Each entry is
// offered only where it can act, and runs the same code path as its shortcut.

import type { ReactNode } from "react";

import {
  IconArrowLeftRight,
  IconArrowUpDown,
  IconChevronLeft,
  IconChevronRight,
  IconClipboardPaste,
  IconCopy,
  IconInfo,
  IconPencil,
  IconX,
} from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-input";
import type { ActionId } from "../../lib/shortcuts";
import type { PaletteItem } from "../palette/CommandPalette";

export interface ExtraContext {
  /** A terminal tab is in front. */
  hasTerminal: boolean;
  tabCount: number;
  /** The tab in front has more than one pane. */
  split: boolean;
  onAction: (action: ActionId) => void;
  onCloseTab: () => void;
  onCloseOtherTabs: () => void;
  onCopy: () => void;
  onPaste: () => void;
  /** Present when the focused pane is an SSH session that has a session id. */
  onDetails?: (() => void) | undefined;
}

export function extraPaletteItems(c: ExtraContext): PaletteItem[] {
  const items: PaletteItem[] = [];
  const add = (id: string, label: string, icon: ReactNode, run: () => void, shortcut?: ActionId) =>
    items.push({ id: `extra-${id}`, group: msg.palette.groupActions, label, icon, run, shortcut });
  if (!c.hasTerminal) return items;
  if (c.onDetails) add("details", msgI.details.action, <IconInfo size={16} />, c.onDetails);
  add("copy", msgI.palette.copy, <IconCopy size={16} />, c.onCopy, "copy");
  add("paste", msgI.palette.paste, <IconClipboardPaste size={16} />, c.onPaste, "paste");
  add("rename-tab", msgI.palette.renameTab, <IconPencil size={16} />, () => c.onAction("renameTab"), "renameTab");
  add("close-tab", msgI.palette.closeTab, <IconX size={16} />, c.onCloseTab);
  if (c.tabCount > 1) {
    add("next-tab", msgI.palette.nextTab, <IconChevronRight size={16} />, () => c.onAction("nextTab"), "nextTab");
    add("prev-tab", msgI.palette.prevTab, <IconChevronLeft size={16} />, () => c.onAction("prevTab"), "prevTab");
    add("close-other-tabs", msgI.palette.closeOtherTabs, <IconX size={16} />, c.onCloseOtherTabs);
  }
  if (c.split) {
    add("focus-left", msgI.palette.focusLeft, <IconArrowLeftRight size={16} />, () => c.onAction("focusLeft"), "focusLeft");
    add("focus-right", msgI.palette.focusRight, <IconArrowLeftRight size={16} />, () => c.onAction("focusRight"), "focusRight");
    add("focus-up", msgI.palette.focusUp, <IconArrowUpDown size={16} />, () => c.onAction("focusUp"), "focusUp");
    add("focus-down", msgI.palette.focusDown, <IconArrowUpDown size={16} />, () => c.onAction("focusDown"), "focusDown");
    add("move-left", msgI.palette.moveLeft, <IconArrowLeftRight size={16} />, () => c.onAction("movePaneLeft"), "movePaneLeft");
    add("move-right", msgI.palette.moveRight, <IconArrowLeftRight size={16} />, () => c.onAction("movePaneRight"), "movePaneRight");
    add("move-up", msgI.palette.moveUp, <IconArrowUpDown size={16} />, () => c.onAction("movePaneUp"), "movePaneUp");
    add("move-down", msgI.palette.moveDown, <IconArrowUpDown size={16} />, () => c.onAction("movePaneDown"), "movePaneDown");
  }
  return items;
}

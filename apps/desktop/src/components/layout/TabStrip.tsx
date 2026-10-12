import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Destination } from "../../app/AppShell";
import { msgN } from "../../lib/messages-notify";
import { type Direction, type Workspace, panesOf, tabStatus, tabTitle } from "../../app/workspace";
import { msg } from "../../lib/messages";
import { animateOut, useFlip } from "../../lib/motion";
import { msgC } from "../../lib/messages-c";
import { msgProduction } from "../../lib/messages-production";
import { Menu, type MenuEntry } from "../ui/Menu";
import { IconButton, Shortcut } from "../ui/controls";
import {
  IconAppWindow,
  // agent B: tunnels and history
  IconRoute,
  IconArrowLeftRight,
  IconColumns2,
  IconCopy,
  IconFingerprint,
  IconHistory,
  IconKeyRound,
  IconLayoutTemplate,
  IconPencil,
  IconPlus,
  IconRows2,
  IconSave,
  IconScrollText,
  IconServer,
  IconSettings,
  IconX,
} from "../ui/icons";
import { msgSftp } from "../../features/sftp/messages";

const PAGE_ICONS: Record<Destination, typeof IconServer> = {
  hosts: IconServer,
  snippets: IconScrollText,
  keychain: IconKeyRound,
  knownHosts: IconFingerprint,
  settings: IconSettings,
  // agent B: tunnels and history
  tunnels: IconRoute,
  recordings: IconHistory,
};

function TabStripImpl({
  ws,
  destination,
  renaming,
  onRenaming,
  onSelect,
  onClose,
  onCloseOthers,
  onRename,
  onMove,
  onSplit,
  onDuplicate,
  onDetach,
  onNewLocal,
  onNewSftp,
  onOpenPalette,
  finished,
  layout,
  recent,
  production,
}: {
  ws: Workspace;
  destination: Destination;
  renaming: number | null;
  onRenaming: (id: number | null) => void;
  onSelect: (id: number | null) => void;
  onClose: (id: number) => void;
  onCloseOthers: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onMove: (from: number, to: number) => void;
  onSplit: (id: number, dir: Direction) => void;
  onDuplicate: (id: number) => void;
  onDetach?: ((id: number) => void) | undefined;
  onNewLocal: () => void;
  /** Opens a new SFTP tab. */
  onNewSftp?: () => void;
  onOpenPalette: () => void;
  /** Tabs whose long command finished while out of view, with its exit status (P-23). */
  finished?: ReadonlyMap<number, number | null> | undefined;
  /** The layout template the open tabs follow, and whether they changed since it was saved. */
  layout?: { name: string; dirty: boolean; onSave: () => void; onSaveAs: () => void } | null | undefined;
  /** Recently connected hosts, reopened from the new-tab menu (UX-04). */
  recent?: { id: string; label: string; detail: string; onSelect: () => void }[] | undefined;
  /** Panes connected to a production host (P-26); their tabs show a "Production" label. */
  production?: ReadonlyMap<number, string> | undefined;
  /** Changes with the user's shortcuts, so this memoized component re-renders its shortcut labels. */
  shortcuts?: unknown;
}) {
  const [layoutMenu, setLayoutMenu] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ id: number; anchor?: HTMLElement; point?: { x: number; y: number } } | null>(null);
  const [newMenu, setNewMenu] = useState<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number | null; side: "before" | "after" } | null>(null);
  const tabRefs = useRef(new Map<number, HTMLElement>());
  // Reordering can move the focused tab's DOM node, which drops focus; put it back after commit.
  const refocusAfterMove = useRef<number | null>(null);
  useLayoutEffect(() => {
    const id = refocusAfterMove.current;
    if (id === null) return;
    refocusAfterMove.current = null;
    const element = tabRefs.current.get(id);
    if (element && document.activeElement !== element) element.focus();
  });
  const PageIcon = PAGE_ICONS[destination];

  // Tabs slide aside when one opens, closes or moves, and a new one fades in (lib/motion.ts).
  const tabsRef = useRef<HTMLDivElement>(null);
  useFlip(tabsRef);

  // Overflow scrolls sideways only: the wheel scrolls the strip horizontally, the active tab is
  // kept in view, and faded edges show that more tabs are hidden on that side.
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const edges = () => {
      const max = el.scrollWidth - el.clientWidth;
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft < max - 1;
      el.dataset.overflow = max <= 1 ? "none" : start && end ? "both" : start ? "start" : "end";
    };
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    const observer = new ResizeObserver(edges);
    observer.observe(el);
    if (tabsRef.current) observer.observe(tabsRef.current);
    el.addEventListener("scroll", edges, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    edges();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", edges);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);
  useLayoutEffect(() => {
    tabRefs.current.get(ws.active ?? -1)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ws.active, ws.tabs.length]);
  // Width changes animate only when a tab was chosen with the pointer (docs/design/motion.md):
  // switching from the keyboard is instant.
  const markInput = (input: "pointer" | "keyboard") => {
    if (stripRef.current) stripRef.current.dataset.input = input;
  };
  /** A tab closed with the pointer shrinks out first; from the keyboard it closes at once. */
  const closeWithPointer = (id: number) => animateOut(tabRefs.current.get(id), () => onClose(id), "scale(0.94)");

  function focusTab(index: number) {
    const id = index < 0 ? null : ws.tabs[index]?.id;
    const element = id === null || id === undefined ? tabRefs.current.get(-1) : tabRefs.current.get(id);
    element?.focus();
  }

  function onTabKey(event: React.KeyboardEvent, index: number, id: number | null) {
    // Roving focus across the tab list; F2 renames; Delete closes; Ctrl/Cmd+Shift+Arrow moves.
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      if (id !== null && (event.metaKey || event.ctrlKey) && event.shiftKey) {
        event.preventDefault();
        refocusAfterMove.current = id;
        onMove(index, index + delta);
        return;
      }
      event.preventDefault();
      focusTab(Math.max(-1, Math.min(ws.tabs.length - 1, index + delta)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusTab(event.key === "Home" ? -1 : ws.tabs.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(id);
    } else if (id !== null && event.key === "F2") {
      event.preventDefault();
      onRenaming(id);
    } else if (id !== null && event.key === "Delete") {
      event.preventDefault();
      onClose(id);
    } else if (id !== null && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      setMenu({ id, anchor: event.currentTarget as HTMLElement });
    }
  }

  const menuItems = (id: number): MenuEntry[] => {
    const index = ws.tabs.findIndex((t) => t.id === id);
    return [
      { label: msg.nav.renameTab, icon: <IconPencil size={15} />, shortcut: <Shortcut action="renameTab" />, onSelect: () => onRenaming(id) },
      { label: msg.nav.duplicate, icon: <IconCopy size={15} />, onSelect: () => onDuplicate(id) },
      ...(onDetach ? [{ label: msgC.detach.action, icon: <IconAppWindow size={15} />, onSelect: () => onDetach(id) }] : []),
      "separator",
      { label: msg.palette.splitRight, icon: <IconColumns2 size={15} />, shortcut: <Shortcut action="splitRight" />, onSelect: () => onSplit(id, "row") },
      { label: msg.palette.splitDown, icon: <IconRows2 size={15} />, shortcut: <Shortcut action="splitDown" />, onSelect: () => onSplit(id, "column") },
      "separator",
      { label: msg.nav.moveLeft, disabled: index <= 0, onSelect: () => onMove(index, index - 1) },
      { label: msg.nav.moveRight, disabled: index >= ws.tabs.length - 1, onSelect: () => onMove(index, index + 1) },
      "separator",
      { label: msg.nav.closeOthers, disabled: ws.tabs.length < 2, onSelect: () => onCloseOthers(id) },
      { label: msg.common.close, icon: <IconX size={15} />, tone: "danger", shortcut: <Shortcut action="closePane" />, onSelect: () => onClose(id) },
    ];
  };

  return (
    <div className="tabstrip" ref={stripRef} onPointerDownCapture={() => markInput("pointer")} onKeyDownCapture={() => markInput("keyboard")}>
      {/* "+" scrolls with the tabs, right after the last one; it stays pinned at the end only when
          the tabs overflow. */}
      <div className="tabstrip-scroll" ref={scrollRef}>
      {/* Only tabs are inside the tablist (WAI-ARIA); the new-tab and layout buttons sit beside it. */}
      <div className="tabstrip-tabs" role="tablist" aria-label={msg.nav.sessions} ref={tabsRef}>
        <div
          ref={(el) => {
            if (el) tabRefs.current.set(-1, el);
          }}
          role="tab"
          tabIndex={ws.active === null ? 0 : -1}
          className="tab tab-page"
          aria-selected={ws.active === null}
          onClick={() => onSelect(null)}
          onKeyDown={(event) => onTabKey(event, -1, null)}
        >
          <PageIcon size={15} />
          <span className="tab-label">{msg.nav[destination]}</span>
        </div>

        {ws.tabs.map((tab, index) => {
          const pane = ws.panes[tab.focused];
          const title = tabTitle(ws, tab);
          const selected = ws.active === tab.id;
          const paneCount = panesOf(tab.layout).length;
          const status = tabStatus(ws, tab);
          const isProduction = production ? panesOf(tab.layout).some((id) => production.has(id)) : false;
          return (
            <div
              key={tab.id}
              data-flip-key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              className="tab"
              aria-selected={selected}
              draggable={renaming !== tab.id}
              data-dragging={drag?.from === index}
              data-drop={drag && drag.over === index && drag.from !== index ? drag.side : undefined}
              data-status={status.indicator}
              data-production={isProduction || undefined}
              data-unread={status.unread || undefined}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={() => onRenaming(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) closeWithPointer(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ id: tab.id, point: { x: event.clientX, y: event.clientY } });
              }}
              onKeyDown={(event) => onTabKey(event, index, tab.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", "");
                setDrag({ from: index, over: null, side: "before" });
              }}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const side = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                if (drag.over !== index || drag.side !== side) setDrag({ ...drag, over: index, side });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (drag && drag.over !== null) {
                  let to = drag.side === "before" ? drag.over : drag.over + 1;
                  if (drag.from < to) to -= 1;
                  onMove(drag.from, to);
                }
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              <span className="status-dot" data-tone={status.indicator} data-unread={status.unread || undefined} aria-hidden="true" />
              {renaming === tab.id ? (
                <input
                  className="tab-rename"
                  aria-label={msg.nav.renameTab}
                  defaultValue={title}
                  maxLength={80}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      onRename(tab.id, event.currentTarget.value);
                      onRenaming(null);
                      tabRefs.current.get(tab.id)?.focus();
                    } else if (event.key === "Escape") {
                      onRenaming(null);
                      tabRefs.current.get(tab.id)?.focus();
                    }
                  }}
                  onBlur={(event) => {
                    onRename(tab.id, event.currentTarget.value);
                    onRenaming(null);
                  }}
                />
              ) : (
                <span className="tab-label" title={pane ? `${title} — ${pane.identity}` : title}>
                  {title}
                  {pane?.remoteTitle && !tab.customTitle && <span className="tab-title"> · {pane.remoteTitle}</span>}
                  {paneCount > 1 && <span className="tab-title"> ({paneCount})</span>}
                </span>
              )}
              {isProduction && <span className="badge badge-production tab-production">{msgProduction.label}</span>}
              <span className="visually-hidden">{msgC.status.describe(status)}</span>
              {finished?.has(tab.id) && <FinishedBadge exit={finished.get(tab.id) ?? null} />}
              {/* A pointer target only: a focusable control may not sit inside a tab. From the
                  keyboard a tab closes with Delete or from its menu (Shift+F10). */}
              <span
                className="tab-close"
                aria-hidden="true"
                title={msg.nav.closeTab(title)}
                onClick={(event) => {
                  event.stopPropagation();
                  closeWithPointer(tab.id);
                }}
              >
                <IconX size={14} />
              </span>
            </div>
          );
        })}
      </div>

      <IconButton
        className="tab-new"
        size="sm"
        label={msg.nav.newTab}
        // A CSS tooltip would hang below the strip's scroll area (clipped, and scrollable
        // vertically); the native one is drawn outside it.
        data-tooltip={undefined}
        title={msg.nav.newTab}
        aria-haspopup="menu"
        onClick={(event) => setNewMenu(event.currentTarget)}
      >
        <IconPlus size={16} />
      </IconButton>
      </div>
      <span className="tab-spacer" />
      {layout && (
        <button
          type="button"
          className="btn btn-ghost btn-sm tab-layout"
          data-dirty={layout.dirty || undefined}
          aria-haspopup="menu"
          aria-label={`${msgC.layouts.current(layout.name)}${layout.dirty ? ` (${msgC.layouts.unsaved})` : ""}`}
          onClick={(event) => setLayoutMenu(event.currentTarget)}
        >
          <IconLayoutTemplate size={14} />
          <span className="truncate">{layout.name}</span>
          {layout.dirty && <span className="tab-layout-dirty" aria-hidden="true" title={msgC.layouts.unsaved} />}
        </button>
      )}
      {layout && layoutMenu && (
        <Menu
          label={msgC.layouts.menu(layout.name)}
          anchor={layoutMenu}
          items={[
            { label: msgC.layouts.saveNamed(layout.name), icon: <IconSave size={15} />, disabled: !layout.dirty, onSelect: layout.onSave },
            { label: msgC.layouts.saveAs, icon: <IconSave size={15} />, onSelect: layout.onSaveAs },
          ]}
          onClose={() => setLayoutMenu(null)}
        />
      )}

      {menu && (
        <Menu
          label={msg.nav.tabMenu(tabTitle(ws, ws.tabs.find((t) => t.id === menu.id) ?? ws.tabs[0]!))}
          anchor={menu.anchor ?? null}
          point={menu.point}
          items={menuItems(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
      {newMenu && (
        <Menu
          label={msg.nav.newTab}
          anchor={newMenu}
          items={[
            { label: msg.nav.localTerminal, icon: <IconPlus size={15} />, shortcut: <Shortcut action="newLocal" />, onSelect: onNewLocal },
            ...(onNewSftp ? [{ label: msgSftp.open, icon: <IconArrowLeftRight size={15} />, onSelect: onNewSftp }] : []),
            { label: msg.palette.groupHosts, icon: <IconServer size={15} />, shortcut: <Shortcut action="palette" />, onSelect: onOpenPalette },
            ...((recent ?? []).length > 0 ? (["separator"] as MenuEntry[]) : []),
            ...(recent ?? []).slice(0, 5).map((r) => ({ label: r.label, icon: <IconHistory size={15} />, onSelect: r.onSelect })),
          ]}
          onClose={() => setNewMenu(null)}
        />
      )}
    </div>
  );
}

/** Memoized: re-renders only when its own props change, not for every state change of the shell. */
export const TabStrip = memo(TabStripImpl);

/** A finished command in a background tab (P-23): a check or a cross, with text, not color alone. */
function FinishedBadge({ exit }: { exit: number | null }) {
  const failed = exit !== null && exit !== 0;
  return (
    <span className="tab-finished" data-failed={failed || undefined}>
      <span aria-hidden="true">{failed ? "✕" : "✓"}</span>
      <span className="visually-hidden"> ({failed ? msgN.badgeFailed(exit) : msgN.badgeOk})</span>
    </span>
  );
}

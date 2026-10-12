import type { TerminalPreferences, WorkspacePreferences } from "@tyrminal/contracts";
import { type ReactNode, useRef, useState } from "react";

import { type Direction, type Pane, type Tab, type Workspace, activeTab, panesOf, paneRects } from "../../app/workspace";
import { type PaneHandle, type PaneStatus, TerminalView } from "../../features/terminal/TerminalView";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-input";
import { msgC } from "../../lib/messages-c";
import { IconButton } from "../ui/controls";
import { IconArrowUpRight, IconColumns2, IconGripVertical, IconMaximize2, IconMinimize2, IconRows2, IconX } from "../ui/icons";

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

/**
 * Every pane of every tab, rendered flat in one container and positioned from its tab's layout
 * tree, so splitting, closing, resizing, rearranging or moving a pane to another tab never
 * remounts a terminal (its session survives). Panes of background tabs stay mounted but hidden.
 */
export function PaneGrid({
  ws,
  prefs,
  workspace,
  panel,
  onPatch,
  onStatus,
  onFocus,
  onSelectPane,
  onUnread,
  onClose,
  onSplit,
  onRatio,
  onSwap,
  onFocusMode,
  onToNewTab,
  onConnect,
  canOpen = true,
  onOpenKnownHosts,
  register,
  broadcasting,
  broadcastPaneIds,
  onUserInput,
}: {
  ws: Workspace;
  prefs: TerminalPreferences;
  workspace?: WorkspacePreferences | undefined;
  panel: ReactNode;
  onPatch: (pane: number, patch: Partial<Pick<Pane, "remoteTitle" | "indicator">>) => void;
  onStatus: (pane: number, status: PaneStatus) => void;
  onFocus: (pane: number) => void;
  /** Brings a pane to the front explicitly (the focus layout's pane list). */
  onSelectPane: (pane: number) => void;
  onUnread: (pane: number) => void;
  onClose: (pane: number) => void;
  onSplit: (pane: number, dir: Direction) => void;
  onRatio: (tab: number, path: ("a" | "b")[], ratio: number) => void;
  onSwap: (a: number, b: number) => void;
  onFocusMode: (tab: number, on: boolean) => void;
  onToNewTab: (pane: number) => void;
  /** Explicit Connect for restored panes that are waiting. */
  onConnect: (panes: number[]) => void;
  /** False in a detached window, which cannot open sessions: no split, no reconnect. */
  canOpen?: boolean;
  onOpenKnownHosts: () => void;
  register: (pane: number, handle: PaneHandle | null) => void;
  /** Tabs whose typed input goes to every pane (an explicit, unsaved mode). */
  broadcasting: ReadonlySet<number>;
  /** Panes confirmed to receive broadcast input (P-13); others in a broadcasting tab were left out. */
  broadcastPaneIds?: ReadonlySet<number> | undefined;
  onUserInput: (tab: number, pane: number, bytes: Uint8Array) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragPane, setDragPane] = useState<{ from: number; over: number | null } | null>(null);
  const front = activeTab(ws);
  const frontIds = front ? panesOf(front.layout) : [];
  const frontSplit = frontIds.length > 1;
  const focusLayout = front !== null && front.focusMode && frontSplit;
  const frontGeometry = front ? paneRects(front.layout) : null;

  // Tab of each pane, and every pane in a stable order (by id) so moving one never reorders DOM nodes.
  const tabOf = new Map<number, Tab>();
  for (const tab of ws.tabs) for (const id of panesOf(tab.layout)) tabOf.set(id, tab);
  const all = [...tabOf.keys()].sort((a, b) => a - b);

  return (
    <div className="workspace" hidden={front === null} role="tabpanel" aria-label={msg.terminal.pane} data-focus-layout={focusLayout || undefined}>
      <div ref={ref} className="panes" data-split={frontSplit && !focusLayout}>
        {all.map((id) => {
          const pane = ws.panes[id];
          const tab = tabOf.get(id) as Tab;
          if (!pane) return null;
          const inFront = tab.id === front?.id;
          const focused = tab.focused === id;
          const visible = inFront && (!focusLayout || focused);
          const rect = focusLayout ? { x: 0, y: 0, w: 1, h: 1 } : inFront ? frontGeometry?.panes.get(id) : undefined;
          const isSplit = inFront ? frontSplit : panesOf(tab.layout).length > 1;
          const style = rect ? { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) } : { inset: 0 };
          return (
            <section
              key={id}
              className="pane"
              hidden={!visible}
              data-pane-id={id}
              data-focused={focused}
              data-broadcast={broadcasting.has(tab.id) ? (broadcastPaneIds && !broadcastPaneIds.has(id) ? "excluded" : true) : undefined}
              data-drop={dragPane && dragPane.over === id && dragPane.from !== id ? "swap" : undefined}
              aria-label={pane.label}
              style={style}
              onDragOver={(event) => {
                if (!dragPane || !inFront) return;
                event.preventDefault();
                if (dragPane.over !== id) setDragPane({ ...dragPane, over: id });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragPane && dragPane.from !== id) onSwap(dragPane.from, id);
                setDragPane(null);
              }}
            >
              {isSplit && (
                <div className="pane-header">
                  <span
                    className="pane-grip"
                    draggable={!focusLayout}
                    aria-hidden="true"
                    title={msgC.panes.dragToSwap}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", "");
                      setDragPane({ from: id, over: null });
                    }}
                    onDragEnd={() => setDragPane(null)}
                  >
                    <IconGripVertical size={12} />
                  </span>
                  <span className="status-dot" data-tone={pane.indicator} aria-hidden="true" />
                  <span className="truncate" style={{ flex: 1 }}>
                    {pane.label}
                    <span style={{ opacity: 0.7 }}> · {pane.identity}</span>
                  </span>
                  {broadcasting.has(tab.id) && broadcastPaneIds && !broadcastPaneIds.has(id) && <span className="faint">{msgI.broadcast.excluded}</span>}
                  {canOpen && (
                    <IconButton size="sm" label={msgC.panes.toNewTab} onClick={() => onToNewTab(id)}>
                      <IconArrowUpRight size={13} />
                    </IconButton>
                  )}
                  <IconButton
                    size="sm"
                    label={focusLayout ? msgC.panes.leaveFocus : msgC.panes.focusLayout}
                    aria-pressed={focusLayout}
                    onClick={() => onFocusMode(tab.id, !focusLayout)}
                  >
                    {focusLayout ? <IconMinimize2 size={13} /> : <IconMaximize2 size={13} />}
                  </IconButton>
                  {canOpen && (
                    <>
                      <IconButton size="sm" label={msg.palette.splitRight} onClick={() => onSplit(id, "row")}>
                        <IconColumns2 size={13} />
                      </IconButton>
                      <IconButton size="sm" label={msg.palette.splitDown} onClick={() => onSplit(id, "column")}>
                        <IconRows2 size={13} />
                      </IconButton>
                    </>
                  )}
                  <IconButton size="sm" label={msg.palette.closePane} onClick={() => onClose(id)}>
                    <IconX size={13} />
                  </IconButton>
                </div>
              )}
              <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
                <TerminalView
                  paneId={id}
                  target={pane.target}
                  identity={pane.identity}
                  label={pane.label}
                  visible={visible}
                  focused={focused}
                  prefs={prefs}
                  workspace={workspace}
                  onIndicator={(indicator) => onPatch(id, { indicator })}
                  onTitle={(remoteTitle) => onPatch(id, { remoteTitle })}
                  onStatus={(status) => onStatus(id, status)}
                  onFocus={() => onFocus(id)}
                  onUnread={() => onUnread(id)}
                  onClose={() => onClose(id)}
                  onOpenKnownHosts={onOpenKnownHosts}
                  register={(handle) => register(id, handle)}
                  onUserInput={(bytes) => onUserInput(tab.id, id, bytes)}
                  pending={pane.pending}
                  attachToken={pane.attachToken}
                  canReconnect={canOpen}
                  onConnect={() => onConnect([id])}
                  onConnectAll={
                    panesOf(tab.layout).filter((p) => ws.panes[p]?.pending).length > 1 ? () => onConnect(panesOf(tab.layout)) : undefined
                  }
                />
              </div>
            </section>
          );
        })}
        {front && !focusLayout && frontGeometry && (
          <Splitters
            tabId={front.id}
            container={ref}
            splitters={frontGeometry.splitters}
            dragging={dragging}
            onDragging={setDragging}
            onRatio={onRatio}
          />
        )}
      </div>
      {focusLayout && front && (
        <nav className="focus-list" aria-label={msgC.panes.list}>
          <div className="focus-list-head">
            <span className="eyebrow">{msgC.panes.listTitle(frontIds.length)}</span>
            <IconButton size="sm" label={msgC.panes.leaveFocus} onClick={() => onFocusMode(front.id, false)}>
              <IconMinimize2 size={14} />
            </IconButton>
          </div>
          <ul>
            {frontIds.map((id) => {
              const pane = ws.panes[id];
              if (!pane) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="focus-item"
                    aria-current={front.focused === id ? "true" : undefined}
                    onClick={() => onSelectPane(id)}
                  >
                    <span className="status-dot" data-tone={pane.indicator} data-unread={pane.unread || undefined} aria-hidden="true" />
                    <span className="row-main">
                      <span className="truncate">{pane.label}</span>
                      <span className="truncate faint mono">{pane.identity}</span>
                    </span>
                    <span className="visually-hidden">{msgC.status.describe(pane)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {panel}
    </div>
  );
}

function Splitters({
  tabId,
  container,
  splitters,
  dragging,
  onDragging,
  onRatio,
}: {
  tabId: number;
  container: React.RefObject<HTMLDivElement | null>;
  splitters: ReturnType<typeof paneRects>["splitters"];
  dragging: string | null;
  onDragging: (key: string | null) => void;
  onRatio: (tab: number, path: ("a" | "b")[], ratio: number) => void;
}) {
  return (
    <>
      {splitters.map((s) => {
        const key = s.path.join("") || "root";
        const style =
          s.dir === "row"
            ? { left: pct(s.line.x), top: pct(s.line.y), height: pct(s.line.h) }
            : { left: pct(s.line.x), top: pct(s.line.y), width: pct(s.line.w) };
        return (
          <div
            key={`${tabId}-${key}`}
            className="splitter"
            role="separator"
            tabIndex={0}
            aria-orientation={s.dir === "row" ? "vertical" : "horizontal"}
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(s.ratio * 100)}
            aria-label={s.dir === "row" ? msg.palette.splitRight : msg.palette.splitDown}
            data-dir={s.dir}
            data-active={dragging === key}
            style={style}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.03;
              const grow = s.dir === "row" ? event.key === "ArrowRight" : event.key === "ArrowDown";
              const shrink = s.dir === "row" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
              if (grow || shrink) {
                event.preventDefault();
                onRatio(tabId, s.path, s.ratio + (grow ? step : -step));
              }
            }}
            onPointerDown={(event) => {
              const box = container.current?.getBoundingClientRect();
              if (!box) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              onDragging(key);
              const move = (e: PointerEvent) => {
                const fraction =
                  s.dir === "row"
                    ? ((e.clientX - box.left) / box.width - s.area.x) / s.area.w
                    : ((e.clientY - box.top) / box.height - s.area.y) / s.area.h;
                onRatio(tabId, s.path, fraction);
              };
              const up = () => {
                onDragging(null);
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
        );
      })}
    </>
  );
}

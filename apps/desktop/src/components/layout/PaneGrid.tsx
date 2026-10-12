import type { TerminalPreferences } from "@tyrminal/contracts";
import { type ReactNode, useRef, useState } from "react";

import { type Direction, type Pane, type Workspace, panesOf, paneRects } from "../../app/workspace";
import { type PaneHandle, type PaneStatus, TerminalView } from "../../features/terminal/TerminalView";
import { msg } from "../../lib/messages";
import { IconButton } from "../ui/controls";
import { IconColumns2, IconRows2, IconX } from "../ui/icons";

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

/**
 * Every pane of every tab, rendered flat and positioned from the layout tree, so splitting,
 * closing or resizing never remounts a terminal. Inactive tabs stay mounted but hidden.
 */
export function PaneGrid({
  ws,
  prefs,
  panel,
  onPatch,
  onStatus,
  onFocus,
  onUnread,
  onClose,
  onSplit,
  onRatio,
  onOpenKnownHosts,
  register,
  broadcasting,
  onUserInput,
}: {
  ws: Workspace;
  prefs: TerminalPreferences;
  panel: ReactNode;
  onPatch: (pane: number, patch: Partial<Pick<Pane, "remoteTitle" | "indicator">>) => void;
  onStatus: (pane: number, status: PaneStatus) => void;
  onFocus: (pane: number) => void;
  onUnread: (pane: number) => void;
  onClose: (pane: number) => void;
  onSplit: (pane: number, dir: Direction) => void;
  onRatio: (tab: number, path: ("a" | "b")[], ratio: number) => void;
  onOpenKnownHosts: () => void;
  register: (pane: number, handle: PaneHandle | null) => void;
  /** Tabs whose typed input goes to every pane (an explicit, unsaved mode). */
  broadcasting: ReadonlySet<number>;
  onUserInput: (tab: number, pane: number, bytes: Uint8Array) => void;
}) {
  return (
    <>
      {ws.tabs.map((tab) => {
        const visible = ws.active === tab.id;
        const { panes, splitters } = paneRects(tab.layout);
        const ids = panesOf(tab.layout);
        const isSplit = ids.length > 1;
        return (
          <div key={tab.id} className="workspace" hidden={!visible} role="tabpanel" aria-label={msg.terminal.pane}>
            <TabPanes tabId={tab.id} isSplit={isSplit} splitters={splitters} onRatio={onRatio}>
              {ids.map((id) => {
                const pane = ws.panes[id];
                const rect = panes.get(id);
                if (!pane || !rect) return null;
                const focused = tab.focused === id;
                return (
                  <section
                    key={id}
                    className="pane"
                    data-focused={focused}
                    data-broadcast={broadcasting.has(tab.id) || undefined}
                    aria-label={pane.label}
                    style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                  >
                    {isSplit && (
                      <div className="pane-header">
                        <span className="status-dot" data-tone={pane.indicator} aria-hidden="true" />
                        <span className="truncate" style={{ flex: 1 }}>
                          {pane.label}
                          <span style={{ opacity: 0.7 }}> · {pane.identity}</span>
                        </span>
                        <IconButton size="sm" label={msg.palette.splitRight} onClick={() => onSplit(id, "row")}>
                          <IconColumns2 size={13} />
                        </IconButton>
                        <IconButton size="sm" label={msg.palette.splitDown} onClick={() => onSplit(id, "column")}>
                          <IconRows2 size={13} />
                        </IconButton>
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
                        onIndicator={(indicator) => onPatch(id, { indicator })}
                        onTitle={(remoteTitle) => onPatch(id, { remoteTitle })}
                        onStatus={(status) => onStatus(id, status)}
                        onFocus={() => onFocus(id)}
                        onUnread={() => onUnread(id)}
                        onClose={() => onClose(id)}
                        onOpenKnownHosts={onOpenKnownHosts}
                        register={(handle) => register(id, handle)}
                        onUserInput={(bytes) => onUserInput(tab.id, id, bytes)}
                      />
                    </div>
                  </section>
                );
              })}
            </TabPanes>
            {visible && panel}
          </div>
        );
      })}
    </>
  );
}

function TabPanes({
  tabId,
  isSplit,
  splitters,
  onRatio,
  children,
}: {
  tabId: number;
  isSplit: boolean;
  splitters: ReturnType<typeof paneRects>["splitters"];
  onRatio: (tab: number, path: ("a" | "b")[], ratio: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <div ref={ref} className="panes" data-split={isSplit}>
      {children}
      {splitters.map((s) => {
        const key = s.path.join("") || "root";
        const style =
          s.dir === "row"
            ? { left: pct(s.line.x), top: pct(s.line.y), height: pct(s.line.h) }
            : { left: pct(s.line.x), top: pct(s.line.y), width: pct(s.line.w) };
        return (
          <div
            key={key}
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
              const container = ref.current;
              if (!container) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(key);
              const box = container.getBoundingClientRect();
              const move = (e: PointerEvent) => {
                const fraction =
                  s.dir === "row"
                    ? ((e.clientX - box.left) / box.width - s.area.x) / s.area.w
                    : ((e.clientY - box.top) / box.height - s.area.y) / s.area.h;
                onRatio(tabId, s.path, fraction);
              };
              const up = () => {
                setDragging(null);
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
        );
      })}
    </div>
  );
}

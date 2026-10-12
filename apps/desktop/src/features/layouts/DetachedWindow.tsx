// A tab moved out of the main window (TRM-02). This window holds only the sessions handed to it:
// its capability (capabilities/detached.json) lets it take over and use them, read preferences
// and report activity, and nothing else. It cannot open sessions, so there is no split, new tab
// or reconnect here; those stay in the main window.

import type { DetachedTab } from "@tyrminal/contracts";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";

import { PreferencesProvider, usePreferences } from "../../app/preferences";
import {
  type Workspace,
  activePane,
  activeTab,
  closePane,
  detachedWorkspace,
  focusPane,
  focusPaneInActiveTab,
  markUnread,
  neighbour,
  patchPane,
  setFocusMode,
  setRatio,
  swapPanes,
  tabTitle,
} from "../../app/workspace";
import { ToastProvider } from "../../components/ui/Toasts";
import { Notice } from "../../components/ui/controls";
import { detach, vault } from "../../lib/ipc";
import { msgC } from "../../lib/messages-c";
import { actionFor, applyBindingOverrides } from "../../lib/shortcuts";
import type { PaneHandle, PaneStatus } from "../terminal/TerminalView";
import { workspacePrefs } from "./WorkspaceSettings";

const PaneGrid = lazy(() => import("../../components/layout/PaneGrid").then((m) => ({ default: m.PaneGrid })));

/** True in a window opened by "Move tab to a new window". */
export function isDetachedWindow(): boolean {
  const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return meta?.metadata?.currentWindow?.label?.startsWith("detached-") === true;
}

// The tab is handed over once; a second mount (development StrictMode) must not ask again.
let taking: Promise<DetachedTab> | null = null;

export function DetachedApp() {
  return (
    <PreferencesProvider>
      <ToastProvider>
        <DetachedShell />
      </ToastProvider>
    </PreferencesProvider>
  );
}

function DetachedShell() {
  const { prefs } = usePreferences();
  applyBindingOverrides(workspacePrefs(prefs.workspace).bindings);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [failed, setFailed] = useState(false);
  const [, setStatuses] = useState<Record<number, PaneStatus>>({});
  const handles = useRef(new Map<number, PaneHandle>());
  const wsRef = useRef(ws);
  wsRef.current = ws;

  useEffect(() => {
    taking ??= detach.take();
    taking.then(
      (tab) => {
        setWs(detachedWorkspace(tab));
        document.title = `${tab.title ?? tab.panes[tab.focused]?.label ?? ""} — Tyrminal`;
      },
      () => setFailed(true),
    );
  }, []);

  // Typing here postpones the vault's idle lock, as in the main window.
  useEffect(() => {
    let last = 0;
    const report = () => {
      if (Date.now() - last < 5_000) return;
      last = Date.now();
      void vault.noteActivity().catch(() => undefined);
    };
    window.addEventListener("keydown", report, { capture: true, passive: true });
    window.addEventListener("pointerdown", report, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", report, { capture: true });
      window.removeEventListener("pointerdown", report, { capture: true });
    };
  }, []);

  const update = useCallback((change: (w: Workspace) => Workspace) => setWs((w) => (w ? change(w) : w)), []);
  const focused = () => {
    const w = wsRef.current;
    const p = w ? activePane(w) : null;
    return p ? (handles.current.get(p.id) ?? null) : null;
  };

  // The terminal-only shortcuts that make sense here.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      const action = actionFor(event);
      const towards = { focusLeft: "left", focusRight: "right", focusUp: "up", focusDown: "down" } as const;
      if (!action) return;
      const w = wsRef.current;
      const t = w ? activeTab(w) : null;
      if (action === "find") focused()?.openFind();
      else if (action === "zoomIn") focused()?.zoom("in");
      else if (action === "zoomOut") focused()?.zoom("out");
      else if (action === "zoomReset") focused()?.zoom("reset");
      else if (action === "closePane" && t) update((x) => closePane(x, t.focused));
      else if (action === "toggleFocusLayout" && t) update((x) => setFocusMode(x, t.id, !t.focusMode));
      else if (action in towards && t) {
        const next = neighbour(t.layout, t.focused, towards[action as keyof typeof towards]);
        if (next !== null) update((x) => focusPane(x, next));
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [update]);

  const tab = ws ? activeTab(ws) : null;
  return (
    <div className="detached-shell">
      <header className="detached-head">
        <span className="truncate">{ws && tab ? tabTitle(ws, tab) : ""}</span>
      </header>
      <main className="content" aria-label={ws && tab ? tabTitle(ws, tab) : msgC.detach.loading}>
        {failed && (
          <div className="detached-note">
            <Notice tone="warning">{msgC.detach.gone}</Notice>
          </div>
        )}
        {!failed && !ws && <div className="detached-note muted">{msgC.detach.loading}</div>}
        {ws && ws.tabs.length === 0 && (
          <div className="detached-note">
            <Notice tone="info">{msgC.detach.ended}</Notice>
          </div>
        )}
        {ws && ws.tabs.length > 0 && (
          <Suspense fallback={null}>
            <PaneGrid
              ws={ws}
              prefs={prefs.terminal}
              workspace={workspacePrefs(prefs.workspace)}
              panel={null}
              canOpen={false}
              onPatch={(id, patch) => update((w) => patchPane(w, id, patch))}
              onStatus={(id, status) => setStatuses((s) => ({ ...s, [id]: status }))}
              onFocus={(id) => update((w) => focusPaneInActiveTab(w, id))}
              onSelectPane={(id) => update((w) => focusPane(w, id))}
              onUnread={(id) => update((w) => markUnread(w, id))}
              onClose={(id) => update((w) => closePane(w, id))}
              onSplit={() => undefined}
              onRatio={(tabId, path, ratio) => update((w) => setRatio(w, tabId, path, ratio))}
              onSwap={(a, b) => update((w) => swapPanes(w, a, b))}
              onFocusMode={(tabId, on) => update((w) => setFocusMode(w, tabId, on))}
              onToNewTab={() => undefined}
              onConnect={() => undefined}
              onOpenKnownHosts={() => undefined}
              register={(id, handle) => {
                if (handle) handles.current.set(id, handle);
                else handles.current.delete(id);
              }}
              broadcasting={new Set()}
              onUserInput={() => undefined}
            />
          </Suspense>
        )}
      </main>
    </div>
  );
}

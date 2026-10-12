import type { HostSummary, SnippetSummary } from "@tyrminal/contracts";
import { Suspense, lazy, useCallback, useEffect, useRef, useState, useMemo } from "react";

import { Sidebar } from "../components/layout/Sidebar";
import { StatusBar } from "../components/layout/StatusBar";
import { TabStrip } from "../components/layout/TabStrip";
import { useToast } from "../components/ui/Toasts";
import { KeychainView } from "../features/credentials/KeychainView";
import { HomeView } from "../features/home/HomeView";
import { HostsView } from "../features/hosts/HostsView";
import { DeployKeyDialog } from "../features/credentials/DeployKeyDialog";
import { CommandPalette } from "../features/palette/CommandPalette";
import { KnownHostsView, SettingsView } from "../features/settings/SettingsViews";
import { SnippetRunDialog, type SnippetRunRequest } from "../features/snippets/SnippetRunDialog";
import { FilesPanel, panelMemory } from "../features/files/FilesPanel";
import { SnippetsPanel } from "../features/snippets/SnippetsPanel";
import { SnippetsView } from "../features/snippets/SnippetsView";
// agent B: tunnels and history
import { TunnelsView } from "../features/tunnels/TunnelsView";
import { SnippetRunContext } from "../features/snippets/runContext";
import { IntegrationDialog } from "../features/autocomplete/IntegrationDialog";
import { SuggestDialog } from "../features/autocomplete/SuggestDialog";
import { insertionBytes } from "../features/autocomplete/suggest";
import type { TerminalTarget } from "../features/terminal/TerminalController";
import type { PaneHandle, PaneStatus } from "../features/terminal/TerminalView";
import { sessions as sessionsApi, snippets as snippetsApi, vault } from "../lib/ipc";
import { msgD } from "../lib/messages-d";
import { msg } from "../lib/messages";
import { actionFor, tabIndexFor } from "../lib/shortcuts";
import { usePreferences } from "./preferences";
import { VaultDataProvider, useVaultData } from "./vaultData";
import {
  type Direction,
  type Workspace,
  activePane,
  activeTab,
  closeOtherTabs,
  closePane,
  closeTab,
  cycleTab,
  emptyWorkspace,
  focusPane,
  focusPaneInActiveTab,
  moveTab,
  neighbour,
  openTab,
  panesOf,
  patchPane,
  renameTab,
  selectTab,
  setRatio,
  splitPane,
  tabTitle,
} from "./workspace";

export type Destination =
  | "home"
  | "hosts"
  | "snippets"
  | "keychain"
  | "knownHosts"
  | "settings"
  // agent B: tunnels and history
  | "tunnels";

// The terminal emulator is the largest module and is not needed until a session opens.
const PaneGrid = lazy(() => import("../components/layout/PaneGrid").then((m) => ({ default: m.PaneGrid })));

export function AppShell() {
  return (
    <VaultDataProvider>
      <Shell />
    </VaultDataProvider>
  );
}

function hostIdentity(host: HostSummary): string {
  return msg.hosts.destination(host.username, host.address, host.port);
}

function Shell() {
  const { prefs, resolvedTheme, update } = usePreferences();
  const data = useVaultData();
  const notify = useToast();
  const [destination, setDestination] = useState<Destination>("home");
  const [ws, setWs] = useState<Workspace>(emptyWorkspace);
  const [collapsed, setCollapsed] = useState(false);
  // The side panel beside the terminals: snippets or files, one at a time.
  const [sidePanel, setSidePanel] = useState<"snippets" | "files" | null>(null);
  const panelOpen = sidePanel === "snippets";
  const togglePanel = useCallback((which: "snippets" | "files") => setSidePanel((v) => (v === which ? null : which)), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<number, PaneStatus>>({});
  const [deploying, setDeploying] = useState<{ sessionId: string; hostId: string } | null>(null);
  // Tabs in broadcast mode. Kept in memory only: never saved, and switched off as soon as any
  // pane of the tab stops being connected (a reconnect never resumes broadcasting silently).
  const [broadcasting, setBroadcasting] = useState<ReadonlySet<number>>(new Set());
  const [runRequest, setRunRequest] = useState<SnippetRunRequest | null>(null);
  // agent D: suggestions for the focused SSH pane.
  const [suggesting, setSuggesting] = useState<{ paneId: number; sessionId: string; hostId: string | null } | null>(null);
  const [integrating, setIntegrating] = useState<{ kind: "ssh"; sessionId: string } | { kind: "local" } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const handles = useRef(new Map<number, PaneHandle>());
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const tab = activeTab(ws);
  const pane = activePane(ws);
  const paneStatus = pane ? statuses[pane.id] : undefined;

  /** Panes of a tab that can take part in broadcast: connected, and able to tell user input apart. */
  const broadcastPanes = useCallback(
    (tabId: number) => {
      const t = wsRef.current.tabs.find((x) => x.id === tabId);
      if (!t) return [];
      return panesOf(t.layout).filter((id) => {
        const h = handles.current.get(id);
        return statuses[id]?.state === "connected" && h?.broadcastable() === true;
      });
    },
    [statuses],
  );
  const tabCanBroadcast = tab ? panesOf(tab.layout).length > 1 && broadcastPanes(tab.id).length === panesOf(tab.layout).length : false;

  useEffect(() => {
    // Off when a broadcasting tab is gone, has one pane, or any pane is not connected.
    setBroadcasting((current) => {
      let next: Set<number> | null = null;
      for (const id of current) {
        const t = ws.tabs.find((x) => x.id === id);
        const panes = t ? panesOf(t.layout) : [];
        if (!t || panes.length < 2 || panes.some((p) => statuses[p]?.state !== "connected")) {
          next ??= new Set(current);
          next.delete(id);
        }
      }
      return next ?? current;
    });
  }, [ws, statuses]);

  // The files panel remembers each session's folder while that session lives.
  useEffect(() => {
    const live = new Set<string>();
    for (const p of Object.values(ws.panes)) {
      const id = handles.current.get(p.id)?.sessionId();
      if (id) live.add(id);
    }
    panelMemory.retain(live);
  }, [ws, statuses]);

  const relayInput = useCallback(
    (tabId: number, from: number, bytes: Uint8Array) => {
      if (!broadcasting.has(tabId)) return;
      for (const id of broadcastPanes(tabId)) {
        if (id !== from) handles.current.get(id)?.receiveBroadcast(bytes);
      }
    },
    [broadcasting, broadcastPanes],
  );

  const navigate = useCallback((next: Destination) => {
    setDestination(next);
    setWs((current) => selectTab(current, null));
  }, []);

  const open = useCallback((target: TerminalTarget, label: string, identity: string) => {
    setWs((current) => openTab(current, { target, label, identity }));
  }, []);

  const connect = useCallback(
    (host: HostSummary) => {
      open({ kind: "ssh", hostId: host.id }, host.label, hostIdentity(host));
      // The recent list updates once the session reaches its shell.
      window.setTimeout(() => void data.recent.reload(), 3_000);
    },
    [open, data.recent],
  );

  const openLocal = useCallback(() => open({ kind: "local" }, msg.nav.localTerminal, msg.terminal.local), [open]);

  const focusedHandle = useCallback(() => {
    const p = activePane(wsRef.current);
    return p ? (handles.current.get(p.id) ?? null) : null;
  }, []);

  const split = useCallback((dir: Direction) => {
    const p = activePane(wsRef.current);
    if (p) setWs((current) => splitPane(current, p.id, dir));
  }, []);

  const closeFocused = useCallback(() => {
    const p = activePane(wsRef.current);
    if (p) setWs((current) => closePane(current, p.id));
  }, []);

  const moveFocus = useCallback((towards: "left" | "right" | "up" | "down") => {
    const t = activeTab(wsRef.current);
    if (!t) return;
    const next = neighbour(t.layout, t.focused, towards);
    if (next !== null) setWs((current) => focusPane(current, next));
  }, []);

  /** Snippets act on the pane the user is looking at, never on a background one. */
  const requestSnippet = useCallback(
    (snippet: SnippetSummary, mode: "paste" | "run") => {
      const p = activePane(wsRef.current);
      const handle = p ? handles.current.get(p.id) : undefined;
      const sessionId = handle?.sessionId();
      if (!p || !handle || !sessionId || !handle.connected()) return;
      const request: SnippetRunRequest = { snippet, mode, paneId: p.id, sessionId, targetLabel: p.label, targetIdentity: p.identity };
      const lines = snippet.text.replace(/\n$/, "").split("\n").length;
      if (lines > 1) {
        setRunRequest(request);
      } else {
        void sendSnippet(request);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function sendSnippet(request: SnippetRunRequest) {
    const handle = handles.current.get(request.paneId);
    // The target must still be the same live session the preview showed.
    if (!handle || handle.sessionId() !== request.sessionId) return;
    try {
      await snippetsApi.send(request.snippet.id, request.sessionId, request.mode, handle.bracketedPaste());
      notify("success", msg.snippets.sent(request.snippet.name, request.targetLabel));
      handle.focus();
    } catch (error) {
      notify("danger", (error as Error).message);
    }
  }

  const runAction = useCallback(
    (action: ReturnType<typeof actionFor>) => {
      switch (action) {
        case "palette":
          setPaletteOpen(true);
          break;
        case "newLocal":
          openLocal();
          break;
        case "closePane":
          closeFocused();
          break;
        case "splitRight":
          split("row");
          break;
        case "splitDown":
          split("column");
          break;
        case "find":
          focusedHandle()?.openFind();
          break;
        case "zoomIn":
          focusedHandle()?.zoom("in");
          break;
        case "zoomOut":
          focusedHandle()?.zoom("out");
          break;
        case "zoomReset":
          focusedHandle()?.zoom("reset");
          break;
        case "nextTab":
          setWs((current) => cycleTab(current, 1));
          break;
        case "prevTab":
          setWs((current) => cycleTab(current, -1));
          break;
        case "focusLeft":
          moveFocus("left");
          break;
        case "focusRight":
          moveFocus("right");
          break;
        case "focusUp":
          moveFocus("up");
          break;
        case "focusDown":
          moveFocus("down");
          break;
        case "toggleSnippets":
          togglePanel("snippets");
          break;
        case "toggleFiles":
          togglePanel("files");
          break;
        case "toggleSidebar":
          setCollapsed((v) => !v);
          break;
        case "settings":
          navigate("settings");
          break;
        case "lock":
          void vault.lock().catch(() => undefined);
          break;
        // agent D: inventory and snippets
        case "suggest": {
          const p = activePane(wsRef.current);
          const handle = p ? handles.current.get(p.id) : undefined;
          const sessionId = handle?.connected() ? handle.sessionId() : null;
          if (p && sessionId && p.target.kind === "ssh") setSuggesting({ paneId: p.id, sessionId, hostId: p.target.hostId });
          else notify("info", msgD.suggest.needsTerminal);
          break;
        }
        case "renameTab": {
          const t = activeTab(wsRef.current);
          if (t) setRenaming(t.id);
          break;
        }
        default:
          break;
      }
    },
    [openLocal, closeFocused, split, focusedHandle, moveFocus, navigate],
  );

  // Application shortcuts. Capture phase, so they win over the terminal; plain Ctrl+letter keys
  // are not bound on Windows/Linux and reach the shell unchanged.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      const inDialog = document.querySelector("dialog[open]") !== null;
      const index = tabIndexFor(event);
      if (index !== null && !inDialog) {
        event.preventDefault();
        const target = wsRef.current.tabs[index];
        if (target) setWs((current) => selectTab(current, target.id));
        return;
      }
      let action = actionFor(event);
      // Outside a terminal, Ctrl+K also opens the palette (inside one it means "kill line").
      const inTerminal = (event.target as HTMLElement | null)?.closest?.(".xterm") != null;
      if (!action && !inTerminal && event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "KeyK") action = "palette";
      if (!action || (inDialog && action !== "palette")) return;
      event.preventDefault();
      event.stopPropagation();
      runAction(action);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [runAction]);

  const terminalVisible = tab !== null;
  const showPanel = sidePanel !== null && terminalVisible;
  const filesSession =
    pane?.target.kind === "ssh" && paneStatus?.state === "connected" ? (focusedHandle()?.sessionId() ?? null) : null;

  // agent D: inventory and snippets
  const snippetRunHost = useMemo(
    () => ({
      sessions: () =>
        wsRef.current.tabs.flatMap((tab) =>
          panesOf(tab.layout).flatMap((id) => {
            const pane = wsRef.current.panes[id];
            const handle = handles.current.get(id);
            const sessionId = handle?.connected() ? handle.sessionId() : null;
            return pane?.target.kind === "ssh" && sessionId ? [{ hostId: pane.target.hostId, sessionId }] : [];
          }),
        ),
      connect,
    }),
    [connect],
  );

  return (
    // agent D: snippet runs on several sessions read this window's open SSH sessions.
    <SnippetRunContext.Provider value={snippetRunHost}>
    <div className="shell" data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <Sidebar
        destination={terminalVisible ? null : destination}
        collapsed={collapsed}
        ws={ws}
        onNavigate={navigate}
        onSelectTab={(id) => setWs((current) => selectTab(current, id))}
        onOpenPalette={() => setPaletteOpen(true)}
        onLocalTerminal={openLocal}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
        onLock={() => void vault.lock().catch(() => undefined)}
        hostCount={data.hosts.value?.length ?? 0}
        snippetCount={data.snippets.value?.length ?? 0}
      />

      <div className="main">
        <TabStrip
          ws={ws}
          destination={destination}
          renaming={renaming}
          onRenaming={setRenaming}
          onSelect={(id) => setWs((current) => selectTab(current, id))}
          onClose={(id) => setWs((current) => closeTab(current, id))}
          onCloseOthers={(id) => setWs((current) => closeOtherTabs(current, id))}
          onRename={(id, title) => setWs((current) => renameTab(current, id, title))}
          onMove={(from, to) => setWs((current) => moveTab(current, from, to))}
          onSplit={(id, dir) => {
            const t = wsRef.current.tabs.find((x) => x.id === id);
            if (t) setWs((current) => splitPane(selectTab(current, id), t.focused, dir));
          }}
          onDuplicate={(id) => {
            const t = wsRef.current.tabs.find((x) => x.id === id);
            const p = t ? wsRef.current.panes[t.focused] : undefined;
            if (p) open(p.target, p.label, p.identity);
          }}
          onNewLocal={openLocal}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <main className="content" aria-label={terminalVisible && tab ? tabTitle(ws, tab) : msg.nav[destination]}>
          {!terminalVisible && destination === "home" && (
            <HomeView ws={ws} statuses={statuses} onConnect={connect} onLocal={openLocal} onNavigate={navigate} onSelectTab={(id) => setWs((c) => selectTab(c, id))} />
          )}
          {!terminalVisible && destination === "hosts" && <HostsView ws={ws} onConnect={connect} />}
          {!terminalVisible && destination === "snippets" && <SnippetsView />}
          {!terminalVisible && destination === "keychain" && <KeychainView />}
          {!terminalVisible && destination === "knownHosts" && <KnownHostsView />}
          {!terminalVisible && destination === "settings" && <SettingsView />}
          {/* agent B: tunnels and history */}
          {!terminalVisible && destination === "tunnels" && (
            <TunnelsView
              sessions={Object.values(ws.panes).flatMap((p) => {
                const sessionId = handles.current.get(p.id)?.sessionId();
                return p.target.kind === "ssh" && statuses[p.id]?.state === "connected" && sessionId
                  ? [{ sessionId, hostId: p.target.hostId, label: p.label }]
                  : [];
              })}
              onConnect={connect}
            />
          )}

          {/* Terminals stay mounted while hidden so their screen state and session survive tab switches. */}
          <Suspense fallback={null}>
            {ws.tabs.length > 0 && (
              <PaneGrid
                ws={ws}
                prefs={prefs.terminal}
                panel={
                  showPanel && sidePanel === "files" ? (
                    <FilesPanel
                      target={filesSession && pane ? { sessionId: filesSession, label: pane.label } : null}
                      others={Object.values(ws.panes).flatMap((p) => {
                        const id = p.target.kind === "ssh" && statuses[p.id]?.state === "connected" ? handles.current.get(p.id)?.sessionId() : null;
                        return id && id !== filesSession ? [{ sessionId: id, label: p.label }] : [];
                      })}
                      onClose={() => {
                        setSidePanel(null);
                        focusedHandle()?.focus();
                      }}
                    />
                  ) : showPanel ? (
                    <SnippetsPanel
                      target={pane && paneStatus?.state === "connected" ? { label: pane.label, identity: pane.identity } : null}
                      onSend={requestSnippet}
                      onClose={() => {
                        setSidePanel(null);
                        focusedHandle()?.focus();
                      }}
                    />
                  ) : null
                }
                onPatch={(paneId, patch) => setWs((current) => patchPane(current, paneId, patch))}
                onStatus={(paneId, status) => setStatuses((current) => ({ ...current, [paneId]: status }))}
                onFocus={(paneId) => setWs((current) => focusPaneInActiveTab(current, paneId))}
                onClose={(paneId) => {
                  setWs((current) => closePane(current, paneId));
                  setStatuses((current) => {
                    const next = { ...current };
                    delete next[paneId];
                    return next;
                  });
                }}
                onSplit={(paneId, dir) => setWs((current) => splitPane(current, paneId, dir))}
                onRatio={(tabId, path, ratio) => setWs((current) => setRatio(current, tabId, path, ratio))}
                onOpenKnownHosts={() => navigate("knownHosts")}
                register={(paneId, handle) => {
                  if (handle) handles.current.set(paneId, handle);
                  else handles.current.delete(paneId);
                }}
                broadcasting={broadcasting}
                onUserInput={relayInput}
              />
            )}
          </Suspense>
        </main>

        <StatusBar
          pane={terminalVisible ? pane : null}
          status={terminalVisible ? paneStatus : undefined}
          panelOpen={panelOpen}
          onTogglePanel={terminalVisible ? () => togglePanel("snippets") : undefined}
          filesOpen={sidePanel === "files"}
          onToggleFiles={terminalVisible ? () => togglePanel("files") : undefined}
          theme={resolvedTheme}
          onToggleTheme={() => update((p) => ({ ...p, theme: resolvedTheme === "dark" ? "light" : "dark" }))}
          broadcast={terminalVisible && tab && broadcasting.has(tab.id) ? panesOf(tab.layout).length : undefined}
          onStopBroadcast={() => {
            if (!tab) return;
            const id = tab.id;
            setBroadcasting((current) => new Set([...current].filter((x) => x !== id)));
          }}
        />
      </div>

      {paletteOpen && (
        <CommandPalette
          hasTerminal={terminalVisible && pane !== null}
          terminalConnected={paneStatus?.state === "connected"}
          onClose={() => {
            setPaletteOpen(false);
            if (terminalVisible) focusedHandle()?.focus();
          }}
          onConnect={connect}
          onNavigate={navigate}
          onAction={runAction}
          onToggleTheme={() => update((p) => ({ ...p, theme: resolvedTheme === "dark" ? "light" : "dark" }))}
          onLocal={openLocal}
          onSnippet={(snippet) => requestSnippet(snippet, "run")}
          broadcast={tab ? broadcasting.has(tab.id) : false}
          onToggleBroadcast={
            terminalVisible && tab && (broadcasting.has(tab.id) || tabCanBroadcast)
              ? () => {
                  const id = tab.id;
                  setBroadcasting((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }
              : undefined
          }
          onDeployKey={
            pane?.target.kind === "ssh" && paneStatus?.state === "connected"
              ? () => {
                  const sessionId = focusedHandle()?.sessionId();
                  if (sessionId && pane.target.kind === "ssh") setDeploying({ sessionId, hostId: pane.target.hostId });
                }
              : undefined
          }
          onShellIntegration={
            pane && paneStatus?.state === "connected"
              ? () => {
                  const sessionId = focusedHandle()?.sessionId();
                  if (pane.target.kind === "local") setIntegrating({ kind: "local" });
                  else if (sessionId) setIntegrating({ kind: "ssh", sessionId });
                }
              : undefined
          }
        />
      )}

      {deploying && (
        <DeployKeyDialog
          sessionId={deploying.sessionId}
          host={data.hosts.value?.find((h) => h.id === deploying.hostId) ?? null}
          keys={data.keys.value ?? []}
          onClose={() => {
            setDeploying(null);
            focusedHandle()?.focus();
          }}
          onHostChanged={() => {
            void data.hosts.reload();
            void data.keys.reload();
          }}
        />
      )}

      {suggesting && (
        <SuggestDialog
          sessionId={suggesting.sessionId}
          hostId={suggesting.hostId}
          onClose={() => {
            setSuggesting(null);
            handles.current.get(suggesting.paneId)?.focus();
          }}
          onSnippet={(snippet) => {
            setSuggesting(null);
            requestSnippet(snippet, "paste");
          }}
          onIntegration={() => {
            const target = suggesting;
            setSuggesting(null);
            setIntegrating({ kind: "ssh", sessionId: target.sessionId });
          }}
          onInsert={(text) => {
            const target = suggesting;
            setSuggesting(null);
            const handle = handles.current.get(target.paneId);
            // Only into the same live session the dialog was opened for; never with Enter.
            if (!handle || handle.sessionId() !== target.sessionId) return;
            void sessionsApi
              .write(target.sessionId, insertionBytes(text, handle.bracketedPaste()))
              .then(() => handle.focus())
              .catch((error: Error) => notify("danger", error.message));
          }}
        />
      )}

      {integrating && (
        <IntegrationDialog
          target={integrating}
          onClose={() => {
            setIntegrating(null);
            focusedHandle()?.focus();
          }}
        />
      )}

      {runRequest && (
        <SnippetRunDialog
          request={runRequest}
          onCancel={() => {
            setRunRequest(null);
            focusedHandle()?.focus();
          }}
          onConfirm={() => {
            const request = runRequest;
            setRunRequest(null);
            void sendSnippet(request);
          }}
        />
      )}
    </div>
    </SnippetRunContext.Provider>
  );
}

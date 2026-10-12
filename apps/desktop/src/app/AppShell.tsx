import type { HostSummary, LayoutTarget, LayoutTemplateSummary, SnippetSummary } from "@tyrminal/contracts";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { FilesPanel } from "../features/files/FilesPanel";
import { SnippetsView } from "../features/snippets/SnippetsView";
// agent B: tunnels and history
import { TunnelsView } from "../features/tunnels/TunnelsView";
import type { TerminalTarget } from "../features/terminal/TerminalController";
import type { PaneHandle, PaneStatus } from "../features/terminal/TerminalView";
import { snippets as snippetsApi, vault } from "../lib/ipc";
import { detach as detachApi, layouts as layoutsApi } from "../lib/ipc";
import { useLoaded } from "../lib/useAsync";
import { SaveLayoutDialog } from "../features/layouts/SaveLayoutDialog";
import { type BroadcastTarget, BroadcastReview } from "../features/layouts/BroadcastReview";
import { useSlowPatternNotice } from "../features/highlight/useSlowPatternNotice";
import { extraPaletteItems } from "../features/commands/extraActions";
import { ConnectionDetails } from "../features/connection/ConnectionDetails";
import { ConnectionPanel, type PanelSection } from "../features/sidepanel/ConnectionPanel";
import { NewHostFromTerminal } from "../features/tokens/NewHostFromTerminal";
import { type BroadcastMembers, memberPanes, pruneMembers, relayTargets, withTab, withoutTab } from "../features/broadcast/members";
import { EncodingDialog } from "../features/terminal/EncodingDialog";
import { msg } from "../lib/messages";
import { msgC } from "../lib/messages-c";
import { actionFor, applyBindingOverrides, tabIndexFor } from "../lib/shortcuts";
import { workspacePrefs } from "../features/layouts/WorkspaceSettings";
import { usePreferences } from "./preferences";
import { VaultDataProvider, useVaultData } from "./vaultData";
import {
  type Arrangement,
  type Direction,
  MAX_PANES,
  type Workspace,
  activePane,
  activeTab,
  arrangeTab,
  closeOtherTabs,
  closePane,
  closeTab,
  connectPanes,
  detachInput,
  cycleTab,
  duplicateTab,
  emptyWorkspace,
  focusPane,
  focusPaneInActiveTab,
  markSaved,
  markUnread,
  movePane,
  moveTab,
  neighbour,
  openTab,
  paneCount,
  paneToNewTab,
  panesOf,
  patchPane,
  renameTab,
  restoreTemplate,
  selectTab,
  setFocusMode,
  setRatio,
  splitPane,
  swapPanes,
  tabTitle,
  templateDirty,
  templateTabs,
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
  // The user's shortcuts replace the defaults before anything below reads them.
  applyBindingOverrides(workspacePrefs(prefs.workspace).bindings);
  const data = useVaultData();
  const notify = useToast();
  useSlowPatternNotice();
  const [destination, setDestination] = useState<Destination>("home");
  const [ws, setWs] = useState<Workspace>(emptyWorkspace);
  const [collapsed, setCollapsed] = useState(false);
  // The side panel beside the terminals: snippets or files, one at a time.
  const [sidePanel, setSidePanel] = useState<"snippets" | "files" | null>(null);
  const panelOpen = sidePanel === "snippets";
  const togglePanel = useCallback((which: "snippets" | "files") => setSidePanel((v) => (v === which ? null : which)), []);
  // terminal input: the side panel's section (snippets, history, appearance; TRM-14)
  const [panelSection, setPanelSection] = useState<PanelSection>("snippets");
  const panelSectionRef = useRef(panelSection);
  const sidePanelRef = useRef(sidePanel);
  sidePanelRef.current = sidePanel;
  panelSectionRef.current = panelSection;
  const showSection = useCallback((section: PanelSection) => {
    setPanelSection(section);
    setSidePanel("snippets");
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette can instead pick the destination of a new pane (a split with another host).
  const [pickingSplit, setPickingSplit] = useState<Direction | null>(null);
  // Named layout templates: listed from the vault, saved only on an explicit request.
  const savedLayouts = useLoaded(layoutsApi.list);
  const [savingAs, setSavingAs] = useState(false);
  const [choosingEncoding, setChoosingEncoding] = useState<{ paneId: number; current: string; target: string } | null>(null);
  // Broadcast starts only after the user reviewed exactly which panes receive input (P-13).
  const [reviewing, setReviewing] = useState<{ tabId: number; targets: BroadcastTarget[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<number, PaneStatus>>({});
  // terminal input: the connection details dialog (CON-15)
  const [details, setDetails] = useState<{ sessionId: string; label: string } | null>(null);
  const [deploying, setDeploying] = useState<{ sessionId: string; hostId: string } | null>(null);
  // Tabs in broadcast mode with the panes the user confirmed. Kept in memory only: never saved,
  // and switched off as soon as a confirmed pane stops being connected (a reconnect never
  // resumes broadcasting silently). Panes left out in the review neither send nor receive.
  const [members, setMembers] = useState<BroadcastMembers>(new Map());
  const broadcasting = useMemo<ReadonlySet<number>>(() => new Set(members.keys()), [members]);
  const stopBroadcast = useCallback((tabId: number) => setMembers((current) => withoutTab(current, tabId)), []);
  const [runRequest, setRunRequest] = useState<SnippetRunRequest | null>(null);
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
    // Off when a broadcasting tab is gone, or a confirmed pane left it, dropped or reconnected.
    setMembers((current) =>
      pruneMembers(
        current,
        (tabId) => {
          const t = ws.tabs.find((x) => x.id === tabId);
          return t ? panesOf(t.layout) : null;
        },
        (paneId) => (statuses[paneId]?.state === "connected" ? (handles.current.get(paneId)?.sessionId() ?? null) : null),
      ),
    );
  }, [ws, statuses]);

  /** The panes (and their current sessions) that broadcast in `tabId` would send to. */
  const broadcastTargets = useCallback(
    (tabId: number): BroadcastTarget[] =>
      broadcastPanes(tabId).flatMap((id) => {
        const p = wsRef.current.panes[id];
        const sessionId = handles.current.get(id)?.sessionId();
        return p && sessionId ? [{ paneId: id, sessionId, label: p.label, identity: p.identity }] : [];
      }),
    [broadcastPanes],
  );

  const relayInput = useCallback(
    (tabId: number, from: number, bytes: Uint8Array) => {
      const live = (paneId: number) => {
        const h = handles.current.get(paneId);
        return statuses[paneId]?.state === "connected" && h?.broadcastable() === true ? (h.sessionId() ?? null) : null;
      };
      for (const id of relayTargets(members, tabId, from, live)) handles.current.get(id)?.receiveBroadcast(bytes);
    },
    [members, statuses],
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

  /** Splits `paneId` (the focused pane by default); at the pane limit, says so instead. */
  const split = useCallback(
    (dir: Direction, seed?: { target: TerminalTarget; label: string; identity: string }, paneId?: number) => {
      const id = paneId ?? activePane(wsRef.current)?.id;
      if (id === undefined) return;
      if (paneCount(wsRef.current) >= MAX_PANES) {
        notify("danger", msgC.panes.full);
        return;
      }
      setWs((current) => splitPane(current, id, dir, seed));
    },
    [notify],
  );

  const duplicate = useCallback(
    (id: number) => {
      const current = wsRef.current;
      const next = duplicateTab(current, id);
      const t = current.tabs.find((x) => x.id === id);
      if (next === current && t) notify("danger", msgC.tabs.duplicateFull(panesOf(t.layout).length));
      else setWs(next);
    },
    [notify],
  );

  /** What a template pane shows before it connects; a deleted host stays visibly missing. */
  const seedFor = useCallback(
    (target: LayoutTarget) => {
      if (target.kind === "local") return { target: { kind: "local" } as const, label: msg.nav.localTerminal, identity: msg.terminal.local };
      const host = data.hosts.value?.find((h) => h.id === target.hostId);
      return {
        target: { kind: "ssh", hostId: target.hostId } as const,
        label: host?.label ?? msgC.restore.missingHost,
        identity: host ? hostIdentity(host) : "",
      };
    },
    [data.hosts.value],
  );

  const openLayout = useCallback(
    (layout: LayoutTemplateSummary) => {
      const current = wsRef.current;
      const next = restoreTemplate(current, layout.tabs, seedFor);
      if (next === current) {
        notify("danger", msgC.layouts.full(layout.tabs.reduce((n, t) => n + t.panes.length, 0)));
        return;
      }
      setWs(markSaved(next, layout));
    },
    [notify, seedFor],
  );

  /** Saves the open tabs: into the current template, or as a new one when `name` is given. */
  const saveLayout = useCallback(
    async (name?: string): Promise<string | null> => {
      const current = wsRef.current;
      const target = name === undefined ? current.template : null;
      if (!target && name === undefined) {
        setSavingAs(true);
        return null;
      }
      try {
        const saved = await layoutsApi.save({ id: target?.id ?? null, name: target?.name ?? (name as string), tabs: templateTabs(current) });
        setWs((now) => markSaved(now, saved));
        void savedLayouts.reload();
        notify("success", msgC.layouts.saved(saved.name));
        return null;
      } catch (error) {
        const message = (error as Error).message;
        if (name === undefined) notify("danger", message);
        return message;
      }
    },
    [notify, savedLayouts],
  );

  const deleteLayout = useCallback(
    async (layout: LayoutTemplateSummary) => {
      try {
        await layoutsApi.remove(layout.id);
        setWs((now) => (now.template?.id === layout.id ? { ...now, template: null } : now));
        void savedLayouts.reload();
        notify("info", msgC.layouts.deleted(layout.name));
      } catch (error) {
        notify("danger", (error as Error).message);
      }
    },
    [notify, savedLayouts],
  );

  /** Moves a tab, with its live sessions, into a new window. Its panes unmount here without closing. */
  const detachTab = useCallback(
    async (tabId: number) => {
      const t = wsRef.current.tabs.find((x) => x.id === tabId);
      if (!t) return;
      const ids = panesOf(t.layout);
      const live = ids.map((id) => handles.current.get(id)).filter((h) => h?.connected() && h.sessionId());
      if (live.length !== ids.length) {
        notify("danger", msgC.detach.notConnected);
        return;
      }
      const input = detachInput(wsRef.current, t, (id) => handles.current.get(id)?.sessionId() ?? "");
      for (const h of live) h?.release(true);
      try {
        await detachApi.open(input);
        stopBroadcast(tabId);
        setWs((current) => closeTab(current, tabId));
        notify("success", msgC.detach.moved(tabTitle(wsRef.current, t)));
      } catch (error) {
        for (const h of live) h?.release(false);
        notify("danger", msgC.detach.failed((error as Error).message));
      }
    },
    [notify],
  );

  const arrange = useCallback((arrangement: Arrangement) => {
    const t = activeTab(wsRef.current);
    if (t) setWs((current) => arrangeTab(current, t.id, arrangement));
  }, []);

  const moveFocused = useCallback((towards: "left" | "right" | "up" | "down") => {
    const p = activePane(wsRef.current);
    if (p) setWs((current) => movePane(current, p.id, towards));
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
          // From another section of the open panel, the snippets shortcut shows snippets.
          if (sidePanelRef.current === "snippets" && panelSectionRef.current !== "snippets") setPanelSection("snippets");
          else {
            setPanelSection("snippets");
            togglePanel("snippets");
          }
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
        case "renameTab": {
          const t = activeTab(wsRef.current);
          if (t) setRenaming(t.id);
          break;
        }
        // agent C: workspaces
        case "toggleFocusLayout": {
          const t = activeTab(wsRef.current);
          if (t && panesOf(t.layout).length > 1) setWs((current) => setFocusMode(current, t.id, !t.focusMode));
          break;
        }
        case "movePaneLeft":
          moveFocused("left");
          break;
        case "movePaneRight":
          moveFocused("right");
          break;
        case "movePaneUp":
          moveFocused("up");
          break;
        case "movePaneDown":
          moveFocused("down");
          break;
        default:
          break;
      }
    },
    [openLocal, closeFocused, split, focusedHandle, moveFocus, moveFocused, navigate],
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

  return (
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
            if (!t) return;
            setWs((current) => selectTab(current, id));
            split(dir, undefined, t.focused);
          }}
          onDuplicate={duplicate}
          onDetach={(id) => void detachTab(id)}
          onNewLocal={openLocal}
          onOpenPalette={() => setPaletteOpen(true)}
          recent={(data.recent.value ?? []).map((h) => ({ id: h.id, label: h.label, detail: hostIdentity(h), onSelect: () => connect(h) }))}
          layout={
            ws.template
              ? { name: ws.template.name, dirty: templateDirty(ws), onSave: () => void saveLayout(), onSaveAs: () => setSavingAs(true) }
              : null
          }
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
                workspace={workspacePrefs(prefs.workspace)}
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
                    <ConnectionPanel
                      section={panelSection}
                      onSection={setPanelSection}
                      hostId={pane?.target.kind === "ssh" ? pane.target.hostId : null}
                      onConnect={connect}
                      onZoom={(step) => focusedHandle()?.zoom(step)}
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
                onUnread={(paneId) => setWs((current) => markUnread(current, paneId))}
                onSelectPane={(paneId) => setWs((current) => focusPane(current, paneId))}
                onSwap={(a, b) => setWs((current) => swapPanes(current, a, b))}
                onFocusMode={(tabId, on) => setWs((current) => setFocusMode(current, tabId, on))}
                onToNewTab={(paneId) => setWs((current) => paneToNewTab(current, paneId))}
                onConnect={(paneIds) => setWs((current) => connectPanes(current, paneIds))}
                onClose={(paneId) => {
                  setWs((current) => closePane(current, paneId));
                  setStatuses((current) => {
                    const next = { ...current };
                    delete next[paneId];
                    return next;
                  });
                }}
                onSplit={(paneId, dir) => split(dir, undefined, paneId)}
                onRatio={(tabId, path, ratio) => setWs((current) => setRatio(current, tabId, path, ratio))}
                onOpenKnownHosts={() => navigate("knownHosts")}
                register={(paneId, handle) => {
                  if (handle) handles.current.set(paneId, handle);
                  else handles.current.delete(paneId);
                }}
                broadcasting={broadcasting}
                broadcastPaneIds={memberPanes(members)}
                onUserInput={relayInput}
              />
            )}
          </Suspense>
        </main>

        <StatusBar
          pane={terminalVisible ? pane : null}
          status={terminalVisible ? paneStatus : undefined}
          panelOpen={panelOpen}
          onTogglePanel={terminalVisible ? () => runAction("toggleSnippets") : undefined}
          filesOpen={sidePanel === "files"}
          onToggleFiles={terminalVisible ? () => togglePanel("files") : undefined}
          theme={resolvedTheme}
          onToggleTheme={() => update((p) => ({ ...p, theme: resolvedTheme === "dark" ? "light" : "dark" }))}
          broadcast={terminalVisible && tab ? members.get(tab.id)?.size : undefined}
          onStopBroadcast={() => {
            if (!tab) return;
            stopBroadcast(tab.id);
          }}
        />
      </div>

      {pickingSplit && (
        <CommandPalette
          hasTerminal={false}
          terminalConnected={false}
          pick={{
            title: msgC.panes.pickTitle(pickingSplit === "row" ? msgC.panes.right : msgC.panes.below),
            onPick: (choice) => {
              const dir = pickingSplit;
              if (choice === "local") split(dir, { target: { kind: "local" }, label: msg.nav.localTerminal, identity: msg.terminal.local });
              else split(dir, { target: { kind: "ssh", hostId: choice.id }, label: choice.label, identity: hostIdentity(choice) });
            },
          }}
          onClose={() => {
            setPickingSplit(null);
            focusedHandle()?.focus();
          }}
          onConnect={() => undefined}
          onNavigate={() => undefined}
          onAction={() => undefined}
          onToggleTheme={() => undefined}
          onLocal={() => undefined}
          onSnippet={() => undefined}
        />
      )}

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
          extra={extraPaletteItems({
            hasTerminal: terminalVisible && tab !== null && pane !== null,
            tabCount: ws.tabs.length,
            split: tab ? panesOf(tab.layout).length > 1 : false,
            onAction: runAction,
            onCloseTab: () => tab && setWs((current) => closeTab(current, tab.id)),
            onCloseOtherTabs: () => tab && setWs((current) => closeOtherTabs(current, tab.id)),
            onCopy: () => void focusedHandle()?.copy(),
            onPaste: () => focusedHandle()?.paste(),
            onShowSection: showSection,
            onDetails:
              pane?.target.kind === "ssh" && focusedHandle()?.sessionId()
                ? () => {
                    const sessionId = focusedHandle()?.sessionId();
                    if (sessionId) setDetails({ sessionId, label: pane.label });
                  }
                : undefined,
          })}
          openTabs={ws.tabs.map((t) => {
            const p = ws.panes[t.focused];
            return { id: t.id, title: tabTitle(ws, t), detail: p?.identity ?? "", onSelect: () => setWs((current) => selectTab(current, t.id)) };
          })}
          layouts={{
            list: savedLayouts.value ?? [],
            current: ws.template?.name ?? null,
            canSave: ws.tabs.length > 0,
            onOpen: openLayout,
            onSave: () => void saveLayout(),
            onSaveAs: () => setSavingAs(true),
            onDelete: (layout) => void deleteLayout(layout),
          }}
          workspace={
            terminalVisible && tab
              ? {
                  split: panesOf(tab.layout).length > 1,
                  focusLayout: tab.focusMode,
                  onDuplicate: () => duplicate(tab.id),
                  onArrange: arrange,
                  onPaneToNewTab: () => {
                    const p = activePane(wsRef.current);
                    if (p) setWs((current) => paneToNewTab(current, p.id));
                  },
                  onSplitWith: (dir) => setPickingSplit(dir),
                  onDetach: () => void detachTab(tab.id),
                  onEncoding: () => {
                    const p = activePane(wsRef.current);
                    const h = p ? handles.current.get(p.id) : undefined;
                    if (p && h) setChoosingEncoding({ paneId: p.id, current: h.encoding(), target: `${p.label} · ${p.identity}` });
                  },
                }
              : undefined
          }
          broadcast={tab ? broadcasting.has(tab.id) : false}
          onToggleBroadcast={
            terminalVisible && tab && (broadcasting.has(tab.id) || tabCanBroadcast)
              ? () => {
                  const id = tab.id;
                  if (broadcasting.has(id)) {
                    stopBroadcast(id);
                    return;
                  }
                  setReviewing({ tabId: id, targets: broadcastTargets(id) });
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
        />
      )}

      {choosingEncoding && (
        <EncodingDialog
          current={choosingEncoding.current}
          target={choosingEncoding.target}
          onCancel={() => {
            setChoosingEncoding(null);
            focusedHandle()?.focus();
          }}
          onApply={(id) => {
            handles.current.get(choosingEncoding.paneId)?.setEncoding(id);
            setChoosingEncoding(null);
            focusedHandle()?.focus();
          }}
        />
      )}

      {reviewing && (
        <BroadcastReview
          targets={reviewing.targets}
          onCancel={() => {
            setReviewing(null);
            focusedHandle()?.focus();
          }}
          onConfirm={(chosen) => {
            const { tabId, targets } = reviewing;
            setReviewing(null);
            const t = wsRef.current.tabs.find((x) => x.id === tabId);
            const now = broadcastTargets(tabId);
            const same =
              t !== undefined &&
              now.length === panesOf(t.layout).length &&
              now.length === targets.length &&
              now.every((x, i) => x.paneId === targets[i]?.paneId && x.sessionId === targets[i]?.sessionId);
            if (!same) {
              notify("danger", msgC.broadcast.changed);
            } else {
              const confirmed = new Map(targets.filter((x) => chosen.has(x.paneId)).map((x) => [x.paneId, x.sessionId] as const));
              if (confirmed.size >= 2) setMembers((current) => withTab(current, tabId, confirmed));
            }
            focusedHandle()?.focus();
          }}
        />
      )}

      {savingAs && (
        <SaveLayoutDialog
          initialName={ws.template?.name ?? ""}
          summary={msgC.layouts.summary(ws.tabs.length, paneCount(ws))}
          onCancel={() => {
            setSavingAs(false);
            if (terminalVisible) focusedHandle()?.focus();
          }}
          onSave={async (name) => {
            const failure = await saveLayout(name);
            if (failure === null) setSavingAs(false);
            return failure;
          }}
        />
      )}

      {/* terminal input: an address clicked in the output becomes a prefilled new host */}
      <NewHostFromTerminal onDone={() => focusedHandle()?.focus()} />

      {details && (
        <ConnectionDetails
          sessionId={details.sessionId}
          label={details.label}
          onClose={() => {
            setDetails(null);
            focusedHandle()?.focus();
          }}
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
  );
}

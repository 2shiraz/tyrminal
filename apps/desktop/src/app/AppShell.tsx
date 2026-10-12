import type { HostSummary, LayoutTarget, LayoutTemplateSummary, SnippetSummary } from "@tyrminal/contracts";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Sidebar } from "../components/layout/Sidebar";
import { StatusBar } from "../components/layout/StatusBar";
import { TabStrip } from "../components/layout/TabStrip";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import { useToast } from "../components/ui/Toasts";
import { HostsView } from "../features/hosts/HostsView";
// privilege prompts (KEY-18)
import { msgP } from "../lib/messages-privilege";
import { ProductionConfirm } from "../features/hosts/ProductionConfirm";
import { useIsProduction } from "../features/hosts/production";
import { CommandPalette } from "../features/palette/CommandPalette";
import type { Section as SettingsSection } from "../features/settings/SettingsViews";
import { SnippetRunDialog, type SnippetRunRequest, needsSnippetReview } from "../features/snippets/SnippetRunDialog";
// server at a glance
// tmux and screen session awareness (P-31)
import { msgMx } from "../lib/messages-multiplexers";
// agent B: tunnels and history
import { msgSftp } from "../features/sftp/messages";
import { sftpRequests } from "../features/sftp/requests";
import { SnippetRunContext } from "../features/snippets/runContext";
import { engineName } from "../features/terminal/containerEngine";
import { shellContexts } from "../features/autocomplete/shellContext";
// command history
import { installHistoryCapture } from "../features/history/historyCapture";
import { insertionBytes } from "../features/autocomplete/suggest";
import type { PaneHandle, PaneStatus } from "../features/terminal/TerminalView";
import { sessions as sessionsApi, snippets as snippetsApi, vault } from "../lib/ipc";
import { detach as detachApi, layouts as layoutsApi } from "../lib/ipc";
import { lazyComponent } from "../lib/lazyComponent";
import { useLoaded } from "../lib/useAsync";
import type { BroadcastTarget } from "../features/layouts/BroadcastReview";
import { useSlowPatternNotice } from "../features/highlight/useSlowPatternNotice";
import { extraPaletteItems } from "../features/commands/extraActions";
import type { PanelSection } from "../features/sidepanel/ConnectionPanel";
import { NewHostFromTerminal } from "../features/tokens/NewHostFromTerminal";
import { type BroadcastMembers, memberPanes, pruneMembers, relayTargets, withTab, withoutTab } from "../features/broadcast/members";
import { msgD } from "../lib/messages-d";
import { msg } from "../lib/messages";
import { msgProduction } from "../lib/messages-production";
import { msgC } from "../lib/messages-c";
// quick connect
import { msgQuick } from "../lib/messages-quick";
import { type QuickTarget, forgetQuick, formatTarget, startQuick } from "../lib/quickConnect";
import { actionFor, applyBindingOverrides, tabIndexFor } from "../lib/shortcuts";
import { workspacePrefs } from "../features/layouts/WorkspaceSettings";
import { useCommandFinished } from "../features/notify/useCommandFinished";
import { type OpenLayout, openBeside, openMany } from "./multiOpen";
import { stepScale } from "./interfaceScale";
import { usePreferences } from "./preferences";
import { VaultDataProvider, useVaultData } from "./vaultData";
import {
  type Arrangement,
  type Direction,
  MAX_PANES,
  type PaneTarget,
  type Workspace,
  activePane,
  activeTab,
  arrangeTab,
  closeOtherTabs,
  closePane,
  closeTab,
  connectPanes,
  cyclePane,
  reopenClosedTab,
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
  retargetPane,
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
  | "hosts"
  | "snippets"
  | "keychain"
  | "knownHosts"
  | "settings"
  // agent B: tunnels and history
  | "tunnels"
  | "recordings";

// The terminal emulator is the largest module and is not needed until a session opens.
const PaneGrid = lazy(() => import("../components/layout/PaneGrid").then((m) => ({ default: m.PaneGrid })));

// Loaded on first use: none of these is needed for the first paint of Hosts (the window opens on
// it). Views show an empty page for the moment their chunk loads; panels and dialogs show nothing.
const pageFallback = <div className="page" aria-busy="true" />;
const SnippetsView = lazyComponent(() => import("../features/snippets/SnippetsView").then((m) => m.SnippetsView), pageFallback);
const KeychainView = lazyComponent(() => import("../features/credentials/KeychainView").then((m) => m.KeychainView), pageFallback);
const KnownHostsView = lazyComponent(() => import("../features/settings/SettingsViews").then((m) => m.KnownHostsView), pageFallback);
const SettingsView = lazyComponent<{ initialSection?: SettingsSection | undefined; onOpenKeychain?: () => void }>(() => import("../features/settings/SettingsViews").then((m) => m.SettingsView), pageFallback);
// agent B: tunnels and history
const TunnelsView = lazyComponent(() => import("../features/tunnels/TunnelsView").then((m) => m.TunnelsView), pageFallback);
const RecordingsView = lazyComponent(() => import("../features/history/RecordingsView").then((m) => m.RecordingsView), pageFallback);
// The side panels beside the terminals.
const loadFilesPanel = () => import("../features/files/FilesPanel");
/** The files panel's module once it loaded: its per-session memory exists only from then on. */
let filesPanelModule: Awaited<ReturnType<typeof loadFilesPanel>> | null = null;
const FilesPanel = lazyComponent(() =>
  loadFilesPanel().then((m) => {
    filesPanelModule = m;
    return m.FilesPanel;
  }),
);
// server at a glance
const ServerPanel = lazyComponent(() => import("../features/glance/ServerPanel").then((m) => m.ServerPanel));
const NotesPanel = lazyComponent(() => import("../features/notes/NotesPanel").then((m) => m.NotesPanel));
const ConnectionPanel = lazyComponent(() => import("../features/sidepanel/ConnectionPanel").then((m) => m.ConnectionPanel));
// Dialogs opened from a terminal or the palette.
// privilege prompts (KEY-18)
const InsertPasswordDialog = lazyComponent(() => import("../features/privilege/InsertPasswordDialog").then((m) => m.InsertPasswordDialog));
const DeployKeyDialog = lazyComponent(() => import("../features/credentials/DeployKeyDialog").then((m) => m.DeployKeyDialog));
const MultiRunDialog = lazyComponent(() => import("../features/snippets/MultiRunDialog").then((m) => m.MultiRunDialog));
const IntegrationDialog = lazyComponent(() => import("../features/autocomplete/IntegrationDialog").then((m) => m.IntegrationDialog));
const ConnectionLogDialog = lazyComponent(() => import("../features/terminal/ConnectionLogDialog").then((m) => m.ConnectionLogDialog));
const ContainersDialog = lazyComponent(() => import("../features/terminal/ContainersDialog").then((m) => m.ContainersDialog));
const SuggestDialog = lazyComponent(() => import("../features/autocomplete/SuggestDialog").then((m) => m.SuggestDialog));
const CommandOutputDialog = lazyComponent(() => import("../features/terminal/CommandOutputDialog").then((m) => m.CommandOutputDialog));
const SearchSessionsDialog = lazyComponent(() => import("../features/terminal/SearchSessionsDialog").then((m) => m.SearchSessionsDialog));
const SaveLayoutDialog = lazyComponent(() => import("../features/layouts/SaveLayoutDialog").then((m) => m.SaveLayoutDialog));
const BroadcastReview = lazyComponent(() => import("../features/layouts/BroadcastReview").then((m) => m.BroadcastReview));
const EncodingDialog = lazyComponent(() => import("../features/terminal/EncodingDialog").then((m) => m.EncodingDialog));

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
  const reloadRecent = data.recent.reload;
  const notify = useToast();
  useSlowPatternNotice();
  const [destination, setDestination] = useState<Destination>("hosts");
  // command history: remembers commands from shell-integration marks while history is on.
  useEffect(() => installHistoryCapture(), []);
  const [ws, setWs] = useState<Workspace>(emptyWorkspace);
  const [collapsed, setCollapsed] = useState(false);
  // The side panel beside the terminals: snippets, files, server facts or host notes, one at a time.
  const [sidePanel, setSidePanel] = useState<"snippets" | "files" | "server" | "notes" | null>(null);
  const panelOpen = sidePanel === "snippets";
  const togglePanel = useCallback((which: "snippets" | "files" | "server" | "notes") => setSidePanel((v) => (v === which ? null : which)), []);
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
  const reloadLayouts = savedLayouts.reload;
  const [savingAs, setSavingAs] = useState(false);
  const [choosingEncoding, setChoosingEncoding] = useState<{ paneId: number; current: string; target: string } | null>(null);
  // Broadcast starts only after the user reviewed exactly which panes receive input (P-13).
  const [reviewing, setReviewing] = useState<{ tabId: number; targets: BroadcastTarget[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<number, PaneStatus>>({});
  const [deploying, setDeploying] = useState<{ sessionId: string; hostId: string } | null>(null);
  // privilege prompts (KEY-18)
  const [inserting, setInserting] = useState<{ sessionId: string; hostId: string } | null>(null);
  // P-28 and P-29: search across sessions, and the command-output dialog for one pane.
  const [searchingSessions, setSearchingSessions] = useState(false);
  const [outputFor, setOutputFor] = useState<number | null>(null);
  // Tabs in broadcast mode with the panes the user confirmed. Kept in memory only: never saved,
  // and switched off as soon as a confirmed pane stops being connected (a reconnect never
  // resumes broadcasting silently). Panes left out in the review neither send nor receive.
  const [members, setMembers] = useState<BroadcastMembers>(new Map());
  const broadcasting = useMemo<ReadonlySet<number>>(() => new Set(members.keys()), [members]);
  const stopBroadcast = useCallback((tabId: number) => setMembers((current) => withoutTab(current, tabId)), []);
  const [runRequest, setRunRequest] = useState<SnippetRunRequest | null>(null);
  /** SNP-07: a snippet to run on every open SSH session (reviewed first). */
  const [runAllOpen, setRunAllOpen] = useState(false);
  // agent D: suggestions for the focused SSH pane.
  const [suggesting, setSuggesting] = useState<{ paneId: number; sessionId: string; hostId: string | null } | null>(null);
  const [connectionLog, setConnectionLog] = useState<{ sessionId: string; label: string } | null>(null);
  // P-33: the containers dialog for an SSH session (its host label).
  const [containersOf, setContainersOf] = useState<{ sessionId: string; label: string } | null>(null);
  const [integrating, setIntegrating] = useState<{ kind: "ssh"; sessionId: string } | { kind: "local" } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const handles = useRef(new Map<number, PaneHandle>());
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const tab = activeTab(ws);
  const pane = activePane(ws);
  const paneStatus = pane ? statuses[pane.id] : undefined;

  // terminal notifications (P-23): tabs whose long command finished out of view, until shown.
  const [finished, setFinished] = useState<ReadonlyMap<number, number | null>>(new Map());
  const [finishedNotice, setFinishedNotice] = useState("");
  useEffect(() => {
    if (ws.active !== null && finished.has(ws.active)) {
      const next = new Map(finished);
      next.delete(ws.active);
      setFinished(next);
    }
  }, [ws.active, finished]);
  useCommandFinished(
    prefs.commandNotifications ?? { enabled: true, minSeconds: 10 },
    (sessionId) => {
      const current = wsRef.current;
      for (const t of current.tabs) {
        for (const id of panesOf(t.layout)) {
          if (handles.current.get(id)?.sessionId() !== sessionId) continue;
          const inView = current.active === t.id && document.visibilityState === "visible" && document.hasFocus();
          return { tabId: t.id, title: tabTitle(current, t), inView };
        }
      }
      return null;
    },
    (tabId, exitStatus, notice) => {
      setFinished((current) => new Map(current).set(tabId, exitStatus));
      setFinishedNotice(notice);
    },
    (tabId) => setWs((current) => (current.tabs.some((t) => t.id === tabId) ? selectTab(current, tabId) : current)),
  );

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

  // The files panel remembers each session's folder while that session lives.
  useEffect(() => {
    const live = new Set<string>();
    for (const p of Object.values(ws.panes)) {
      const id = handles.current.get(p.id)?.sessionId();
      if (id) live.add(id);
    }
    filesPanelModule?.panelMemory.retain(live);
  }, [ws, statuses]);

  // Panes connected to a production host (P-26), with the host's label, from the saved host and
  // the production tag; follows changes to either.
  const isProduction = useIsProduction();
  const productionPanes = useMemo(() => {
    const byId = new Map((data.hosts.value ?? []).map((h) => [h.id, h]));
    const out = new Map<number, string>();
    for (const p of Object.values(ws.panes)) {
      const host = p.target.kind === "ssh" ? byId.get(p.target.hostId) : undefined;
      if (host && isProduction(host)) out.set(p.id, host.label);
    }
    return out as ReadonlyMap<number, string>;
  }, [ws, data.hosts.value, isProduction]);
  // A broadcast that includes production panes waits for its own confirmation (P-26).
  const [confirmBroadcast, setConfirmBroadcast] = useState<{
    tabId: number;
    confirmed: ReadonlyMap<number, string>;
    production: number[];
  } | null>(null);

  // Stable, so the memoized pane grid never re-renders for it: it reads the committed members and
  // statuses through refs, the same values the per-render callback used to close over.
  const membersRef = useRef(members);
  const statusesRef = useRef(statuses);
  useLayoutEffect(() => {
    membersRef.current = members;
    statusesRef.current = statuses;
  }, [members, statuses]);
  const relayInput = useCallback((tabId: number, from: number, bytes: Uint8Array) => {
    const live = (paneId: number) => {
      const h = handles.current.get(paneId);
      return statusesRef.current[paneId]?.state === "connected" && h?.broadcastable() === true ? (h.sessionId() ?? null) : null;
    };
    for (const id of relayTargets(membersRef.current, tabId, from, live)) handles.current.get(id)?.receiveBroadcast(bytes);
  }, []);
  const broadcastPaneIds = useMemo(() => memberPanes(members), [members]);

  // A Settings section to open at (the sidebar's version opens About); any navigation clears it.
  const [settingsAt, setSettingsAt] = useState<{ section: SettingsSection; n: number } | null>(null);
  const navigate = useCallback((next: Destination) => {
    setDestination(next);
    setWs((current) => selectTab(current, null));
    setSettingsAt(null);
  }, []);
  const openAbout = useCallback(() => {
    navigate("settings");
    setSettingsAt((current) => ({ section: "about", n: (current?.n ?? 0) + 1 }));
  }, [navigate]);

  const open = useCallback((target: PaneTarget, label: string, identity: string, startIn?: string) => {
    setWs((current) => openTab(current, { target, label, identity, ...(startIn ? { startIn } : {}) }));
  }, []);

  // quick connect: an address that is not saved opens a tab at once; its pane shows the setup and
  // then connects. The details stay in memory under a token (lib/quickConnect).
  const quickConnect = useCallback(
    (target: QuickTarget) => {
      open({ kind: "quick", token: startQuick(target) }, target.address, formatTarget(target));
    },
    [open],
  );
  // The setup saved the host: the pane becomes that host's and connects the normal way.
  const onQuickSaved = useCallback(
    (paneId: number, host: HostSummary) => {
      setWs((current) => retargetPane(current, paneId, { target: { kind: "ssh", hostId: host.id }, label: host.label, identity: hostIdentity(host) }));
      window.setTimeout(() => void reloadRecent(), 3_000);
    },
    [reloadRecent],
  );
  // A quick pane that closed (or became a saved host's) leaves nothing behind.
  const quickTokens = useRef(new Set<string>());
  useEffect(() => {
    const live = new Set<string>();
    for (const pane of Object.values(ws.panes)) if (pane.target.kind === "quick") live.add(pane.target.token);
    for (const token of quickTokens.current) if (!live.has(token)) forgetQuick(token);
    quickTokens.current = live;
  }, [ws.panes]);

  const connect = useCallback(
    (host: HostSummary) => {
      open({ kind: "ssh", hostId: host.id }, host.label, hostIdentity(host));
      // The recent list updates once the session reaches its shell.
      window.setTimeout(() => void reloadRecent(), 3_000);
    },
    [open, reloadRecent],
  );

  // Several hosts at once (multi-select on Hosts): one tab each, or one tab split in a grid.
  const connectMany = useCallback(
    (list: HostSummary[], layout: OpenLayout) => {
      const seeds = list.map((host) => ({ target: { kind: "ssh" as const, hostId: host.id }, label: host.label, identity: hostIdentity(host) }));
      setWs((current) => openMany(current, seeds, layout));
      window.setTimeout(() => void data.recent.reload(), 3_000);
    },
    [data.recent],
  );

  // Connect in split: the host beside the focused pane of the terminal tab in front.
  const connectSplit = useCallback(
    (host: HostSummary) => {
      if (paneCount(wsRef.current) >= MAX_PANES) {
        notify("danger", msgC.panes.full);
        return;
      }
      setWs((current) => openBeside(current, { target: { kind: "ssh", hostId: host.id }, label: host.label, identity: hostIdentity(host) }));
      window.setTimeout(() => void data.recent.reload(), 3_000);
    },
    [notify, data.recent],
  );

  const openLocal = useCallback(() => open({ kind: "local" }, msg.nav.localTerminal, msg.terminal.local), [open]);
  // An SFTP tab: two file panes (this computer and a host picker); never split.
  const openSftp = useCallback(() => open({ kind: "sftp" }, msgSftp.tabTitle, msgSftp.view), [open]);
  /**
   * Open in SFTP: focuses the SFTP tab in front (or the first one; a new one when there is none)
   * and shows `host` in its right pane, at `path` when given.
   */
  const openSftpHosts = useCallback(
    (hosts: { id: string; label: string }[], path: string | null = null) => {
      const current = wsRef.current;
      const isSftp = (t: { focused: number }) => current.panes[t.focused]?.target.kind === "sftp";
      const front = current.tabs.find((t) => t.id === current.active && isSftp(t)) ?? current.tabs.find(isSftp);
      if (front) setWs((c) => selectTab(c, front.id));
      else openSftp();
      // One tab for all of them: each host becomes a location of its right pane.
      for (const host of hosts) sftpRequests.push({ source: { kind: "host", hostId: host.id, label: host.label }, path });
    },
    [openSftp],
  );
  const openSftpHost = useCallback((host: { id: string; label: string }, path: string | null = null) => openSftpHosts([host], path), [openSftpHosts]);

  /** Keyboard focus is in a terminal (its zoom keys then belong to it). */
  const inTerminal = () => document.activeElement?.closest(".terminal-pane") != null;

  const focusedHandle = useCallback(() => {
    const p = activePane(wsRef.current);
    return p ? (handles.current.get(p.id) ?? null) : null;
  }, []);

  /** Splits `paneId` (the focused pane by default); at the pane limit, says so instead. */
  const split = useCallback(
    (dir: Direction, seed?: { target: PaneTarget; label: string; identity: string }, paneId?: number) => {
      const id = paneId ?? activePane(wsRef.current)?.id;
      // An SFTP tab is never split.
      if (id === undefined || wsRef.current.panes[id]?.target.kind === "sftp") return;
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
      // Each copy starts in its source shell's current folder when the shell integration reports it.
      const next = duplicateTab(current, id, (paneId) => {
        const sessionId = handles.current.get(paneId)?.sessionId();
        return sessionId ? (shellContexts.get(sessionId)?.cwd ?? undefined) : undefined;
      });
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
        void reloadLayouts();
        notify("success", msgC.layouts.saved(saved.name));
        return null;
      } catch (error) {
        const message = (error as Error).message;
        if (name === undefined) notify("danger", message);
        return message;
      }
    },
    [notify, reloadLayouts],
  );

  const deleteLayout = useCallback(
    async (layout: LayoutTemplateSummary) => {
      try {
        await layoutsApi.remove(layout.id);
        setWs((now) => (now.template?.id === layout.id ? { ...now, template: null } : now));
        void reloadLayouts();
        notify("info", msgC.layouts.deleted(layout.name));
      } catch (error) {
        notify("danger", (error as Error).message);
      }
    },
    [notify, reloadLayouts],
  );

  /** Moves a tab, with its live sessions, into a new window. Its panes unmount here without closing. */
  const detachTab = useCallback(
    async (tabId: number) => {
      const t = wsRef.current.tabs.find((x) => x.id === tabId);
      if (!t) return;
      const ids = panesOf(t.layout);
      // quick connect: an unsaved connection's details stay in this window.
      if (ids.some((id) => wsRef.current.panes[id]?.target.kind === "quick")) {
        notify("danger", msgQuick.noDetach);
        return;
      }
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
        setWs((current) => closeTab(current, tabId, { remember: false }));
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
      const request: SnippetRunRequest = {
        snippet,
        mode,
        paneId: p.id,
        sessionId,
        targetLabel: p.label,
        targetIdentity: p.identity,
        environment: handle.environment(),
      };
      if (needsSnippetReview(request)) {
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
        // In a terminal these zoom that terminal; anywhere else they change the interface size.
        case "zoomIn":
        case "zoomOut":
        case "zoomReset": {
          if (inTerminal()) {
            focusedHandle()?.zoom(action === "zoomIn" ? "in" : action === "zoomOut" ? "out" : "reset");
          } else {
            update((p) => ({
              ...p,
              interfaceScale: action === "zoomReset" ? null : stepScale(p.interfaceScale, action === "zoomIn" ? 1 : -1),
            }));
          }
          break;
        }
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
        case "searchSessions":
          if (wsRef.current.tabs.some((t) => panesOf(t.layout).some((id) => wsRef.current.panes[id]?.target.kind !== "sftp"))) setSearchingSessions(true);
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
        // privilege prompts (KEY-18): opens the confirmation; nothing is typed until the user confirms.
        case "insertPassword": {
          const p = activePane(wsRef.current);
          const handle = p ? handles.current.get(p.id) : undefined;
          const sessionId = handle?.connected() ? handle.sessionId() : null;
          if (p && sessionId && p.target.kind === "ssh") setInserting({ sessionId, hostId: p.target.hostId });
          else notify("info", msgP.insert.needsSsh);
          break;
        }
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
        case "previousCommand":
          focusedHandle()?.jumpCommand(-1);
          break;
        case "nextCommand":
          focusedHandle()?.jumpCommand(1);
          break;
        case "movePaneDown":
          moveFocused("down");
          break;
        case "nextPane":
          setWs((current) => cyclePane(current, 1));
          break;
        case "prevPane":
          setWs((current) => cyclePane(current, -1));
          break;
        case "goToTab1":
        case "goToTab2":
        case "goToTab3":
        case "goToTab4":
        case "goToTab5":
        case "goToTab6":
        case "goToTab7":
        case "goToTab8":
        case "goToLastTab": {
          const tabs = wsRef.current.tabs;
          const target = action === "goToLastTab" ? tabs.at(-1) : tabs[Number(action.slice(-1)) - 1];
          if (target) setWs((current) => selectTab(current, target.id));
          break;
        }
        case "reopenClosedTab": {
          const current = wsRef.current;
          const last = current.closedTabs?.at(-1);
          if (!last) {
            notify("info", msgC.tabs.nothingClosed);
            break;
          }
          const next = reopenClosedTab(current, seedFor);
          if (next === current) notify("danger", msgC.layouts.full(last.panes.length));
          else setWs(next);
          break;
        }
        case "focusTerminal":
          focusedHandle()?.focus();
          break;
        case "focusSidebar":
          setCollapsed(false);
          // After the sidebar has expanded.
          window.requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(".sidebar [aria-current='page'], .sidebar button")?.focus(),
          );
          break;
        default:
          break;
      }
    },
    [openLocal, closeFocused, split, focusedHandle, moveFocus, moveFocused, navigate, notify, seedFor],
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
  const sftpVisible = pane?.target.kind === "sftp";
  const showPanel = sidePanel !== null && terminalVisible && !sftpVisible;
  const filesSession =
    pane?.target.kind === "ssh" && paneStatus?.state === "connected" ? (focusedHandle()?.sessionId() ?? null) : null;
  // server at a glance: SSH sessions only (a negotiated SSH connection; never Telnet or serial).
  const glanceTarget =
    filesSession && pane?.target.kind === "ssh" && paneStatus?.security
      ? { sessionId: filesSession, hostId: pane.target.hostId, label: pane.label }
      : null;

  // agent D: inventory and snippets
  // Every pane's session state: changes on the session events that connect, drop or close a pane.
  const sessionsVersion = Object.values(ws.panes)
    .map((p) => `${p.id}:${statuses[p.id]?.state ?? ""}`)
    .join(",");
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
      version: sessionsVersion,
    }),
    [connect, sessionsVersion],
  );

  // Stable callbacks and memoized props: the sidebar, tab strip, status bar, pages and the pane
  // grid are memoized, so state that only one of them shows (the palette, a dialog, the sidebar
  // collapsing) does not re-render all of them, and every terminal with them.
  const bindings = workspacePrefs(prefs.workspace).bindings;
  const selectTabById = useCallback((id: number | null) => setWs((current) => selectTab(current, id)), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const toggleCollapsed = useCallback(() => setCollapsed((v) => !v), []);
  const lock = useCallback(() => void vault.lock().catch(() => undefined), []);
  const closeTabById = useCallback((id: number) => setWs((current) => closeTab(current, id)), []);
  const closeOthers = useCallback((id: number) => setWs((current) => closeOtherTabs(current, id)), []);
  const renameTabById = useCallback((id: number, title: string) => setWs((current) => renameTab(current, id, title)), []);
  const moveTabTo = useCallback((from: number, to: number) => setWs((current) => moveTab(current, from, to)), []);
  const splitTab = useCallback(
    (id: number, dir: Direction) => {
      const t = wsRef.current.tabs.find((x) => x.id === id);
      if (!t) return;
      setWs((current) => selectTab(current, id));
      split(dir, undefined, t.focused);
    },
    [split],
  );
  const detachById = useCallback((id: number) => void detachTab(id), [detachTab]);
  const saveAs = useCallback(() => setSavingAs(true), []);
  const saveCurrent = useCallback(() => void saveLayout(), [saveLayout]);
  const recentValue = data.recent.value;
  const recentItems = useMemo(
    () => (recentValue ?? []).map((h) => ({ id: h.id, label: h.label, detail: hostIdentity(h), onSelect: () => connect(h) })),
    [recentValue, connect],
  );
  const templateName = ws.template?.name ?? null;
  const layoutDirty = ws.template ? templateDirty(ws) : false;
  const layoutInfo = useMemo(
    () => (templateName !== null ? { name: templateName, dirty: layoutDirty, onSave: saveCurrent, onSaveAs: saveAs } : null),
    [templateName, layoutDirty, saveCurrent, saveAs],
  );
  const toggleTheme = useCallback(() => update((p) => ({ ...p, theme: resolvedTheme === "dark" ? "light" : "dark" })), [update, resolvedTheme]);
  const toggleSnippets = useCallback(() => runAction("toggleSnippets"), [runAction]);
  const toggleFiles = useCallback(() => togglePanel("files"), [togglePanel]);
  const toggleServer = useCallback(() => togglePanel("server"), [togglePanel]);
  const toggleNotes = useCallback(() => togglePanel("notes"), [togglePanel]);
  const stopActiveBroadcast = useCallback(() => {
    const t = activeTab(wsRef.current);
    if (!t) return;
    stopBroadcast(t.id);
  }, [stopBroadcast]);
  const closeSidePanel = useCallback(() => {
    setSidePanel(null);
    focusedHandle()?.focus();
  }, [focusedHandle]);
  const openKnownHosts = useCallback(() => navigate("knownHosts"), [navigate]);
  const onPatch = useCallback(
    (paneId: number, patch: Parameters<typeof patchPane>[2]) => setWs((current) => patchPane(current, paneId, patch)),
    [],
  );
  const onStatus = useCallback((paneId: number, status: PaneStatus) => setStatuses((current) => ({ ...current, [paneId]: status })), []);
  const onPaneFocus = useCallback((paneId: number) => setWs((current) => focusPaneInActiveTab(current, paneId)), []);
  const onPaneUnread = useCallback((paneId: number) => setWs((current) => markUnread(current, paneId)), []);
  const onSelectPane = useCallback((paneId: number) => setWs((current) => focusPane(current, paneId)), []);
  const onSwap = useCallback((a: number, b: number) => setWs((current) => swapPanes(current, a, b)), []);
  const onFocusMode = useCallback((tabId: number, on: boolean) => setWs((current) => setFocusMode(current, tabId, on)), []);
  const onToNewTab = useCallback((paneId: number) => setWs((current) => paneToNewTab(current, paneId)), []);
  const onConnectPanes = useCallback((paneIds: number[]) => setWs((current) => connectPanes(current, paneIds)), []);
  const onClosePane = useCallback((paneId: number) => {
    setWs((current) => closePane(current, paneId));
    setStatuses((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
  }, []);
  const onSplitPane = useCallback((paneId: number, dir: Direction) => split(dir, undefined, paneId), [split]);
  const onRatio = useCallback(
    (tabId: number, path: ("a" | "b")[], ratio: number) => setWs((current) => setRatio(current, tabId, path, ratio)),
    [],
  );
  const register = useCallback((paneId: number, handle: PaneHandle | null) => {
    if (handle) handles.current.set(paneId, handle);
    else handles.current.delete(paneId);
  }, []);
  const zoomFocused = useCallback((step: "in" | "out" | "reset") => focusedHandle()?.zoom(step), [focusedHandle]);
  // tmux and screen session awareness (P-31): typed into the focused pane only.
  const attachInFocused = useCallback(
    (session: Parameters<PaneHandle["attachMultiplexer"]>[0]) => {
      const handle = focusedHandle();
      if (handle?.attachMultiplexer(session)) {
        notify("success", msgMx.attachedNotice(session.name));
        handle.focus();
      }
    },
    [focusedHandle, notify],
  );
  const openSftpForHost = useCallback((host: HostSummary) => openSftpHost(host), [openSftpHost]);
  const openSftpForHosts = useCallback((list: HostSummary[]) => openSftpHosts(list), [openSftpHosts]);
  const pasteFocused = useCallback((text: string) => focusedHandle()?.reviewPaste(text), [focusedHandle]);
  // The files panel's other connected sessions; computed only while that panel shows.
  const filesOthers = useMemo(
    () =>
      showPanel && sidePanel === "files"
        ? Object.values(ws.panes).flatMap((p) => {
            const id = p.target.kind === "ssh" && statuses[p.id]?.state === "connected" ? handles.current.get(p.id)?.sessionId() : null;
            return id && id !== filesSession ? [{ sessionId: id, label: p.label }] : [];
          })
        : [],
    [showPanel, sidePanel, ws.panes, statuses, filesSession],
  );
  // The side panel, rebuilt only when what it shows changes. `bindings`: the panels show shortcut labels.
  const sidePanelElement = useMemo(() => {
    if (!showPanel) return null;
    if (sidePanel === "server") {
      // server at a glance: SSH sessions only (a negotiated SSH connection; never Telnet or serial).
      const glance =
        filesSession && pane?.target.kind === "ssh" && paneStatus?.security
          ? { sessionId: filesSession, hostId: pane.target.hostId, label: pane.label }
          : null;
      return <ServerPanel target={glance} onAttach={attachInFocused} onClose={closeSidePanel} />;
    }
    if (sidePanel === "files") {
      return (
        <FilesPanel
          target={filesSession && pane ? { sessionId: filesSession, label: pane.label } : null}
          onOpenSftp={pane?.target.kind === "ssh" ? (path: string | null) => pane.target.kind === "ssh" && openSftpHost({ id: pane.target.hostId, label: pane.label }, path) : undefined}
          others={filesOthers}
          onClose={closeSidePanel}
        />
      );
    }
    if (sidePanel === "notes") {
      return (
        <NotesPanel
          host={pane?.target.kind === "ssh" ? { id: pane.target.hostId, label: pane.label } : null}
          onPaste={pane?.target.kind === "ssh" && paneStatus?.state === "connected" ? pasteFocused : undefined}
          onClose={closeSidePanel}
        />
      );
    }
    return (
      <ConnectionPanel
        section={panelSection}
        onSection={setPanelSection}
        hostId={pane?.target.kind === "ssh" ? pane.target.hostId : null}
        onConnect={connect}
        onZoom={zoomFocused}
        target={pane && paneStatus?.state === "connected" ? { label: pane.label, identity: pane.identity } : null}
        onSend={requestSnippet}
        onClose={closeSidePanel}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPanel, sidePanel, filesSession, pane, paneStatus, filesOthers, panelSection, connect, zoomFocused, pasteFocused, requestSnippet, closeSidePanel, attachInFocused, openSftpHost, bindings]);

  return (
    // agent D: snippet runs on several sessions read this window's open SSH sessions.
    <SnippetRunContext.Provider value={snippetRunHost}>
    <div className="shell" data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <Sidebar
        destination={terminalVisible ? null : destination}
        collapsed={collapsed}
        onNavigate={navigate}
        onOpenPalette={openPalette}
        onLocalTerminal={openLocal}
        onSftp={openSftp}
        onToggleCollapsed={toggleCollapsed}
        onLock={lock}
        onOpenAbout={openAbout}
        shortcuts={bindings}
        hostCount={data.hosts.value?.length ?? 0}
        snippetCount={data.snippets.value?.length ?? 0}
      />
      {!collapsed && <ResizeHandle panel="sidebar" />}

      <div className="main">
        <TabStrip
          ws={ws}
          destination={destination}
          renaming={renaming}
          onRenaming={setRenaming}
          onSelect={selectTabById}
          onClose={closeTabById}
          onCloseOthers={closeOthers}
          onRename={renameTabById}
          onMove={moveTabTo}
          onSplit={splitTab}
          onDuplicate={duplicate}
          onDetach={detachById}
          onNewLocal={openLocal}
          onNewSftp={openSftp}
          onOpenPalette={openPalette}
          finished={finished}
          recent={recentItems}
          layout={layoutInfo}
          production={productionPanes}
          shortcuts={bindings}
        />
        {/* terminal notifications (P-23): announced to assistive technology as well */}
        <div className="visually-hidden" role="status" data-testid="command-finished">
          {finishedNotice}
        </div>

        <main className="content" aria-label={terminalVisible && tab ? tabTitle(ws, tab) : msg.nav[destination]}>
          {!terminalVisible && destination === "hosts" && <HostsView ws={ws} onConnect={connect} onQuickConnect={quickConnect} onConnectMany={connectMany} onConnectSplit={connectSplit} onOpenSftp={openSftpForHost} onOpenSftpMany={openSftpForHosts} onLocal={openLocal} />}
          {!terminalVisible && destination === "snippets" && <SnippetsView />}
          {!terminalVisible && destination === "keychain" && <KeychainView />}
          {!terminalVisible && destination === "knownHosts" && <KnownHostsView />}
          {!terminalVisible && destination === "settings" && <SettingsView key={settingsAt?.n ?? 0} initialSection={settingsAt?.section} onOpenKeychain={() => navigate("keychain")} />}
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
          {!terminalVisible && destination === "recordings" && <RecordingsView />}

          {/* Terminals stay mounted while hidden so their screen state and session survive tab switches. */}
          <Suspense fallback={null}>
            {ws.tabs.length > 0 && (
              <PaneGrid
                ws={ws}
                prefs={prefs.terminal}
                workspace={workspacePrefs(prefs.workspace)}
                panel={sidePanelElement}
                onPatch={onPatch}
                onStatus={onStatus}
                onFocus={onPaneFocus}
                onUnread={onPaneUnread}
                onSelectPane={onSelectPane}
                onSwap={onSwap}
                onFocusMode={onFocusMode}
                onToNewTab={onToNewTab}
                onConnect={onConnectPanes}
                onClose={onClosePane}
                onQuickSaved={onQuickSaved}
                onSplit={onSplitPane}
                onRatio={onRatio}
                onOpenKnownHosts={openKnownHosts}
                register={register}
                broadcasting={broadcasting}
                broadcastPaneIds={broadcastPaneIds}
                onUserInput={relayInput}
                production={productionPanes}
              />
            )}
          </Suspense>
        </main>

        <StatusBar
          pane={terminalVisible && !sftpVisible ? pane : null}
          status={terminalVisible && !sftpVisible ? paneStatus : undefined}
          panelOpen={panelOpen}
          onTogglePanel={terminalVisible && !sftpVisible ? toggleSnippets : undefined}
          filesOpen={sidePanel === "files"}
          onToggleFiles={terminalVisible && !sftpVisible ? toggleFiles : undefined}
          serverOpen={sidePanel === "server"}
          onToggleServer={terminalVisible && !sftpVisible && (glanceTarget || sidePanel === "server") ? toggleServer : undefined}
          notesOpen={sidePanel === "notes"}
          onToggleNotes={terminalVisible && !sftpVisible ? toggleNotes : undefined}
          theme={resolvedTheme}
          onToggleTheme={toggleTheme}
          broadcast={terminalVisible && tab ? members.get(tab.id)?.size : undefined}
          onStopBroadcast={stopActiveBroadcast}
          shortcuts={bindings}
        />
      </div>

      {pickingSplit && (
        <CommandPalette
          onSftpHost={(host) => openSftpHost(host)}
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
          onSftpHost={(host) => openSftpHost(host)}
          hasTerminal={terminalVisible && pane !== null && !sftpVisible}
          terminalConnected={paneStatus?.state === "connected"}
          onClose={() => {
            setPaletteOpen(false);
            if (terminalVisible) focusedHandle()?.focus();
          }}
          onConnect={connect}
          onConnectSplit={connectSplit}
          onNavigate={navigate}
          onAction={runAction}
          onToggleTheme={toggleTheme}
          onLocal={openLocal}
          onSftp={openSftp}
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
          onRunAllOpen={snippetRunHost.sessions().length > 0 ? () => setRunAllOpen(true) : undefined}
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
          // privilege prompts (KEY-18)
          // security review (P-27)
          onSecurityReview={() => {
            navigate("settings");
            setSettingsAt((current) => ({ section: "review", n: (current?.n ?? 0) + 1 }));
          }}
          onInsertPassword={pane?.target.kind === "ssh" && paneStatus?.state === "connected" ? () => runAction("insertPassword") : undefined}
          onConnectionLog={
            pane?.target.kind === "ssh" && focusedHandle()?.sessionId()
              ? () => {
                  const sessionId = focusedHandle()?.sessionId();
                  if (sessionId) setConnectionLog({ sessionId, label: pane.label });
                }
              : undefined
          }
          onContainers={
            pane?.target.kind === "ssh" && paneStatus?.state === "connected"
              ? () => {
                  const sessionId = focusedHandle()?.sessionId();
                  if (sessionId) setContainersOf({ sessionId, label: pane.label });
                }
              : undefined
          }
          onSearchSessions={ws.tabs.length > 0 ? () => setSearchingSessions(true) : undefined}
          onCommandOutput={pane && focusedHandle()?.commands().length ? () => setOutputFor(pane.id) : undefined}
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

      {/* privilege prompts (KEY-18) */}
      {inserting && (
        <InsertPasswordDialog
          sessionId={inserting.sessionId}
          hostLabel={data.hosts.value?.find((h) => h.id === inserting.hostId)?.label ?? ""}
          onClose={() => {
            setInserting(null);
            focusedHandle()?.focus();
          }}
          onInserted={(identity) => {
            setInserting(null);
            notify("success", msgP.insert.done(identity.label));
            focusedHandle()?.focus();
          }}
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

      {savingAs && (
        <SaveLayoutDialog
          initialName={ws.template?.name ?? ""}
          summary={((saved) => msgC.layouts.summary(saved.length, saved.reduce((n, t) => n + t.panes.length, 0)))(templateTabs(ws))}
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

      {searchingSessions && (
        <SearchSessionsDialog
          tabs={ws.tabs.map((t) => ({
            tabId: t.id,
            title: tabTitle(ws, t),
            panes: panesOf(t.layout).flatMap((paneId) => {
              const handle = handles.current.get(paneId);
              const p = ws.panes[paneId];
              // Terminals only: an SFTP tab has no scrollback to search.
              return handle && p && p.target.kind !== "sftp" ? [{ paneId, label: p.label, handle }] : [];
            }),
          }))}
          onReveal={(paneId, match) => {
            setSearchingSessions(false);
            setWs((current) => focusPane(current, paneId));
            // After the tab is in front and laid out.
            window.requestAnimationFrame(() =>
              window.requestAnimationFrame(() => {
                const handle = handles.current.get(paneId);
                handle?.revealMatch(match);
                handle?.focus();
              }),
            );
          }}
          onClose={() => {
            setSearchingSessions(false);
            focusedHandle()?.focus();
          }}
        />
      )}

      {reviewing && (
        <BroadcastReview
          targets={reviewing.targets}
          production={productionPanes}
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
              const production = [...confirmed.keys()].filter((id) => productionPanes.has(id));
              if (confirmed.size >= 2 && production.length > 0) {
                // Production panes join only after their own confirmation, naming the hosts (P-26).
                setConfirmBroadcast({ tabId, confirmed, production });
                return;
              }
              if (confirmed.size >= 2) setMembers((current) => withTab(current, tabId, confirmed));
            }
            focusedHandle()?.focus();
          }}
        />
      )}

      {confirmBroadcast && (
        <ProductionConfirm
          title={msgProduction.broadcastTitle}
          body={msgProduction.broadcastBody}
          confirmLabel={msgProduction.broadcastConfirm}
          hosts={[...new Set(confirmBroadcast.production.map((p) => productionPanes.get(p) ?? ""))].filter(Boolean)}
          onCancel={() => {
            setConfirmBroadcast(null);
            focusedHandle()?.focus();
          }}
          onConfirm={() => {
            const { tabId, confirmed } = confirmBroadcast;
            setConfirmBroadcast(null);
            // The same rules as any broadcast: pruned if a pane leaves, reconnects or stops.
            setMembers((current) => withTab(current, tabId, confirmed));
            focusedHandle()?.focus();
          }}
        />
      )}

      {outputFor !== null && handles.current.get(outputFor) && (
        <CommandOutputDialog
          handle={handles.current.get(outputFor) as PaneHandle}
          label={ws.panes[outputFor]?.label ?? ""}
          onClose={() => {
            setOutputFor(null);
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

      {containersOf && (
        <ContainersDialog
          sessionId={containersOf.sessionId}
          host={containersOf.label}
          onOpen={(engine, container) => {
            const name = container.name || container.id.slice(0, 12);
            open(
              { kind: "container", sessionId: containersOf.sessionId, engine, containerId: container.id },
              msgD.containers.tabLabel(name),
              msgD.containers.identity(containersOf.label, engineName(engine)),
            );
            setContainersOf(null);
          }}
          onClose={() => {
            setContainersOf(null);
            focusedHandle()?.focus();
          }}
        />
      )}

      {connectionLog && (
        <ConnectionLogDialog
          sessionId={connectionLog.sessionId}
          title={connectionLog.label}
          onClose={() => {
            setConnectionLog(null);
            focusedHandle()?.focus();
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

      {runAllOpen && <MultiRunDialog snippet={null} allOpen onClose={() => setRunAllOpen(false)} />}

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

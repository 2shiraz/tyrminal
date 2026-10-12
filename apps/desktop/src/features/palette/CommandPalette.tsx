import type { HostSummary, LayoutTemplateSummary, SnippetSummary } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import type { Destination } from "../../app/AppShell";
import type { Arrangement, Direction } from "../../app/workspace";
import { useVaultData } from "../../app/vaultData";
import { Avatar, Keys, Shortcut } from "../../components/ui/controls";
import { openedBy } from "../../lib/inputModality";
import {
  // agent B: tunnels and history
  IconRoute,
  IconArrowLeftRight,
  IconColumns2,
  IconCornerDownLeft,
  IconFingerprint,
  IconAppWindow,
  IconArrowUpRight,
  IconCopy,
  IconHardDrive,
  IconLayoutGrid,
  IconLayoutTemplate,
  IconSave,
  IconTrash2,
  IconMaximize2,
  IconMinimize2,
  IconKeyRound,
  IconLock,
  IconPlay,
  IconRadio,
  IconRows2,
  IconScrollText,
  IconSearch,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconSidebar,
  IconSquareTerminal,
  IconSun,
  IconType,
  IconX,
  IconZoomIn,
  IconZoomOut,
  IconHistory,
} from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { msgD } from "../../lib/messages-d";
import { msgRuns } from "../../lib/messages-runs";
import { msgOutput } from "../../lib/messages-output";
import { msgSelect } from "../../lib/messages-select";
import { isMac, keyLabels } from "../../lib/platform";
import type { ActionId } from "../../lib/shortcuts";
// privilege prompts (KEY-18)
import { msgP } from "../../lib/messages-privilege";
// security review (P-27)
import { msgSR } from "../../lib/messages-security-review";
import { requestShortcutsSection } from "../layouts/WorkspaceSettings";
import { msgSftp } from "../sftp/messages";

/** A palette entry; other features contribute entries through the `extra` prop. */
export type PaletteItem = Item;

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string | undefined;
  icon: ReactNode;
  shortcut?: ActionId | undefined;
  keywords?: string | undefined;
  run: () => void;
  /** Hosts: Cmd/Ctrl+Enter opens in a split, Shift+Enter in SFTP. */
  runSplit?: (() => void) | undefined;
  runSftp?: (() => void) | undefined;
}

/**
 * Subsequence match with a score that favors consecutive and word-start matches. `quality` is the
 * match alone; `score` also prefers shorter text, to rank items that match equally well.
 */
export function fuzzyScore(needle: string, haystack: string): { score: number; quality: number; positions: number[] } | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return { score: 0, quality: 0, positions: [] };
  let score = 0;
  let last = -2;
  const positions: number[] = [];
  let from = 0;
  for (const ch of n) {
    const index = h.indexOf(ch, from);
    if (index < 0) return null;
    const wordStart = index === 0 || /[\s@./:_-]/.test(h[index - 1] ?? "");
    score += index === last + 1 ? 5 : wordStart ? 3 : 1;
    positions.push(index);
    last = index;
    from = index + 1;
  }
  return { score: score - h.length * 0.01, quality: score, positions };
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) =>
        // Characters of one label; position is the identity.
        set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>,
      )}
    </>
  );
}

export function CommandPalette({
  hasTerminal,
  terminalConnected,
  onClose,
  onConnect,
  onConnectSplit,
  onNavigate,
  onAction,
  onToggleTheme,
  onLocal,
  onSftp,
  onSftpHost,
  onSnippet,
  onDeployKey,
  broadcast,
  onToggleBroadcast,
  workspace,
  layouts,
  pick,
  openTabs,
  extra,
  onShellIntegration,
  onInsertPassword,
  onSecurityReview,
  onConnectionLog,
  onContainers,
  onSearchSessions,
  onCommandOutput,
  onRunAllOpen,
}: {
  hasTerminal: boolean;
  terminalConnected: boolean;
  onClose: () => void;
  onConnect: (host: HostSummary) => void;
  /** Cmd/Ctrl+Enter on a host: beside the focused pane. */
  onConnectSplit?: ((host: HostSummary) => void) | undefined;
  onNavigate: (d: Destination) => void;
  onAction: (a: ActionId) => void;
  onToggleTheme: () => void;
  onLocal: () => void;
  /** Opens a new SFTP tab. */
  onSftp?: (() => void) | undefined;
  /** "SFTP: <host>": that host in an SFTP tab (SSH hosts only). */
  onSftpHost?: ((host: HostSummary) => void) | undefined;
  onSnippet: (s: SnippetSummary) => void;
  /** Present only when the focused pane is a connected SSH session. */
  onDeployKey?: (() => void) | undefined;
  /** Whether the active tab broadcasts input; toggle offered only for split, connected tabs. */
  broadcast?: boolean | undefined;
  onToggleBroadcast?: (() => void) | undefined;
  /** Tab and pane actions for the tab in front (absent on a page). */
  workspace?:
    | {
        split: boolean;
        focusLayout: boolean;
        onDuplicate: () => void;
        onArrange: (arrangement: Arrangement) => void;
        onPaneToNewTab: () => void;
        onSplitWith: (dir: Direction) => void;
        onEncoding: () => void;
        onDetach: () => void;
      }
    | undefined;
  /** Saved layout templates and the actions on them. */
  layouts?:
    | {
        list: LayoutTemplateSummary[];
        current: string | null;
        canSave: boolean;
        onOpen: (layout: LayoutTemplateSummary) => void;
        onSave: () => void;
        onSaveAs: () => void;
        onDelete: (layout: LayoutTemplateSummary) => void;
      }
    | undefined;
  /** Open tabs, so the palette can switch to one by name or destination. */
  openTabs?: { id: number; title: string; detail: string; onSelect: () => void }[] | undefined;
  /** Further actions contributed by other features (listed after the built-in actions). */
  extra?: PaletteItem[] | undefined;
  /** Picking mode: only destinations are listed, and choosing one calls `onPick`. */
  pick?: { title: string; onPick: (choice: HostSummary | "local") => void } | undefined;
  /** Shell integration setup; present when the focused pane is a connected terminal (SSH or local). */
  onShellIntegration?: (() => void) | undefined;
  // privilege prompts (KEY-18)
  /** Present only when the focused pane is a connected SSH session. */
  onInsertPassword?: (() => void) | undefined;
  // security review (P-27)
  /** Opens Settings at the security review. */
  onSecurityReview?: (() => void) | undefined;
  /** The focused SSH pane's connection log; present when it has a session. */
  onConnectionLog?: (() => void) | undefined;
  /** P-33: containers on the focused connected SSH pane's host. */
  onContainers?: (() => void) | undefined;
  /** P-28: search every open terminal's scrollback; present while any terminal is open. */
  onSearchSessions?: (() => void) | undefined;
  /** P-29: copy or save a command's output; present only when the focused pane has command marks. */
  onCommandOutput?: (() => void) | undefined;
  /** SNP-07: run a snippet on every open SSH session of this window; present while any is open. */
  onRunAllOpen?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // From the keyboard (Ctrl+K) the palette is simply there; from the sidebar search it enters.
  const [opened] = useState(openedBy);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { hosts, snippets, recent } = useVaultData();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    return () => dialog?.close();
  }, []);

  const items = useMemo<Item[]>(() => {
    const hostAlternatives = (host: HostSummary) => ({
      runSplit: onConnectSplit ? () => onConnectSplit(host) : undefined,
      runSftp: onSftpHost && host.protocol.type === "ssh" ? () => onSftpHost(host) : undefined,
    });
    const list: Item[] = [];
    if (pick) {
      for (const host of hosts.value ?? []) {
        list.push({
          id: `host-${host.id}`,
          group: msg.palette.groupHosts,
          label: host.label,
          detail: msg.hosts.destination(host.username, host.address, host.port),
          keywords: `${host.address} ${host.username}`,
          icon: <Avatar label={host.label} size="sm" />,
          run: () => pick.onPick(host),
        });
      }
      list.push({ id: "local", group: msg.palette.groupActions, label: msg.nav.localTerminal, icon: <IconSquareTerminal size={16} />, run: () => pick.onPick("local") });
      return list;
    }
    // agent C: workspaces — open tabs first, then recent connections (UX-03, UX-04).
    for (const t of openTabs ?? []) {
      list.push({
        id: `tab-${t.id}`,
        group: msgC.palette.groupTabs,
        label: t.title,
        detail: t.detail,
        keywords: t.detail,
        icon: <IconSquareTerminal size={16} />,
        run: t.onSelect,
      });
    }
    const recentIds = new Set<string>();
    for (const host of (recent.value ?? []).slice(0, 5)) {
      recentIds.add(host.id);
      list.push({
        id: `recent-${host.id}`,
        group: msgC.palette.groupRecent,
        label: host.label,
        detail: msg.hosts.destination(host.username, host.address, host.port),
        keywords: `${host.address} ${host.username}`,
        icon: <Avatar label={host.label} size="sm" />,
        run: () => onConnect(host),
        ...hostAlternatives(host),
      });
    }
    for (const host of hosts.value ?? []) {
      if (recentIds.has(host.id)) continue;
      list.push({
        id: `host-${host.id}`,
        group: msg.palette.groupHosts,
        label: host.label,
        detail: msg.hosts.destination(host.username, host.address, host.port),
        keywords: `${host.address} ${host.username}`,
        icon: <Avatar label={host.label} size="sm" />,
        run: () => onConnect(host),
        ...hostAlternatives(host),
      });
    }
    if (hasTerminal && terminalConnected) {
      for (const snippet of snippets.value ?? []) {
        list.push({
          id: `snippet-${snippet.id}`,
          group: msg.palette.groupSnippets,
          label: snippet.name,
          detail: snippet.folder || undefined,
          keywords: snippet.text.slice(0, 200),
          icon: <IconPlay size={16} />,
          run: () => onSnippet(snippet),
        });
      }
    }

    const action = (id: string, label: string, icon: ReactNode, run: () => void, shortcut?: ActionId): Item => ({
      id,
      group: msg.palette.groupActions,
      label,
      icon,
      run,
      shortcut,
    });
    list.push(action("local", msg.nav.localTerminal, <IconSquareTerminal size={16} />, onLocal, "newLocal"));
    if (onSftp) list.push({ ...action("sftp", msgSftp.open, <IconArrowLeftRight size={16} />, onSftp), keywords: `files transfer ${msgSftp.openHint}` });
    if (onSftpHost)
      for (const host of hosts.value ?? []) {
        if (host.protocol.type !== "ssh") continue;
        list.push({ ...action(`sftp-${host.id}`, msgSftp.openInHost(host.label), <IconArrowLeftRight size={16} />, () => onSftpHost(host)), keywords: `files transfer ${host.address}` });
      }
    if (hasTerminal) {
      list.push(action("split-right", msg.palette.splitRight, <IconColumns2 size={16} />, () => onAction("splitRight"), "splitRight"));
      list.push(action("split-down", msg.palette.splitDown, <IconRows2 size={16} />, () => onAction("splitDown"), "splitDown"));
      list.push(action("find", msg.palette.find, <IconSearch size={16} />, () => onAction("find"), "find"));
      list.push(action("snippets", msg.palette.toggleSnippets, <IconScrollText size={16} />, () => onAction("toggleSnippets"), "toggleSnippets"));
      list.push(action("files", msg.palette.toggleFiles, <IconHardDrive size={16} />, () => onAction("toggleFiles"), "toggleFiles"));
      list.push(action("zoom-in", msg.palette.zoomIn, <IconZoomIn size={16} />, () => onAction("zoomIn"), "zoomIn"));
      list.push(action("zoom-out", msg.palette.zoomOut, <IconZoomOut size={16} />, () => onAction("zoomOut"), "zoomOut"));
      list.push(action("zoom-reset", msg.palette.zoomReset, <IconZoomIn size={16} />, () => onAction("zoomReset"), "zoomReset"));
      list.push(action("close-pane", msg.palette.closePane, <IconX size={16} />, () => onAction("closePane"), "closePane"));
      // agent D: inventory and snippets
      if (terminalConnected) list.push(action("suggest", msgD.suggest.palette, <IconSearch size={16} />, () => onAction("suggest"), "suggest"));
      if (onShellIntegration) list.push(action("shell-integration", msgD.integration.palette, <IconSquareTerminal size={16} />, onShellIntegration));
      if (onConnectionLog) list.push(action("connection-log", msgD.connectionLog.palette, <IconScrollText size={16} />, onConnectionLog));
      if (onContainers) list.push(action("containers", msgD.containers.palette, <IconSquareTerminal size={16} />, onContainers));
      if (onCommandOutput) list.push(action("command-output", msgOutput.paletteOutput, <IconScrollText size={16} />, onCommandOutput));
    }
    // agent C: workspaces
    if (workspace) {
      list.push(action("split-right-with", msgC.panes.splitRightWith, <IconColumns2 size={16} />, () => workspace.onSplitWith("row")));
      list.push(action("split-down-with", msgC.panes.splitDownWith, <IconRows2 size={16} />, () => workspace.onSplitWith("column")));
      list.push(action("duplicate-tab", msgC.tabs.duplicate, <IconCopy size={16} />, workspace.onDuplicate));
      list.push(action("encoding", msgC.encoding.action, <IconType size={16} />, workspace.onEncoding));
      list.push(action("detach-tab", msgC.detach.action, <IconAppWindow size={16} />, workspace.onDetach));
      if (workspace.split) {
        list.push(
          action(
            "focus-layout",
            workspace.focusLayout ? msgC.panes.leaveFocus : msgC.panes.focusLayout,
            workspace.focusLayout ? <IconMinimize2 size={16} /> : <IconMaximize2 size={16} />,
            () => onAction("toggleFocusLayout"),
            "toggleFocusLayout",
          ),
        );
        list.push(action("arrange-grid", msgC.panes.arrangeGrid, <IconLayoutGrid size={16} />, () => workspace.onArrange("grid")));
        list.push(action("arrange-columns", msgC.panes.arrangeColumns, <IconColumns2 size={16} />, () => workspace.onArrange("columns")));
        list.push(action("arrange-rows", msgC.panes.arrangeRows, <IconRows2 size={16} />, () => workspace.onArrange("rows")));
        list.push(action("pane-new-tab", msgC.panes.toNewTab, <IconArrowUpRight size={16} />, workspace.onPaneToNewTab));
      }
    }
    if (layouts) {
      const panes = (l: LayoutTemplateSummary) => l.tabs.reduce((n, t) => n + t.panes.length, 0);
      for (const layout of layouts.list) {
        list.push({
          id: `layout-${layout.id}`,
          group: msgC.layouts.group,
          label: msgC.layouts.open(layout.name),
          detail: msgC.layouts.summary(layout.tabs.length, panes(layout)),
          icon: <IconLayoutTemplate size={16} />,
          run: () => layouts.onOpen(layout),
        });
      }
      if (layouts.canSave) {
        list.push({
          id: "layout-save",
          group: msgC.layouts.group,
          label: layouts.current ? msgC.layouts.saveNamed(layouts.current) : msgC.layouts.saveAs,
          icon: <IconSave size={16} />,
          run: layouts.current ? layouts.onSave : layouts.onSaveAs,
        });
        if (layouts.current)
          list.push({ id: "layout-save-as", group: msgC.layouts.group, label: msgC.layouts.saveAs, icon: <IconSave size={16} />, run: layouts.onSaveAs });
      }
      for (const layout of layouts.list) {
        list.push({
          id: `layout-delete-${layout.id}`,
          group: msgC.layouts.group,
          label: msgC.layouts.delete(layout.name),
          icon: <IconTrash2 size={16} />,
          run: () => layouts.onDelete(layout),
        });
      }
    }
    if (onSearchSessions) list.push(action("search-sessions", msgOutput.paletteSearch, <IconSearch size={16} />, onSearchSessions, "searchSessions"));
    if (onRunAllOpen) list.push(action("run-all-open", msgRuns.paletteRunAllOpen, <IconPlay size={16} />, onRunAllOpen));
    if (onToggleBroadcast)
      list.push(action("broadcast", broadcast ? msg.palette.broadcastOff : msg.palette.broadcastOn, <IconRadio size={16} />, onToggleBroadcast));
    if (onDeployKey) list.push(action("deploy-key", msg.palette.deployKey, <IconKeyRound size={16} />, onDeployKey));
    // privilege prompts (KEY-18)
    if (onInsertPassword) list.push(action("insert-password", msgP.insert.palette, <IconKeyRound size={16} />, onInsertPassword, "insertPassword"));
    list.push(action("theme", msg.palette.toggleTheme, <IconSun size={16} />, onToggleTheme));
    list.push(action("sidebar", msg.palette.toggleSidebar, <IconSidebar size={16} />, () => onAction("toggleSidebar"), "toggleSidebar"));
    list.push(action("lock", msg.nav.lock, <IconLock size={16} />, () => onAction("lock"), "lock"));
    const nav = (d: Destination, icon: ReactNode, shortcut?: ActionId): Item => ({
      id: `nav-${d}`,
      group: msg.palette.groupNavigate,
      label: msg.nav[d],
      icon,
      shortcut,
      run: () => onNavigate(d),
    });
    list.push(nav("hosts", <IconServer size={16} />));
    list.push(nav("snippets", <IconScrollText size={16} />));
    list.push(nav("keychain", <IconKeyRound size={16} />));
    list.push(nav("knownHosts", <IconFingerprint size={16} />));
    list.push(nav("settings", <IconSettings size={16} />, "settings"));
    list.push({
      id: "nav-shortcuts",
      group: msg.palette.groupNavigate,
      label: msgC.keys.title,
      keywords: "keybindings keys hotkeys",
      icon: <IconSettings size={16} />,
      run: () => {
        requestShortcutsSection();
        onNavigate("settings");
      },
    });
    // agent B: tunnels and history
    list.push(nav("tunnels", <IconRoute size={16} />));
    // security review (P-27)
    if (onSecurityReview) {
      list.push({
        id: "nav-security-review",
        group: msg.palette.groupNavigate,
        label: msgSR.title,
        keywords: "audit weak keys passwords certificates known hosts",
        icon: <IconShieldCheck size={16} />,
        run: onSecurityReview,
      });
    }
    list.push(nav("recordings", <IconHistory size={16} />));
    // terminal input: contributed actions
    list.push(...(extra ?? []));
    return list;
  }, [onSecurityReview, hosts.value, snippets.value, hasTerminal, terminalConnected, onConnect, onConnectSplit, onSnippet, onRunAllOpen, onLocal, onSftp, onSftpHost, onAction, onToggleTheme, onNavigate, workspace, layouts, pick, broadcast, onToggleBroadcast, onDeployKey, recent.value, openTabs, extra]);

  const results = useMemo(() => {
    const scored = items
      .map((item) => {
        const label = fuzzyScore(query, item.label);
        const extra = label ? null : fuzzyScore(query, `${item.detail ?? ""} ${item.keywords ?? ""}`);
        if (!label && !extra) return null;
        return {
          item,
          score: label ? label.score + 2 : (extra?.score ?? 0),
          quality: label ? label.quality + 2 : (extra?.quality ?? 0),
          positions: label?.positions ?? [],
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (query) {
      // Keep each group together. Open tabs come first whenever one matches: switching to a session
      // that is already open is safer than opening another connection. Other groups are ordered
      // by their best match, items by score; text length only ranks items, so groups that match
      // equally well keep their listed order (recent connections, hosts, ... actions).
      const best = new Map<string, number>();
      const order = new Map<string, number>();
      for (const r of scored) {
        best.set(r.item.group, Math.max(best.get(r.item.group) ?? -Infinity, r.quality));
        if (!order.has(r.item.group)) order.set(r.item.group, order.size);
      }
      const tabsFirst = (r: (typeof scored)[number]) => (r.item.group === msgC.palette.groupTabs ? 0 : 1);
      scored.sort(
        (a, b) =>
          tabsFirst(a) - tabsFirst(b) ||
          (best.get(b.item.group) ?? 0) - (best.get(a.item.group) ?? 0) ||
          (order.get(a.item.group) ?? 0) - (order.get(b.item.group) ?? 0) ||
          b.score - a.score,
      );
    }
    return scored.slice(0, 60);
  }, [items, query]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  /** Closes the modal first: while it is open the page behind is inert and cannot take focus. */
  function dismiss() {
    ref.current?.close();
    onClose();
  }

  function choose(index: number, how: "run" | "split" | "sftp" = "run") {
    const result = results[index];
    if (!result) return;
    const run = how === "split" ? result.item.runSplit : how === "sftp" ? result.item.runSftp : result.item.run;
    if (!run) return;
    dismiss();
    run();
  }

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      className="palette"
      data-opened-by={opened}
      aria-label={pick?.title ?? msg.palette.label}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) dismiss();
      }}
    >
      <div className="palette-input">
        <IconSearch size={18} />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[selected] ? `${listId}-${results[selected].item.id}` : undefined}
          aria-label={pick?.title ?? msg.palette.placeholder}
          placeholder={pick?.title ?? msg.palette.placeholder}
          value={query}
          autoFocus
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((s) => Math.min(results.length - 1, s + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((s) => Math.max(0, s - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(selected, (isMac ? event.metaKey : event.ctrlKey) ? "split" : event.shiftKey ? "sftp" : "run");
            }
          }}
        />
        <Keys caps={[keyLabels.esc]} />
      </div>
      <div className="palette-list" id={listId} role="listbox" ref={listRef} aria-label={msg.palette.label}>
        {results.length === 0 && <div className="palette-empty">{msg.palette.empty}</div>}
        {results.map(({ item, positions }, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id} role="presentation">
              {header && (
                <div className="palette-group eyebrow" role="presentation">
                  {header}
                </div>
              )}
              <div
                id={`${listId}-${item.id}`}
                role="option"
                className="palette-item"
                aria-selected={index === selected}
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(index)}
              >
                {item.icon}
                <span className="truncate">
                  <Highlighted text={item.label} positions={positions} />
                </span>
                {item.detail && <span className="palette-item-detail truncate mono">{item.detail}</span>}
                {item.shortcut && !item.detail && (
                  <span style={{ marginLeft: "auto" }}>
                    <Shortcut action={item.shortcut} />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="palette-foot">
        <span>
          <Keys caps={["↑", "↓"]} /> {msg.palette.navigate}
        </span>
        <span>
          <IconCornerDownLeft size={12} /> {msg.palette.run}
        </span>
        {results[selected]?.item.runSplit && (
          <span>
            <Keys caps={[isMac ? "⌘" : "Ctrl", "↵"]} /> {msgSelect.inSplit}
          </span>
        )}
        {results[selected]?.item.runSftp && (
          <span>
            <Keys caps={["⇧", "↵"]} /> {msgSelect.inSftp}
          </span>
        )}
        <span>
          <Keys caps={[keyLabels.esc]} /> {msg.palette.close}
        </span>
      </div>
    </dialog>
  );
}

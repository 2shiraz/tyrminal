import type { HostSummary, SnippetSummary } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import type { Destination } from "../../app/AppShell";
import { useVaultData } from "../../app/vaultData";
import { Avatar, Keys, Shortcut } from "../../components/ui/controls";
import {
  IconColumns2,
  IconCornerDownLeft,
  IconFingerprint,
  IconHouse,
  IconHardDrive,
  IconKeyRound,
  IconLock,
  IconPlay,
  IconRadio,
  IconRows2,
  IconScrollText,
  IconSearch,
  IconServer,
  IconSettings,
  IconSidebar,
  IconSquareTerminal,
  IconSun,
  IconX,
  IconZoomIn,
  IconZoomOut,
  // agent B: tunnels and history
  IconHistory,
  IconRoute,
} from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { keyLabels } from "../../lib/platform";
import type { ActionId } from "../../lib/shortcuts";

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string | undefined;
  icon: ReactNode;
  shortcut?: ActionId | undefined;
  keywords?: string | undefined;
  run: () => void;
}

/** Subsequence match with a score that favors consecutive and word-start matches. */
export function fuzzyScore(needle: string, haystack: string): { score: number; positions: number[] } | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return { score: 0, positions: [] };
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
  return { score: score - h.length * 0.01, positions };
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
  onNavigate,
  onAction,
  onToggleTheme,
  onLocal,
  onSnippet,
  onDeployKey,
  broadcast,
  onToggleBroadcast,
}: {
  hasTerminal: boolean;
  terminalConnected: boolean;
  onClose: () => void;
  onConnect: (host: HostSummary) => void;
  onNavigate: (d: Destination) => void;
  onAction: (a: ActionId) => void;
  onToggleTheme: () => void;
  onLocal: () => void;
  onSnippet: (s: SnippetSummary) => void;
  /** Present only when the focused pane is a connected SSH session. */
  onDeployKey?: (() => void) | undefined;
  /** Whether the active tab broadcasts input; toggle offered only for split, connected tabs. */
  broadcast?: boolean | undefined;
  onToggleBroadcast?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { hosts, snippets } = useVaultData();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    return () => dialog?.close();
  }, []);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const host of hosts.value ?? []) {
      list.push({
        id: `host-${host.id}`,
        group: msg.palette.groupHosts,
        label: host.label,
        detail: msg.hosts.destination(host.username, host.address, host.port),
        keywords: `${host.address} ${host.username}`,
        icon: <Avatar label={host.label} size="sm" />,
        run: () => onConnect(host),
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
    }
    if (onToggleBroadcast)
      list.push(action("broadcast", broadcast ? msg.palette.broadcastOff : msg.palette.broadcastOn, <IconRadio size={16} />, onToggleBroadcast));
    if (onDeployKey) list.push(action("deploy-key", msg.palette.deployKey, <IconKeyRound size={16} />, onDeployKey));
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
    list.push(nav("home", <IconHouse size={16} />));
    list.push(nav("hosts", <IconServer size={16} />));
    list.push(nav("snippets", <IconScrollText size={16} />));
    list.push(nav("keychain", <IconKeyRound size={16} />));
    list.push(nav("knownHosts", <IconFingerprint size={16} />));
    list.push(nav("settings", <IconSettings size={16} />, "settings"));
    // agent B: tunnels and history
    list.push(nav("tunnels", <IconRoute size={16} />));
    list.push(nav("recordings", <IconHistory size={16} />));
    return list;
  }, [hosts.value, snippets.value, hasTerminal, terminalConnected, onConnect, onSnippet, onLocal, onAction, onToggleTheme, onNavigate]);

  const results = useMemo(() => {
    const scored = items
      .map((item) => {
        const label = fuzzyScore(query, item.label);
        const extra = label ? null : fuzzyScore(query, `${item.detail ?? ""} ${item.keywords ?? ""}`);
        if (!label && !extra) return null;
        return { item, score: label ? label.score + 2 : (extra?.score ?? 0), positions: label?.positions ?? [] };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (query) {
      // Keep each group together; groups are ordered by their best match, items by score.
      const best = new Map<string, number>();
      for (const r of scored) best.set(r.item.group, Math.max(best.get(r.item.group) ?? -Infinity, r.score));
      scored.sort((a, b) => (best.get(b.item.group) ?? 0) - (best.get(a.item.group) ?? 0) || b.score - a.score);
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

  function choose(index: number) {
    const result = results[index];
    if (!result) return;
    dismiss();
    result.item.run();
  }

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label={msg.palette.label}
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
          aria-label={msg.palette.placeholder}
          placeholder={msg.palette.placeholder}
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
              choose(selected);
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
        <span>
          <Keys caps={[keyLabels.esc]} /> {msg.palette.close}
        </span>
      </div>
    </dialog>
  );
}

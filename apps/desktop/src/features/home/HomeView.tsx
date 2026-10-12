import type { HostSummary } from "@tyrminal/contracts";
import { useMemo, useState } from "react";

import type { Destination } from "../../app/AppShell";
import { useVaultData } from "../../app/vaultData";
import { type Workspace, tabStatus, tabTitle } from "../../app/workspace";
import { useToast } from "../../components/ui/Toasts";
import { Avatar, EmptyState, Keys, Shortcut, SkeletonRows, relativeTime } from "../../components/ui/controls";
import {
  IconArrowRight,
  IconCornerDownLeft,
  IconKeyRound,
  IconPlus,
  IconScrollText,
  IconSearch,
  IconServer,
  IconSquareTerminal,
} from "../../components/ui/icons";
import { hosts as hostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { HostEditor } from "../hosts/HostEditor";
import type { PaneStatus } from "../terminal/TerminalView";

/** `user@host[:port]` typed into quick connect. Only shape is checked here; the core validates. */
export function parseDestination(text: string): { username: string; address: string; port: number } | null {
  const m = /^([^\s@]+)@(\[[0-9a-fA-F:.]+\]|[^\s:@/]+)(?::(\d{1,5}))?$/.exec(text.trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : 22;
  if (port < 1 || port > 65535) return null;
  return { username: m[1] as string, address: (m[2] as string).replace(/^\[|\]$/g, ""), port };
}

export function HomeView({
  ws,
  statuses,
  onConnect,
  onLocal,
  onNavigate,
  onSelectTab,
}: {
  ws: Workspace;
  statuses: Record<number, PaneStatus>;
  onConnect: (host: HostSummary) => void;
  onLocal: () => void;
  onNavigate: (d: Destination) => void;
  onSelectTab: (id: number) => void;
}) {
  const { hosts, recent, keys } = useVaultData();
  const notify = useToast();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<"new" | null>(null);
  const [prefill, setPrefill] = useState<{ username: string; address: string; port: number } | null>(null);
  const all = hosts.value ?? [];

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return all.filter((h) => `${h.label} ${h.username}@${h.address}`.toLowerCase().includes(needle)).slice(0, 6);
  }, [all, query]);
  const parsed = parseDestination(query);
  const options = [...matches.map((h) => ({ kind: "host" as const, host: h })), ...(parsed ? [{ kind: "new" as const }] : [])];

  async function quickConnect() {
    const option = options[selected];
    if (!option) return;
    if (option.kind === "host") {
      setQuery("");
      onConnect(option.host);
      return;
    }
    if (!parsed) return;
    // Saving first keeps every connection tied to a vault record (trust, recents, snippets).
    try {
      const saved = await hostsApi.save({
        id: null,
        label: parsed.address,
        address: parsed.address,
        port: parsed.port,
        username: parsed.username,
        groupId: null,
        tags: [],
        protocol: { type: "ssh" },
        terminal: { encoding: "utf8", term: "xterm256color" },
        forwardAgent: false,
        auth: { kind: "ask_password" },
      });
      setQuery("");
      void hosts.reload();
      onConnect(saved);
    } catch (error) {
      notify("danger", (error as Error).message);
      setPrefill(parsed);
      setEditing("new");
    }
  }

  const openTabs = ws.tabs;
  const loading = hosts.value === null && !hosts.error;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div className="page-title">
            <h1>{msg.home.title}</h1>
            <p>{msg.home.subtitle}</p>
          </div>
        </div>

        <div style={{ position: "relative" }}>
          <div className="quick-connect">
            <IconSearch size={19} />
            <input
              aria-label={msg.home.quickLabel}
              placeholder={msg.home.quickPlaceholder}
              value={query}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              role="combobox"
              aria-expanded={options.length > 0}
              aria-controls="quick-results"
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelected((s) => Math.min(options.length - 1, s + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelected((s) => Math.max(0, s - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void quickConnect();
                } else if (event.key === "Escape") {
                  setQuery("");
                }
              }}
            />
            {query ? <Keys caps={["↩"]} /> : <Shortcut action="palette" />}
          </div>
          {options.length > 0 && (
            <div className="quick-results" id="quick-results" role="listbox" aria-label={msg.home.quickLabel}>
              {options.map((option, index) =>
                option.kind === "host" ? (
                  <div
                    key={option.host.id}
                    role="option"
                    aria-selected={index === selected}
                    className="palette-item"
                    onMouseMove={() => setSelected(index)}
                    onClick={() => {
                      setSelected(index);
                      setQuery("");
                      onConnect(option.host);
                    }}
                  >
                    <Avatar label={option.host.label} size="sm" />
                    <span className="truncate">{option.host.label}</span>
                    <span className="palette-item-detail mono">{msg.hosts.destination(option.host.username, option.host.address, option.host.port)}</span>
                  </div>
                ) : (
                  <div
                    key="new"
                    role="option"
                    aria-selected={index === selected}
                    className="palette-item"
                    onMouseMove={() => setSelected(index)}
                    onClick={() => void quickConnect()}
                  >
                    <span className="tile-icon" style={{ width: 26, height: 26 }}>
                      <IconPlus size={15} />
                    </span>
                    <span className="truncate">{msg.home.quickNew(query.trim())}</span>
                    <span className="palette-item-detail">
                      <IconCornerDownLeft size={12} />
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {loading ? (
          <SkeletonRows count={3} height={72} />
        ) : all.length === 0 ? (
          <div className="card">
            <EmptyState icon={<IconServer size={28} />} title={msg.home.welcomeTitle} body={msg.home.welcomeBody}>
              <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                <IconPlus size={16} />
                {msg.hosts.add}
              </button>
              <button type="button" className="btn" onClick={onLocal}>
                <IconSquareTerminal size={16} />
                {msg.nav.localTerminal}
              </button>
            </EmptyState>
          </div>
        ) : (
          <div className="home-grid">
            <div className="stack" style={{ gap: "var(--space-5)" }}>
              {openTabs.length > 0 && (
                <section className="section" aria-labelledby="home-open">
                  <div className="section-head">
                    <h2 id="home-open">{msg.home.open}</h2>
                  </div>
                  <div className="tile-grid">
                    {openTabs.map((tab) => {
                      const pane = ws.panes[tab.focused];
                      const status = pane ? statuses[pane.id] : undefined;
                      const summary = tabStatus(ws, tab);
                      return (
                        <button key={tab.id} type="button" className="tile" onClick={() => onSelectTab(tab.id)}>
                          <span className="status-dot" data-tone={summary.indicator} data-unread={summary.unread || undefined} aria-hidden="true" />
                          <span className="row-main">
                            <span className="row-title">
                              {tabTitle(ws, tab)}
                              <span className="visually-hidden">{msgC.status.describe(summary)}</span>
                            </span>
                            <span className="row-sub mono">
                              {pane?.identity}
                              {status?.cols ? ` · ${status.cols}×${status.rows}` : ""}
                            </span>
                          </span>
                          <IconArrowRight size={15} className="faint" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="section" aria-labelledby="home-recent">
                <div className="section-head">
                  <h2 id="home-recent">{msg.home.recent}</h2>
                </div>
                {(recent.value ?? []).length === 0 ? (
                  <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
                    {msg.home.recentEmpty}
                  </p>
                ) : (
                  <div className="tile-grid">
                    {(recent.value ?? []).slice(0, 6).map((host) => (
                      <button
                        key={host.id}
                        type="button"
                        className="tile"
                        onClick={() => onConnect(host)}
                        aria-label={msg.hosts.connectTo(host.label)}
                      >
                        <Avatar label={host.label} />
                        <span className="row-main">
                          <span className="row-title">{host.label}</span>
                          <span className="row-sub">
                            {host.lastConnectedAt ? msg.hosts.lastConnected(relativeTime(host.lastConnectedAt)) : msg.hosts.neverConnected}
                          </span>
                        </span>
                        <IconArrowRight size={15} className="faint" />
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="section" aria-labelledby="home-hosts">
                <div className="section-head">
                  <h2 id="home-hosts">{msg.home.hosts}</h2>
                  <span className="spacer" />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate("hosts")}>
                    {msg.home.allHosts(all.length)}
                    <IconArrowRight size={14} />
                  </button>
                </div>
                <div className="tile-grid">
                  {all.slice(0, 6).map((host) => (
                    <button key={host.id} type="button" className="tile" onClick={() => onConnect(host)} aria-label={msg.hosts.connectTo(host.label)}>
                      <Avatar label={host.label} />
                      <span className="row-main">
                        <span className="row-title">{host.label}</span>
                        <span className="row-sub mono">{msg.hosts.destination(host.username, host.address, host.port)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <aside className="stack" aria-label={msg.home.actions}>
              <div className="card card-pad stack-sm">
                <h2 className="eyebrow" style={{ marginBottom: 4 }}>
                  {msg.home.actions}
                </h2>
                <button type="button" className="tile" onClick={onLocal}>
                  <span className="tile-icon">
                    <IconSquareTerminal size={17} />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{msg.nav.localTerminal}</span>
                    <span className="row-sub">{msg.home.localBody}</span>
                  </span>
                </button>
                <button type="button" className="tile" onClick={() => setEditing("new")}>
                  <span className="tile-icon">
                    <IconServer size={17} />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{msg.hosts.add}</span>
                    <span className="row-sub">{msg.home.addHostBody}</span>
                  </span>
                </button>
                <button type="button" className="tile" onClick={() => onNavigate("snippets")}>
                  <span className="tile-icon">
                    <IconScrollText size={17} />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{msg.nav.snippets}</span>
                    <span className="row-sub">{msg.home.snippetsBody}</span>
                  </span>
                </button>
                <button type="button" className="tile" onClick={() => onNavigate("keychain")}>
                  <span className="tile-icon">
                    <IconKeyRound size={17} />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{msg.nav.keychain}</span>
                    <span className="row-sub">{msg.home.keysBody}</span>
                  </span>
                </button>
              </div>
              <div className="card card-pad stack-sm">
                <h2 className="eyebrow">{msg.home.shortcuts}</h2>
                <ul className="tips">
                  <li>
                    {msg.palette.label} <Shortcut action="palette" />
                  </li>
                  <li>
                    {msg.nav.localTerminal} <Shortcut action="newLocal" />
                  </li>
                  <li>
                    {msg.palette.splitRight} <Shortcut action="splitRight" />
                  </li>
                  <li>
                    {msg.palette.find} <Shortcut action="find" />
                  </li>
                  <li>
                    {msg.palette.toggleSnippets} <Shortcut action="toggleSnippets" />
                  </li>
                </ul>
              </div>
            </aside>
          </div>
        )}
      </div>

      {editing && (
        <HostEditor
          host={null}
          initial={prefill ?? undefined}
          keys={keys.value ?? []}
          onClose={() => {
            setEditing(null);
            setPrefill(null);
          }}
          onSaved={() => {
            setEditing(null);
            setPrefill(null);
            void hosts.reload();
          }}
        />
      )}
    </div>
  );
}

import type { HostSummary } from "@tyrminal/contracts";
import { Suspense, lazy, useCallback, useState } from "react";

import { KeychainView } from "../features/credentials/KeychainView";
import { HostsView } from "../features/hosts/HostsView";
import { KnownHostsView, SettingsView } from "../features/settings/SettingsViews";
import type { TerminalTarget } from "../features/terminal/TerminalController";
import type { TabIndicator } from "../features/terminal/TerminalView";
import { vault } from "../lib/ipc";
import { msg } from "../lib/messages";

type Destination = "hosts" | "keychain" | "knownHosts" | "settings";

interface SessionTab {
  id: number;
  target: TerminalTarget;
  /** The user's own name for the destination. */
  label: string;
  identity: string;
  /** Title requested by the remote side, already sanitized. Shown after the label, never instead of it. */
  remoteTitle: string;
  indicator: TabIndicator;
}

// The terminal emulator is the largest module and is not needed until a session opens.
const TerminalView = lazy(() => import("../features/terminal/TerminalView").then((m) => ({ default: m.TerminalView })));

const NAV: { id: Destination; label: string; glyph: string }[] = [
  { id: "hosts", label: msg.nav.hosts, glyph: "▤" },
  { id: "keychain", label: msg.nav.keychain, glyph: "⚿" },
  { id: "knownHosts", label: msg.nav.knownHosts, glyph: "✓" },
  { id: "settings", label: msg.nav.settings, glyph: "⚙" },
];

const INDICATOR_CLASS: Record<TabIndicator, string> = {
  ok: "dot dot-ok",
  busy: "dot dot-busy",
  attention: "dot dot-busy",
  bad: "dot dot-bad",
  idle: "dot",
};

let nextTabId = 1;

export function AppShell() {
  const [destination, setDestination] = useState<Destination>("hosts");
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  // `null` shows the navigation destination; a number shows that session tab.
  const [activeTab, setActiveTab] = useState<number | null>(null);

  const openTab = useCallback((target: TerminalTarget, label: string, identity: string) => {
    const id = nextTabId++;
    setTabs((current) => [...current, { id, target, label, identity, remoteTitle: "", indicator: "busy" }]);
    setActiveTab(id);
  }, []);

  const closeTab = useCallback((id: number) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTab((current) => (current === id ? null : current));
  }, []);

  const patchTab = useCallback((id: number, patch: Partial<SessionTab>) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }, []);

  function connect(host: HostSummary) {
    openTab({ kind: "ssh", hostId: host.id }, host.label, msg.hosts.destination(host.username, host.address, host.port));
  }

  function navigate(next: Destination) {
    setDestination(next);
    setActiveTab(null);
  }

  return (
    <div className="shell">
      <nav className="sidebar" aria-label={msg.nav.primary}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            &gt;_
          </span>
          <strong>{msg.app.name}</strong>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-item"
            aria-current={activeTab === null && destination === item.id ? "page" : undefined}
            onClick={() => navigate(item.id)}
          >
            <span className="nav-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            {item.label}
          </button>
        ))}
        <div className="sidebar-footer">
          <button type="button" className="btn" onClick={() => openTab({ kind: "local" }, msg.nav.localTerminal, msg.terminal.local)}>
            {msg.nav.localTerminal}
          </button>
          <button type="button" className="btn" onClick={() => void vault.lock().catch(() => undefined)}>
            {msg.nav.lock}
          </button>
        </div>
      </nav>

      <div className="workspace">
        <div className="tabstrip" role="tablist" aria-label={msg.nav.sessions}>
          <button type="button" role="tab" className="tab" aria-selected={activeTab === null} onClick={() => setActiveTab(null)}>
            <span className="tab-label">{NAV.find((item) => item.id === destination)?.label}</span>
          </button>
          {tabs.map((tab) => (
            <div key={tab.id} role="presentation" className="tab" aria-selected={activeTab === tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{ all: "unset", display: "inline-flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, cursor: "pointer" }}
              >
                <span className={INDICATOR_CLASS[tab.indicator]} aria-hidden="true" />
                <span className="tab-label">
                  {tab.label}
                  {tab.remoteTitle && <span className="muted"> — {tab.remoteTitle}</span>}
                </span>
                {tab.indicator === "attention" && <span className="visually-hidden"> (needs your input)</span>}
              </button>
              <button type="button" className="tab-close" aria-label={msg.nav.closeTab(tab.label)} onClick={() => closeTab(tab.id)}>
                ×
              </button>
            </div>
          ))}
        </div>

        {activeTab === null && destination === "hosts" && <HostsView onConnect={connect} />}
        {activeTab === null && destination === "keychain" && <KeychainView />}
        {activeTab === null && destination === "knownHosts" && <KnownHostsView />}
        {activeTab === null && destination === "settings" && <SettingsView />}

        {/* Terminals stay mounted while hidden so their screen state and session survive tab switches. */}
        <Suspense fallback={null}>
          {tabs.map((tab) => (
            <TerminalView
            key={tab.id}
            target={tab.target}
            identity={tab.identity}
            active={activeTab === tab.id}
            onIndicator={(indicator) => patchTab(tab.id, { indicator })}
            onTitle={(remoteTitle) => patchTab(tab.id, { remoteTitle })}
            onOpenKnownHosts={() => navigate("knownHosts")}
            onCloseTab={() => closeTab(tab.id)}
          />
          ))}
        </Suspense>
      </div>
    </div>
  );
}

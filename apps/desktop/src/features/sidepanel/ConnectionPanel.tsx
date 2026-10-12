// The panel beside the terminal (TRM-14): snippets, connection history and appearance for the
// session in front, one section at a time. History lists connections only (host and when);
// nothing typed in a terminal is recorded. Everything here is gone after a lock.

import type { HostSummary, SnippetSummary, TerminalPreferences } from "@tyrminal/contracts";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";

import { usePreferences } from "../../app/preferences";
import { useVaultData } from "../../app/vaultData";
import { Avatar, IconButton, RangeField, Segmented, SettingRow, Shortcut, relativeTime } from "../../components/ui/controls";
import { IconPanelRightClose, IconZoomIn, IconZoomOut } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-input";
import { SnippetLibrary, type SnippetTarget, TargetIndicator } from "../snippets/SnippetLibrary";
import { SCHEMES } from "../terminal/schemes";
import { useExit } from "../../lib/exitGhost";

export type PanelSection = "snippets" | "history" | "appearance";
const SECTIONS: PanelSection[] = ["snippets", "history", "appearance"];

export function ConnectionPanel({
  section,
  onSection,
  target,
  hostId,
  onSend,
  onConnect,
  onZoom,
  onClose,
}: {
  section: PanelSection;
  onSection: (section: PanelSection) => void;
  target: SnippetTarget | null;
  /** The saved host of the focused pane, if it is an SSH session. */
  hostId: string | null;
  onSend: (snippet: SnippetSummary, mode: "paste" | "run") => void;
  onConnect: (host: HostSummary) => void;
  onZoom: (step: "in" | "out" | "reset") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // Closing, the panel fades and drifts back toward its edge (lib/exitGhost).
  const exitRef = useExit<HTMLElement>({ transform: "translateX(4px)" }, ref);
  const tabsId = useId();
  const title = msgI.panel[section];

  // Opening the panel from the keyboard moves focus into it (the snippets search field, or the
  // selected section tab).
  useEffect(() => {
    const root = ref.current;
    const search = section === "snippets" ? root?.querySelector<HTMLInputElement>('input[type="search"]') : null;
    (search ?? root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
    // Only when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onTabKey(event: KeyboardEvent) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = SECTIONS[(SECTIONS.indexOf(section) + step + SECTIONS.length) % SECTIONS.length] as PanelSection;
    onSection(next);
    ref.current?.querySelector<HTMLElement>(`#${CSS.escape(`${tabsId}-${next}`)}`)?.focus();
  }

  return (
    <aside
      ref={exitRef}
      className="side-panel"
      aria-label={title}
      data-section={section}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target as HTMLElement).closest("dialog")) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head">
        <h2>{title}</h2>
        {section === "snippets" && <Shortcut action="toggleSnippets" />}
        <IconButton label={msg.snippets.close} onClick={onClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </div>
      <div className="panel-sections" role="tablist" aria-label={msgI.panel.sections}>
        {SECTIONS.map((s) => (
          <button
            key={s}
            id={`${tabsId}-${s}`}
            type="button"
            role="tab"
            aria-selected={s === section}
            aria-controls={`${tabsId}-panel`}
            tabIndex={s === section ? 0 : -1}
            className="panel-section-tab"
            onClick={() => onSection(s)}
            onKeyDown={onTabKey}
          >
            {msgI.panel[s]}
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${section}`} className="panel-section">
        {section === "snippets" && (
          <>
            <div style={{ paddingTop: "var(--space-3)" }}>
              <TargetIndicator target={target} />
            </div>
            <div className="panel-body" style={{ paddingTop: 0 }}>
              <SnippetLibrary target={target} onSend={onSend} compact />
            </div>
          </>
        )}
        {section === "history" && <History hostId={hostId} onConnect={onConnect} />}
        {section === "appearance" && <Appearance onZoom={onZoom} />}
      </div>
    </aside>
  );
}

function History({ hostId, onConnect }: { hostId: string | null; onConnect: (host: HostSummary) => void }) {
  const { recent } = useVaultData();
  const hosts = recent.value ?? [];
  return (
    <div className="panel-body stack-sm">
      <p className="faint" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
        {msgI.panel.historyNote}
      </p>
      {hosts.length === 0 ? (
        <p className="faint">{msgI.panel.historyEmpty}</p>
      ) : (
        <ul className="panel-history" aria-label={msgI.panel.historyList}>
          {hosts.map((host) => (
            <li key={host.id} data-current={host.id === hostId || undefined}>
              <Avatar label={host.label} size="sm" />
              <span className="row-main">
                <span className="truncate">
                  {host.label}
                  {host.id === hostId && <span className="faint"> · {msgI.panel.current}</span>}
                </span>
                <span className="faint mono truncate">{msg.hosts.destination(host.username, host.address, host.port)}</span>
                <span className="faint" style={{ fontSize: "var(--text-xs)" }}>
                  {host.lastConnectedAt ? msgI.panel.connectedAgo(relativeTime(host.lastConnectedAt)) : msgI.panel.neverConnected}
                </span>
              </span>
              <button type="button" className="btn btn-sm" aria-label={msgI.panel.openAgain(host.label)} onClick={() => onConnect(host)}>
                {msgI.panel.open}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Appearance({ onZoom }: { onZoom: (step: "in" | "out" | "reset") => void }) {
  const { prefs, update } = usePreferences();
  const t = prefs.terminal;
  const setTerminal = (patch: Partial<TerminalPreferences>) => update((p) => ({ ...p, terminal: { ...p.terminal, ...patch } }));
  return (
    <div className="panel-body stack-sm">
      <p className="faint" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
        {msgI.panel.appearanceNote}
      </p>
      <SettingRow label={msg.settings.scheme}>
        <select className="select" aria-label={msg.settings.scheme} value={t.scheme} onChange={(e) => setTerminal({ scheme: e.target.value })}>
          {SCHEMES.map((scheme) => (
            <option key={scheme.id} value={scheme.id}>
              {scheme.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label={msg.settings.fontSize}>
        <RangeField label={msg.settings.fontSize} value={t.fontSize} min={9} max={24} step={1} format={(v) => `${v}px`} onChange={(fontSize) => setTerminal({ fontSize })} />
      </SettingRow>
      <SettingRow label={msg.settings.lineHeight}>
        <RangeField label={msg.settings.lineHeight} value={t.lineHeight} min={1} max={1.8} step={0.05} format={(v) => v.toFixed(2)} onChange={(lineHeight) => setTerminal({ lineHeight })} />
      </SettingRow>
      <SettingRow label={msg.settings.cursor}>
        <Segmented
          label={msg.settings.cursor}
          value={t.cursorStyle}
          onChange={(cursorStyle) => setTerminal({ cursorStyle })}
          options={[
            { value: "block", label: msg.settings.cursorBlock },
            { value: "bar", label: msg.settings.cursorBar },
            { value: "underline", label: msg.settings.cursorUnderline },
          ]}
        />
      </SettingRow>
      <SettingRow label={msgI.panel.zoom}>
        <div className="row-flex">
          <IconButton label={msgI.panel.zoomOut} onClick={() => onZoom("out")}>
            <IconZoomOut size={14} />
          </IconButton>
          <button type="button" className="btn btn-sm" onClick={() => onZoom("reset")}>
            {msgI.panel.zoomReset}
          </button>
          <IconButton label={msgI.panel.zoomIn} onClick={() => onZoom("in")}>
            <IconZoomIn size={14} />
          </IconButton>
        </div>
      </SettingRow>
    </div>
  );
}

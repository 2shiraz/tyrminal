import { type ReactNode, memo, useRef } from "react";

import type { Destination } from "../../app/AppShell";
import { msg } from "../../lib/messages";
import { useGlide } from "../../lib/useGlide";
import { versionLabel } from "../../lib/version";
import { Shortcut } from "../ui/controls";
import {
  // agent B: tunnels and history
  IconRoute,
  IconArrowLeftRight,
  IconFingerprint,
  IconKeyRound,
  IconLock,
  IconScrollText,
  IconSearch,
  IconServer,
  IconSettings,
  IconSidebar,
  IconSquareTerminal,
  IconHistory,
} from "../ui/icons";
import { msgSftp } from "../../features/sftp/messages";

/** The Tyrminal mark: a prompt chevron and cursor in a rounded tile. Original artwork. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="6" fill="var(--accent)" />
      <path d="M9 11.5 14 16l-5 4.5" fill="none" stroke="var(--text-on-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="16.5" y="19.2" width="7" height="2.6" rx="1.3" fill="var(--text-on-accent)" />
    </svg>
  );
}

const PRIMARY: { id: Destination; icon: ReactNode }[] = [
  { id: "hosts", icon: <IconServer size={17} /> },
  { id: "snippets", icon: <IconScrollText size={17} /> },
  // agent B: tunnels and history
  { id: "tunnels", icon: <IconRoute size={17} /> },
  { id: "recordings", icon: <IconHistory size={17} /> },
];

const VAULT: { id: Destination; icon: ReactNode }[] = [
  { id: "keychain", icon: <IconKeyRound size={17} /> },
  { id: "knownHosts", icon: <IconFingerprint size={17} /> },
];

function SidebarImpl({
  destination,
  collapsed,
  onNavigate,
  onOpenPalette,
  onLocalTerminal,
  onSftp,
  onToggleCollapsed,
  onLock,
  onOpenAbout,
  hostCount,
  snippetCount,
}: {
  destination: Destination | null;
  collapsed: boolean;
  onNavigate: (d: Destination) => void;
  onOpenPalette: () => void;
  onLocalTerminal: () => void;
  /** Opens a new SFTP tab. */
  onSftp?: () => void;
  onToggleCollapsed: () => void;
  onLock: () => void;
  onOpenAbout: () => void;
  hostCount: number;
  snippetCount: number;
  /** Changes with the user's shortcuts, so this memoized component re-renders its shortcut labels. */
  shortcuts?: unknown;
}) {
  const counts: Partial<Record<Destination, number>> = { hosts: hostCount, snippets: snippetCount };
  // The accent caret of the current page glides to a clicked item (lib/useGlide); the fill does not.
  const navRef = useRef<HTMLElement>(null);
  useGlide(navRef);

  const item = (entry: { id: Destination; icon: ReactNode }) => (
    <button
      key={entry.id}
      type="button"
      className="nav-item"
      data-nav={entry.id}
      aria-current={destination === entry.id ? "page" : undefined}
      data-tooltip={collapsed ? msg.nav[entry.id] : undefined}
      data-tooltip-side="right"
      onClick={() => onNavigate(entry.id)}
    >
      {entry.icon}
      <span className="nav-label">{msg.nav[entry.id]}</span>
      {counts[entry.id] ? <span className="nav-count">{counts[entry.id]}</span> : null}
    </button>
  );

  return (
    <nav className="sidebar" aria-label={msg.nav.primary} ref={navRef}>
      <div className="brand">
        <BrandMark />
        <span className="brand-name">{msg.app.name}</span>
      </div>

      <button type="button" className="sidebar-search" onClick={onOpenPalette} aria-label={msg.nav.search}>
        <IconSearch size={15} />
        <span className="search-label">{msg.common.search}…</span>
        <Shortcut action="palette" />
      </button>

      <div className="nav-group-label">{msg.nav.library}</div>
      {PRIMARY.map(item)}

      <div className="nav-group-label">{msg.nav.security}</div>
      {VAULT.map(item)}

      <div className="nav-group-label">{msg.nav.newSession}</div>
      <div className="sidebar-create">
        <button type="button" className="nav-item" data-nav="local" onClick={onLocalTerminal} data-tooltip={collapsed ? msg.nav.localTerminal : undefined} data-tooltip-side="right">
          <IconSquareTerminal size={17} />
          <span className="nav-label">{msg.nav.localTerminal}</span>
        </button>
        {onSftp && (
          <button type="button" className="nav-item" data-nav="sftp" onClick={onSftp} data-tooltip={collapsed ? msgSftp.open : undefined} data-tooltip-side="right">
            <IconArrowLeftRight size={17} />
            <span className="nav-label">{msgSftp.open}</span>
          </button>
        )}
      </div>

      <div className="sidebar-footer">
        {item({ id: "settings", icon: <IconSettings size={17} /> })}
        <button type="button" className="nav-item" data-nav="lock" onClick={onLock} data-tooltip={collapsed ? msg.nav.lock : undefined} data-tooltip-side="right">
          <IconLock size={17} />
          <span className="nav-label">{msg.nav.lock}</span>
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? msg.nav.expand : msg.nav.collapse}
          aria-expanded={!collapsed}
          data-tooltip={collapsed ? msg.nav.expand : undefined}
          data-tooltip-side="right"
        >
          <IconSidebar size={17} />
          <span className="nav-label">{msg.nav.collapse}</span>
        </button>
        <button type="button" className="sidebar-version" onClick={onOpenAbout} aria-label={msg.about.open(versionLabel(__APP_VERSION__))}>
          {versionLabel(__APP_VERSION__)}
        </button>
      </div>
    </nav>
  );
}

/** Memoized: re-renders only when its own props change, not for every state change of the shell. */
export const Sidebar = memo(SidebarImpl);

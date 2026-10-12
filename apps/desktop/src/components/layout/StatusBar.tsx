import type { Pane } from "../../app/workspace";
import type { PaneStatus } from "../../features/terminal/TerminalView";
import { msg } from "../../lib/messages";
import { shortcutText } from "../../lib/shortcuts";
import { IconClipboardCopy, IconCpu, IconLock, IconMoon, IconScrollText, IconShieldCheck, IconSun } from "../ui/icons";

/** Bottom status surface: where the focused session goes, its state, and terminal facts. */
export function StatusBar({
  pane,
  status,
  panelOpen,
  onTogglePanel,
  theme,
  onToggleTheme,
}: {
  pane: Pane | null;
  status: PaneStatus | undefined;
  panelOpen: boolean;
  onTogglePanel: (() => void) | undefined;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const state = status?.state ?? "connecting";
  const stateText = state === "failed" ? msg.terminal.state.failed : state === "closed" ? msg.terminal.state.closed : msg.terminal.state[state];
  return (
    <footer className="statusbar">
      {pane ? (
        <>
          <span className="status-item" role="status">
            <span className="status-dot" data-tone={pane.indicator} aria-hidden="true" />
            <span>{stateText}</span>
          </span>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-item selectable truncate" title={pane.identity}>
            {pane.identity}
          </span>
          {status && status.cols > 0 && (
            <>
              <span className="status-sep" aria-hidden="true" />
              <span className="status-item tabular">{msg.status.size(status.cols, status.rows)}</span>
            </>
          )}
          {status && (
            <>
              <span className="status-sep" aria-hidden="true" />
              <span className="status-item" data-renderer={status.renderer}>
                <IconCpu size={13} />
                {msg.status.renderer(status.renderer === "webgl" ? msg.status.webgl : msg.status.dom)}
              </span>
            </>
          )}
          {status?.security && (
            <>
              <span className="status-sep" aria-hidden="true" />
              <span
                className="status-item"
                data-testid="negotiated"
                data-tooltip={msg.status.securityDetail(status.security)}
                data-tooltip-side="top"
                tabIndex={0}
                aria-label={msg.status.securityDetail(status.security)}
              >
                <IconShieldCheck size={13} />
                {status.security.cipher.replace("@openssh.com", "")}
              </span>
            </>
          )}
          {status?.clipboardAllowed && (
            <span className="status-item" style={{ color: "var(--warning)" }}>
              <IconClipboardCopy size={13} />
              {msg.status.clipboardAllowed}
            </span>
          )}
        </>
      ) : (
        <span className="status-item">
          <IconLock size={13} />
          {msg.status.encrypted}
        </span>
      )}
      <span className="spacer" />
      {onTogglePanel && (
        <button
          type="button"
          className="status-button"
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
          data-tooltip={`${msg.palette.toggleSnippets} (${shortcutText("toggleSnippets")})`}
          data-tooltip-side="top"
        >
          <IconScrollText size={13} />
          {msg.status.snippets}
        </button>
      )}
      <button
        type="button"
        className="status-button"
        onClick={onToggleTheme}
        aria-label={msg.palette.toggleTheme}
        data-tooltip={msg.palette.toggleTheme}
        data-tooltip-side="top"
      >
        {theme === "dark" ? <IconMoon size={13} /> : <IconSun size={13} />}
      </button>
    </footer>
  );
}

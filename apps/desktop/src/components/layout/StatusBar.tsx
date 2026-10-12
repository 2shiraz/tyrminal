import { memo } from "react";
import type { Pane } from "../../app/workspace";
import type { PaneStatus } from "../../features/terminal/TerminalView";
import { msg } from "../../lib/messages";
import { shortcutText } from "../../lib/shortcuts";
import { IconClipboardCopy, IconCpu, IconFile, IconHardDrive, IconLock, IconMoon, IconRadio, IconScrollText, IconServer, IconShieldCheck, IconSun } from "../ui/icons";
// server at a glance
import { msgG } from "../../lib/messages-glance";

/** Bottom status surface: where the focused session goes, its state, and terminal facts. */
function StatusBarImpl({
  pane,
  status,
  panelOpen,
  onTogglePanel,
  theme,
  onToggleTheme,
  broadcast,
  onStopBroadcast,
  filesOpen,
  onToggleFiles,
  serverOpen,
  onToggleServer,
  notesOpen,
  onToggleNotes,
}: {
  pane: Pane | null;
  status: PaneStatus | undefined;
  panelOpen: boolean;
  onTogglePanel: (() => void) | undefined;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Panes receiving this tab's typed input, when broadcasting. */
  broadcast?: number | undefined;
  onStopBroadcast?: (() => void) | undefined;
  filesOpen?: boolean | undefined;
  onToggleFiles?: (() => void) | undefined;
  // server at a glance
  serverOpen?: boolean | undefined;
  onToggleServer?: (() => void) | undefined;
  /** P-30: the focused host's notes. */
  notesOpen?: boolean | undefined;
  onToggleNotes?: (() => void) | undefined;
  /** Changes with the user's shortcuts, so this memoized component re-renders its shortcut labels. */
  shortcuts?: unknown;
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
          {broadcast !== undefined && (
            <>
              <span className="status-sep" aria-hidden="true" />
              <button type="button" className="status-item status-broadcast" data-testid="broadcast" onClick={onStopBroadcast} title={msg.status.broadcastStop}>
                <IconRadio size={13} />
                {msg.status.broadcast(broadcast)}
              </button>
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
      {onToggleNotes && (
        <button
          type="button"
          className="status-button"
          aria-pressed={notesOpen ?? false}
          data-panel="notes"
          onClick={onToggleNotes}
          data-tooltip={msg.palette.toggleNotes}
          data-tooltip-side="top"
        >
          <IconFile size={13} />
          {msg.status.notes}
        </button>
      )}
      {onToggleServer && (
        <button
          type="button"
          className="status-button"
          aria-pressed={serverOpen ?? false}
          data-panel="server"
          onClick={onToggleServer}
          data-tooltip={msgG.open}
          data-tooltip-side="top"
        >
          <IconServer size={13} />
          {msgG.panel}
        </button>
      )}
      {onToggleFiles && (
        <button
          type="button"
          className="status-button"
          aria-pressed={filesOpen ?? false}
          data-panel="files"
          onClick={onToggleFiles}
          data-tooltip={`${msg.palette.toggleFiles} (${shortcutText("toggleFiles")})`}
          data-tooltip-side="top"
        >
          <IconHardDrive size={13} />
          {msg.status.files}
        </button>
      )}
      {onTogglePanel && (
        <button
          type="button"
          className="status-button"
          aria-pressed={panelOpen}
          data-panel="snippets"
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

/** Memoized: re-renders only when its own props change, not for every state change of the shell. */
export const StatusBar = memo(StatusBarImpl);

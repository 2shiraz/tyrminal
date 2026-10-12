import type { IpcError, SessionEvent, SessionState, TerminalPreferences, WorkspacePreferences } from "@tyrminal/contracts";
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { Indicator } from "../../app/workspace";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { IconButton, Notice, SecretField, TextField } from "../../components/ui/controls";
import {
  IconChevronDown,
  IconChevronLeft,
  IconCopy,
  IconExternalLink,
  IconFolder,
  IconKeyRound,
  IconPlug,
  IconSearch,
  IconShieldAlert,
  IconX,
} from "../../components/ui/icons";
import { links, sessions } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { msgD } from "../../lib/messages-d";
// agent B: tunnels and history
import { HopNotice } from "../tunnels/HopNotice";
import { InstallKeyDialog } from "../credentials/InstallKeyDialog";
import { ConnectionDetails } from "../connection/ConnectionDetails";
import { TokenMenu } from "../tokens/TokenMenu";
import type { Token } from "../tokens/tokenLinks";
import { ConnectionLogDialog } from "./ConnectionLogDialog";
import { ConnectionSheet, type TimelineEntry, timelineEntry } from "./ConnectionSheet";
import { PasteReviewDialog } from "./PasteReviewDialog";
import { type RendererKind, TerminalController, type TerminalTarget } from "./TerminalController";
import type { CommandRecord } from "./commandOutput";
import { encodingById } from "./encoding";
import type { PasteCheck, PasteChecks } from "./pasteSafety";
import { schemeById } from "./schemes";
import type { ScrollbackMatch, ScrollbackResult } from "./scrollbackSearch";

const encodingLabel = (id: string) => encodingById(id).label;
import { RECONNECT_MAX_ATTEMPTS, cdCommand, checkLink, groupFingerprint, reconnectDelayMs, shouldAutoReconnect } from "./terminalPolicy";

type TrustPrompt = Extract<SessionEvent, { type: "trust_prompt" }>;
type AuthPrompt = Extract<SessionEvent, { type: "auth_prompt" }>;
type KeyChanged = Extract<SessionEvent, { type: "host_key_changed" }>;

export type TabIndicator = Indicator;

/** What the shell's status bar shows for the focused pane. */
export interface PaneStatus {
  state: SessionState | "failed" | "closed";
  renderer: RendererKind;
  cols: number;
  rows: number;
  clipboardAllowed: boolean;
  /** SSH only: the negotiated cipher and key exchange, from the client's own offer list. */
  security?: { cipher: string; kex: string; mac: string; hostKey: string; strictKex: boolean };
}

/** Imperative handle the shell uses for actions on a pane (find, zoom, snippets). */
export interface PaneHandle {
  focus(): void;
  openFind(): void;
  zoom(step: "in" | "out" | "reset"): void;
  sessionId(): string | null;
  bracketedPaste(): boolean;
  connected(): boolean;
  /** Whether user input can be told apart from terminal replies here (needed to broadcast). */
  broadcastable(): boolean;
  /** Input typed in another pane of a broadcasting tab. */
  receiveBroadcast(bytes: Uint8Array): void;
  /** The session's character encoding (kept across reconnects of this pane). */
  encoding(): string;
  setEncoding(id: string): void;
  /** Marks the session as moving to another window, so unmounting this pane leaves it running. */
  release(on: boolean): void;
  // terminal input: palette copy and paste
  copy(): Promise<boolean>;
  paste(): void;
  /** Scrolls to the previous (-1) or next (+1) command, when the shell marks them. */
  jumpCommand(direction: -1 | 1): boolean;
  /** SSH only: environment variables requested on this connection, and those the server refused. */
  environment(): SessionEnvironment | null;
  /** P-28: matches in this pane's scrollback (in memory only). */
  searchScrollback(query: string, caseSensitive: boolean): ScrollbackResult;
  /** P-28: scrolls a match into view and selects it. */
  revealMatch(match: ScrollbackMatch): void;
  /** P-29: commands the shell integration marked, newest first (empty without it). */
  commands(): CommandRecord[];
  /** P-29: the output of one finished command, or null when it is gone. */
  commandOutput(id: number): string | null;
}

export interface SessionEnvironment {
  sent: string[];
  rejected: string[];
}

interface TerminalViewProps {
  paneId: number;
  target: TerminalTarget;
  /** Folder to start the first attempt in (a duplicated tab's); reconnects start as usual. */
  startIn?: string | undefined;
  /** Where this session goes, as configured by the user (not supplied by the server). */
  identity: string;
  label: string;
  /** The tab holding this pane is in front. */
  visible: boolean;
  /** This pane has keyboard focus within its tab. */
  focused: boolean;
  prefs: TerminalPreferences;
  /** Highlighting, Option/Alt and mouse preferences. */
  workspace?: WorkspacePreferences | undefined;
  onIndicator: (indicator: TabIndicator) => void;
  onTitle: (title: string) => void;
  onStatus: (status: PaneStatus) => void;
  onFocus: () => void;
  onOpenKnownHosts: () => void;
  onClose: () => void;
  register: (handle: PaneHandle | null) => void;
  /** User input typed in this pane (for broadcast). */
  onUserInput?: ((bytes: Uint8Array) => void) | undefined;
  /** Output arrived while this pane's tab was hidden (reported once until it is shown again). */
  onUnread?: (() => void) | undefined;
  /** Restored from a template: offer (never perform by itself) a return to this directory. */
  restoreDirectory?: string | undefined;
  /** The shell reported its working directory (OSC 7). */
  onDirectory?: ((path: string) => void) | undefined;
  /** A session handed to this (detached) window: taken over instead of opened. */
  attachToken?: string | undefined;
  /** False where this window cannot open sessions (a detached window): no reconnect. */
  canReconnect?: boolean | undefined;
  /** Restored from a layout: no session is opened until the user chooses Connect. */
  pending?: boolean | undefined;
  onConnect?: (() => void) | undefined;
  onConnectAll?: (() => void) | undefined;
  /** P-25: the paste checks this host keeps (all of them unless the host lowers some). */
  pasteChecks?: PasteChecks | undefined;
  /** P-25: extra labels for this session in the paste review (an environment label, for one). */
  targetLabels?: ReactNode;
}

export function Fingerprint({ value }: { value: string }) {
  const { algorithm, groups } = groupFingerprint(value);
  return (
    <div className="fingerprint" aria-label={value}>
      {algorithm && <span className="fingerprint-alg">{algorithm}</span>}
      {groups.map((group, index) => (
        // Position is the identity here: the groups are a fixed split of one string.
        <span key={`${index}-${group}`} aria-hidden="true">
          {group}
        </span>
      ))}
    </div>
  );
}

export function TerminalView(props: TerminalViewProps) {
  const { target, identity, label, visible, focused, prefs } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const notify = useToast();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SessionState>("connecting");
  // What the session reported while connecting, with arrival times, for the connection sheet.
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [trust, setTrust] = useState<TrustPrompt | null>(null);
  const [auth, setAuth] = useState<AuthPrompt | null>(null);
  const [changed, setChanged] = useState<KeyChanged | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [closed, setClosed] = useState<{ error: IpcError | null; exitStatus: number | null } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // The Keychain key the destination refused in this attempt, to offer installing it.
  const [rejectedKey, setRejectedKey] = useState<{ keyId: string; label: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [paste, setPaste] = useState<{ text: string; check: PasteCheck; bracketed: boolean; send: (text: string) => void } | null>(null);
  const [clipboardAsk, setClipboardAsk] = useState<string | null>(null);
  const environment = useRef<SessionEnvironment | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findCount, setFindCount] = useState({ index: 0, total: 0 });
  const clipboardAllowed = useRef(false);
  // Automatic reconnect after a dropped connection: counted across attempts, reset on success.
  const everConnected = useRef(false);
  const autoAttempts = useRef(0);
  const [autoRetry, setAutoRetry] = useState<{ attempt: number; dueAt: number } | null>(null);
  const unreadReported = useRef(false);
  // The return-to-directory offer is made at most once per restored pane.
  const [directoryOffer, setDirectoryOffer] = useState<"waiting" | "shown" | "done">(props.restoreDirectory ? "waiting" : "done");
  const [encodingId, setEncodingId] = useState("utf-8");
  const encodingRef = useRef("utf-8");
  const lastUnencodable = useRef(0);
  if (visible) unreadReported.current = false;
  const status = useRef<PaneStatus>({ state: "connecting", renderer: "dom", cols: 0, rows: 0, clipboardAllowed: false });

  // Callbacks change identity every render; the controller needs stable ones.
  const handlers = useRef(props);
  handlers.current = props;

  function publish(patch: Partial<PaneStatus>) {
    status.current = { ...status.current, ...patch };
    handlers.current.onStatus(status.current);
  }

  const pending = props.pending === true;
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    if (pending) {
      // Nothing is opened, started or sent while a restored pane waits for the user.
      publish({ state: "closed", clipboardAllowed: false });
      return;
    }
    setState("connecting");
    setTimeline([]);
    setStartedAt(Date.now());
    setTrust(null);
    setAuth(null);
    setChanged(null);
    setBanner(null);
    setClosed(null);
    setRejectedKey(null);
    environment.current = null;
    clipboardAllowed.current = false;
    publish({ state: "connecting", clipboardAllowed: false });

    const controller = new TerminalController(container, handlers.current.prefs, {
      onTitle: (title) => handlers.current.onTitle(title),
      onLink: (url) => setLink(url),
      // terminal input: actions on addresses and paths in the output
      onToken: (token) => setToken(token),
      onClipboardWrite: (text) => {
        if (clipboardAllowed.current) {
          void navigator.clipboard
            .writeText(text)
            .then(() => notify("info", msg.terminal.clipboardWritten))
            .catch(() => undefined);
        } else {
          setClipboardAsk(text);
        }
      },
      onPasteReview: (text, check, bracketed, send) => setPaste({ text, check, bracketed, send }),
      onRenderer: (kind, fellBack) => {
        publish({ renderer: kind });
        if (fellBack && handlers.current.prefs.renderer === "auto" && kind === "dom" && controllerRef.current) {
          notify("info", msg.terminal.rendererFallback);
        }
      },
      onResize: (cols, rows) => publish({ cols, rows }),
      onSearchResults: (index, total) => setFindCount({ index, total }),
      onUserInput: (bytes) => handlers.current.onUserInput?.(bytes),
      onDirectory: (path) => handlers.current.onDirectory?.(path),
      onUnencodable: (chars) => {
        // At most one notice every few seconds while typing.
        if (Date.now() - lastUnencodable.current < 4000) return;
        lastUnencodable.current = Date.now();
        notify("danger", msgC.encoding.unencodable(chars.slice(0, 3).join(" "), encodingLabel(encodingRef.current)));
      },
      onOutput: () => {
        if (handlers.current.visible || unreadReported.current) return;
        unreadReported.current = true;
        handlers.current.onUnread?.();
      },
      onEvent: (event) => {
        const entry = timelineEntry(event, Date.now());
        if (entry) setTimeline((current) => [...current, entry]);
        switch (event.type) {
          case "state":
            setState(event.state);
            publish({ state: event.state });
            if (event.state === "connected") {
              everConnected.current = true;
              autoAttempts.current = 0;
            }
            break;
          case "trust_prompt":
            setTrust(event);
            break;
          case "auth_prompt":
            setAuth(event);
            break;
          case "host_key_changed":
            setChanged(event);
            break;
          case "banner":
            setBanner(event.text);
            break;
          // Environment variables the server refused are always reported (SNP-13).
          case "environment":
            environment.current = { sent: event.sent, rejected: event.rejected };
            if (event.rejected.length > 0) notify("danger", msgD.env.rejected(event.rejected));
            break;
          case "notice":
            notify("danger", event.text);
            break;
          case "key_rejected":
            // Only the destination's key can be installed from here; a jump host's is named in
            // the error.
            if (!event.hop || event.hop.index === event.hop.total) setRejectedKey({ keyId: event.keyId, label: event.label });
            break;
          case "negotiated":
            // Sent for every hop of a jump chain; the status bar shows the destination's.
            if (event.hop && event.hop.index !== event.hop.total) break;
            publish({ security: { cipher: event.cipher, kex: event.kex, mac: event.mac, hostKey: event.hostKey, strictKex: event.strictKex } });
            break;
          case "closed":
            setTrust(null);
            setAuth(null);
            setClipboardAsk(null);
            setClosed({ error: event.error, exitStatus: event.exitStatus });
            if (handlers.current.canReconnect !== false && shouldAutoReconnect(target.kind, everConnected.current, event.error?.code ?? null) && autoAttempts.current < RECONNECT_MAX_ATTEMPTS) {
              autoAttempts.current += 1;
              setAutoRetry({ attempt: autoAttempts.current, dueAt: Date.now() + reconnectDelayMs(autoAttempts.current) });
            }
            publish({ state: event.error ? "failed" : "closed" });
            break;
        }
      },
    });
    controllerRef.current = controller;
    if (handlers.current.workspace) controller.setWorkspace(handlers.current.workspace);
    controller.setEncoding(encodingRef.current);
    // Deferred one tick so a development double-mount is cancelled before it connects anywhere.
    // A handed-over session is taken over once; a later attempt (reconnect) never reuses the token.
    const token = attempt === 0 ? handlers.current.attachToken : undefined;
    const timer = window.setTimeout(() => void controller.start(target, attempt === 0 ? (props.startIn ?? null) : null, token), 0);
    return () => {
      window.clearTimeout(timer);
      controller.dispose();
      controllerRef.current = null;
    };
    // `target` is fixed for the life of a pane; `attempt` drives reconnects; `pending` the first start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, pending]);

  // The host's paste checks can change while the session is open (the user edits the host).
  const skipMultiline = props.pasteChecks?.multiline === false;
  const skipNewline = props.pasteChecks?.trailingNewline === false;
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller) controller.pasteChecks = { multiline: !skipMultiline, trailingNewline: !skipNewline };
  }, [attempt, skipMultiline, skipNewline]);

  // Counts down to the next automatic attempt; cancelled by unmount, Cancel or Reconnect now.
  useEffect(() => {
    if (!autoRetry) return;
    const fire = window.setTimeout(() => {
      setAutoRetry(null);
      setAttempt((n) => n + 1);
    }, Math.max(0, autoRetry.dueAt - Date.now()));
    return () => window.clearTimeout(fire);
  }, [autoRetry]);

  /** Stops a connection in progress: answers an open prompt with no, then closes the session. */
  function cancelConnect() {
    const id = sessionId();
    if (id && trust) void sessions.answerTrust(id, trust.promptId, "cancel").catch(() => undefined);
    if (id && auth) void sessions.answerAuth(id, auth.promptId, null).catch(() => undefined);
    setTrust(null);
    setAuth(null);
    setAutoRetry(null);
    if (id) void sessions.close(id).catch(() => undefined);
    setClosed((current) => current ?? { error: null, exitStatus: null });
    publish({ state: "closed" });
  }

  function reconnectNow() {
    setAutoRetry(null);
    autoAttempts.current = 0;
    setAttempt((n) => n + 1);
  }

  // Live preference changes keep the session and screen.
  useEffect(() => {
    controllerRef.current?.updatePreferences(prefs);
    if (props.workspace) controllerRef.current?.setWorkspace(props.workspace);
  }, [prefs, props.workspace]);

  useEffect(() => {
    const handle: PaneHandle = {
      focus: () => controllerRef.current?.focus(),
      openFind: () => setFindOpen(true),
      zoom: (step) => controllerRef.current?.setZoom(step),
      sessionId: () => controllerRef.current?.id ?? null,
      bracketedPaste: () => controllerRef.current?.bracketedPaste ?? false,
      connected: () => status.current.state === "connected",
      broadcastable: () => controllerRef.current?.broadcastable ?? false,
      receiveBroadcast: (bytes) => {
        if (status.current.state === "connected") controllerRef.current?.receiveBroadcast(bytes);
      },
      encoding: () => encodingRef.current,
      release: (on) => controllerRef.current?.release(on),
      copy: () => controllerRef.current?.copy() ?? Promise.resolve(false),
      paste: () => controllerRef.current?.paste(),
      jumpCommand: (direction) => controllerRef.current?.jumpCommand(direction) ?? false,
      setEncoding: (id) => {
        encodingRef.current = encodingById(id).id;
        setEncodingId(encodingRef.current);
        controllerRef.current?.setEncoding(encodingRef.current);
      },
      environment: () => environment.current,
      searchScrollback: (query, caseSensitive) => controllerRef.current?.searchScrollback(query, caseSensitive) ?? { matches: [], truncated: false },
      revealMatch: (match) => controllerRef.current?.revealMatch(match),
      commands: () => controllerRef.current?.commandOutputs.list() ?? [],
      commandOutput: (id) => controllerRef.current?.commandOutputs.output(id) ?? null,
    };
    handlers.current.register(handle);
    return () => handlers.current.register(null);
  }, []);

  // Offered once the restored session is connected; never sent without a click.
  useEffect(() => {
    if (directoryOffer === "waiting" && state === "connected") setDirectoryOffer("shown");
  }, [directoryOffer, state]);

  const needsAttention = trust !== null || auth !== null;
  const indicator: TabIndicator = pending ? "idle" : closed ? (closed.error ? "bad" : "idle") : needsAttention ? "attention" : state === "connected" ? "ok" : "busy";
  useEffect(() => {
    handlers.current.onIndicator(indicator);
  }, [indicator]);

  // A change to the pane itself (shown, focused, a prompt or the find bar closing) takes focus.
  // A session state change alone (connecting -> connected) only keeps focus that is already here
  // or nowhere, so it never pulls the keyboard away from what the user moved on to.
  const paneKey = `${visible}|${focused}|${needsAttention}|${closed !== null}|${findOpen}`;
  const lastPaneKey = useRef("");
  useEffect(() => {
    const paneChanged = lastPaneKey.current !== paneKey;
    lastPaneKey.current = paneKey;
    if (!visible) return;
    controllerRef.current?.refit();
    if (!focused || needsAttention || closed || findOpen) return;
    const pane = hostRef.current?.parentElement ?? null;
    const active = document.activeElement;
    const focusHereOrNowhere = !active || active === document.body || (pane?.contains(active) ?? false);
    if (paneChanged ? !userIsElsewhere(pane) : focusHereOrNowhere) controllerRef.current?.focus();
  }, [paneKey, visible, focused, needsAttention, closed, state, findOpen]);

  const sessionId = () => controllerRef.current?.id ?? null;

  function answerTrust(decision: "cancel" | "once" | "always") {
    const id = sessionId();
    if (id && trust) void sessions.answerTrust(id, trust.promptId, decision).catch(() => undefined);
    setTrust(null);
  }

  const scheme = schemeById(prefs.scheme);
  const paneStyle = {
    "--term-bg": scheme.background,
    "--pane-fg": scheme.foreground,
    "--term-padding": `${prefs.padding}px`,
  } as CSSProperties;
  const showPrompts = visible;

  return (
    <div
      className="terminal-pane"
      style={{ ...paneStyle, position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}
      hidden={!visible}
      role="group"
      aria-label={msg.terminal.focusPane(label)}
      onMouseDown={() => handlers.current.onFocus()}
      onFocusCapture={() => handlers.current.onFocus()}
    >
      <div className="terminal-host" ref={hostRef} data-pane={props.paneId} data-encoding={encodingId} />
      {encodingId !== "utf-8" && (
        <span className="term-encoding" title={msgC.encoding.badge(encodingLabel(encodingId))}>
          {encodingLabel(encodingId)}
        </span>
      )}

      {pending && (
        <div className="terminal-overlay">
          <div className="overlay-card" role="group" aria-label={msgC.restore.waiting(label)}>
            <div className="dialog-head">
              <span className="dialog-icon" data-tone="accent" aria-hidden="true">
                <IconPlug size={18} />
              </span>
              <h2>{msgC.restore.title}</h2>
            </div>
            <p className="muted">{msgC.restore.body(identity || label)}</p>
            <div className="dialog-actions">
              {props.onConnectAll && (
                <button type="button" className="btn" onClick={() => props.onConnectAll?.()}>
                  {msgC.restore.connectAll}
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={() => props.onConnect?.()} data-autofocus>
                <IconPlug size={15} />
                {msgC.restore.connect}
              </button>
            </div>
          </div>
        </div>
      )}

      {directoryOffer === "shown" && props.restoreDirectory && visible && (
        <div className="term-banner" role="group" aria-label={msgC.restore.directoryTitle}>
          <IconFolder size={16} />
          <span className="stack-xs" style={{ minWidth: 0 }}>
            <span>{msgC.restore.directoryBody}</span>
            <code className="mono truncate" data-testid="restore-command">
              {cdCommand(props.restoreDirectory)}
            </code>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              controllerRef.current?.sendConfirmedCommand(cdCommand(props.restoreDirectory as string));
              setDirectoryOffer("done");
              controllerRef.current?.focus();
            }}
          >
            {msgC.restore.directoryRun}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setDirectoryOffer("done");
              controllerRef.current?.focus();
            }}
          >
            {msgC.restore.directoryDismiss}
          </button>
        </div>
      )}

      {findOpen && (
        <FindBar
          count={findCount}
          onFind={(query, options, direction) => controllerRef.current?.find(query, options, direction)}
          onClose={() => {
            setFindOpen(false);
            controllerRef.current?.clearFind();
            controllerRef.current?.focus();
          }}
        />
      )}

      {!pending && (closed !== null || state !== "connected" || needsAttention) && (
        <ConnectionSheet
          ssh={target.kind === "ssh"}
          label={label}
          identity={identity}
          timeline={timeline}
          startedAt={startedAt}
          trust={showPrompts ? trust : null}
          auth={showPrompts && !trust ? auth : null}
          changed={changed}
          closed={closed}
          everConnected={everConnected.current}
          autoRetry={autoRetry}
          banner={banner}
          interactive={visible && focused}
          onTrust={answerTrust}
          onAuth={(secret) => {
            const id = sessionId();
            if (id && auth) void sessions.answerAuth(id, auth.promptId, secret).catch(() => undefined);
            setAuth(null);
          }}
          onCancel={cancelConnect}
          onReconnect={reconnectNow}
          onStopRetry={() => setAutoRetry(null)}
          onCloseTab={() => handlers.current.onClose()}
          onOpenKnownHosts={() => handlers.current.onOpenKnownHosts()}
          onOpenLog={target.kind === "ssh" ? () => setLogOpen(true) : null}
          onOpenDetails={target.kind === "ssh" ? () => setDetailsFor(controllerRef.current?.id ?? null) : null}
          onInstallKey={target.kind === "ssh" && rejectedKey && closed?.error?.code === "AUTH_FAILED" ? () => setInstalling(true) : null}
          canReconnect={props.canReconnect !== false}
        />
      )}

      {clipboardAsk !== null && visible && (
        <div className="term-banner" role="alertdialog" aria-label={msg.terminal.clipboardRequest}>
          <IconShieldAlert size={16} />
          <span>{msg.terminal.clipboardRequest}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              clipboardAllowed.current = true;
              publish({ clipboardAllowed: true });
              const text = clipboardAsk;
              setClipboardAsk(null);
              void navigator.clipboard.writeText(text).catch(() => undefined);
              controllerRef.current?.focus();
            }}
          >
            {msg.terminal.clipboardAllow}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setClipboardAsk(null);
              controllerRef.current?.focus();
            }}
          >
            {msg.terminal.clipboardDeny}
          </button>
        </div>
      )}

      {token && (
        <TokenMenu
          token={token}
          onClose={() => {
            setToken(null);
            controllerRef.current?.focus();
          }}
        />
      )}
      {detailsFor && <ConnectionDetails sessionId={detailsFor} label={props.label} onClose={() => setDetailsFor(null)} />}
      {installing && target.kind === "ssh" && rejectedKey && (
        <InstallKeyDialog hostId={target.hostId} keyId={rejectedKey.keyId} onClose={() => setInstalling(false)} />
      )}

      {logOpen && controllerRef.current?.id && (
        <ConnectionLogDialog sessionId={controllerRef.current.id} title={props.label} onClose={() => setLogOpen(false)} />
      )}

      {link !== null && (
        <LinkDialog
          url={link}
          onClose={() => {
            setLink(null);
            controllerRef.current?.focus();
          }}
          onOpened={(url) => notify("info", msg.terminal.linkOpened(url))}
        />
      )}

      {paste && (
        <PasteReviewDialog
          text={paste.text}
          check={paste.check}
          bracketed={paste.bracketed}
          target={{ name: label, identity, labels: props.targetLabels }}
          onCancel={() => setPaste(null)}
          onSend={(text) => {
            paste.send(text);
            setPaste(null);
          }}
        />
      )}
    </div>
  );
}

function FindBar({
  count,
  onFind,
  onClose,
}: {
  count: { index: number; total: number };
  onFind: (query: string, options: { caseSensitive: boolean; regex: boolean }, direction: "next" | "previous") => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const options = { caseSensitive, regex };

  return (
    <div
      role="search"
      className="find-bar"
      aria-label={msg.terminal.find}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <IconSearch size={14} className="faint" />
      <input
        aria-label={msg.terminal.findPlaceholder}
        placeholder={msg.terminal.findPlaceholder}
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          onFind(event.target.value, options, "next");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onFind(query, options, event.shiftKey ? "previous" : "next");
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {query ? msg.terminal.findCount(count.index, count.total) : ""}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-pressed={caseSensitive}
        data-tooltip={msg.terminal.caseSensitive}
        aria-label={msg.terminal.caseSensitive}
        onClick={() => setCaseSensitive((v) => !v)}
        style={caseSensitive ? { color: "var(--accent-text)" } : undefined}
      >
        Aa
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-pressed={regex}
        data-tooltip={msg.terminal.regex}
        aria-label={msg.terminal.regex}
        onClick={() => setRegex((v) => !v)}
        style={regex ? { color: "var(--accent-text)" } : undefined}
      >
        .*
      </button>
      <IconButton size="sm" label={msg.terminal.findPrev} onClick={() => onFind(query, options, "previous")}>
        <IconChevronLeft size={15} style={{ transform: "rotate(90deg)" }} />
      </IconButton>
      <IconButton size="sm" label={msg.terminal.findNext} onClick={() => onFind(query, options, "next")}>
        <IconChevronDown size={15} />
      </IconButton>
      <IconButton size="sm" label={msg.terminal.findClose} onClick={onClose}>
        <IconX size={15} />
      </IconButton>
    </div>
  );
}

function LinkDialog({ url, onClose, onOpened }: { url: string; onClose: () => void; onOpened: (url: string) => void }) {
  const check = checkLink(url);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={msg.terminal.linkTitle} icon={<IconExternalLink size={18} />} onDismiss={onClose}>
      {check.ok ? (
        <>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.terminal.linkBody}
          </p>
          <dl className="kv">
            <dt>{msg.terminal.linkHost}</dt>
            <dd>
              <strong>{check.host}</strong>
            </dd>
          </dl>
          <pre className="code-block" data-testid="link-destination">
            {url}
          </pre>
        </>
      ) : (
        <Notice tone="warning">{msg.terminal.linkRefused}</Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        {check.ok && (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(url).catch(() => undefined);
                onClose();
              }}
            >
              <IconCopy size={15} />
              {msg.terminal.linkCopy}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                links
                  .open(url)
                  .then(() => {
                    onOpened(url);
                    onClose();
                  })
                  .catch((e: { message?: string }) => setError(e.message ?? msg.terminal.linkRefused));
              }}
            >
              <IconExternalLink size={15} />
              {msg.terminal.linkOpen}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function AuthDialog({ prompt, banner, onAnswer }: { prompt: AuthPrompt; banner: string | null; onAnswer: (secret: string | null) => void }) {
  const [secret, setSecret] = useState("");
  const isPassword = prompt.kind === "password";
  const isKbd = prompt.kind === "keyboard_interactive";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (secret === "") return;
    const value = secret;
    setSecret("");
    onAnswer(value);
  }

  const title = isKbd ? msg.terminal.kbdTitle(prompt.username) : isPassword ? msg.terminal.passwordTitle(prompt.username) : msg.terminal.passphraseTitle;
  const body = isKbd ? msg.terminal.kbdBody : isPassword ? msg.terminal.passwordBody : msg.terminal.passphraseBody;
  const label = isKbd ? msg.terminal.kbdAnswer : isPassword ? msg.hosts.password : msg.keys.passphrase;

  return (
    <Dialog title={title} icon={<IconKeyRound size={18} />} onDismiss={() => onAnswer(null)}>
      <form className="stack" onSubmit={submit}>
        {/* agent B: tunnels and history */}
        <HopNotice hop={prompt.hop} />
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {body}
        </p>
        {banner && (isPassword || isKbd) && (
          <div className="stack-xs">
            <span className="label">{msg.terminal.banner}</span>
            {/* Server-supplied text: rendered as plain text, never as markup. */}
            <pre className="banner-text">{banner}</pre>
          </div>
        )}
        {isKbd && prompt.message && (
          <div className="stack-xs">
            <span className="label">{msg.terminal.kbdQuestion}</span>
            {/* Server-supplied, sanitized by the core, still untrusted: plain text only. */}
            <pre className="banner-text" data-testid="kbd-question">
              {prompt.message}
            </pre>
          </div>
        )}
        {prompt.attempt > 1 && (
          <Notice tone="warning">
            {msg.terminal.retryHint} {msg.terminal.attempt(prompt.attempt, prompt.maxAttempts)}
          </Notice>
        )}
        {isKbd && prompt.echo ? (
          <TextField label={label} value={secret} onChange={setSecret} autoFocus maxLength={1024} autoComplete="off" spellCheck={false} />
        ) : (
          <SecretField label={label} value={secret} onChange={setSecret} autoFocus maxLength={1024} />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onAnswer(null)}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={secret === ""}>
            {msg.terminal.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * True when focus sits in a text field, dialog or menu outside this terminal: a session that
 * finishes connecting must not pull the keyboard away from, say, a tab being renamed.
 */
function userIsElsewhere(pane: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  if (pane?.contains(active)) return false;
  // Another terminal's input is not "elsewhere": the pane that became focused takes over.
  if (active.classList.contains("xterm-helper-textarea")) return false;
  return active.matches("input, textarea, select, [contenteditable='true']") || active.closest("dialog, [role='menu']") !== null;
}

import type { IpcError, SessionEvent, SessionState, TerminalPreferences } from "@tyrminal/contracts";
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { IconButton, Notice, SecretField, TextField } from "../../components/ui/controls";
import {
  IconChevronDown,
  IconChevronLeft,
  IconClipboardPaste,
  IconCopy,
  IconExternalLink,
  IconKeyRound,
  IconRefreshCw,
  IconSearch,
  IconShieldAlert,
  IconShieldCheck,
  IconTriangleAlert,
  IconX,
} from "../../components/ui/icons";
import { links, sessions } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { type RendererKind, TerminalController, type TerminalTarget } from "./TerminalController";
import { schemeById } from "./schemes";
import { checkLink, groupFingerprint, lineCount } from "./terminalPolicy";

type TrustPrompt = Extract<SessionEvent, { type: "trust_prompt" }>;
type AuthPrompt = Extract<SessionEvent, { type: "auth_prompt" }>;
type KeyChanged = Extract<SessionEvent, { type: "host_key_changed" }>;

export type TabIndicator = "busy" | "ok" | "bad" | "attention" | "idle";

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
}

interface TerminalViewProps {
  paneId: number;
  target: TerminalTarget;
  /** Where this session goes, as configured by the user (not supplied by the server). */
  identity: string;
  label: string;
  /** The tab holding this pane is in front. */
  visible: boolean;
  /** This pane has keyboard focus within its tab. */
  focused: boolean;
  prefs: TerminalPreferences;
  onIndicator: (indicator: TabIndicator) => void;
  onTitle: (title: string) => void;
  onStatus: (status: PaneStatus) => void;
  onFocus: () => void;
  onOpenKnownHosts: () => void;
  onClose: () => void;
  register: (handle: PaneHandle | null) => void;
}

function Fingerprint({ value }: { value: string }) {
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

const STEPS: SessionState[] = ["connecting", "verifying_host", "authenticating", "opening_channel", "connected"];

export function TerminalView(props: TerminalViewProps) {
  const { target, identity, label, visible, focused, prefs } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const notify = useToast();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SessionState>("connecting");
  const [trust, setTrust] = useState<TrustPrompt | null>(null);
  const [auth, setAuth] = useState<AuthPrompt | null>(null);
  const [changed, setChanged] = useState<KeyChanged | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [closed, setClosed] = useState<{ error: IpcError | null; exitStatus: number | null } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [paste, setPaste] = useState<{ text: string; bracketed: boolean; confirm: () => void } | null>(null);
  const [clipboardAsk, setClipboardAsk] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findCount, setFindCount] = useState({ index: 0, total: 0 });
  const clipboardAllowed = useRef(false);
  const status = useRef<PaneStatus>({ state: "connecting", renderer: "dom", cols: 0, rows: 0, clipboardAllowed: false });

  // Callbacks change identity every render; the controller needs stable ones.
  const handlers = useRef(props);
  handlers.current = props;

  function publish(patch: Partial<PaneStatus>) {
    status.current = { ...status.current, ...patch };
    handlers.current.onStatus(status.current);
  }

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    setState("connecting");
    setTrust(null);
    setAuth(null);
    setChanged(null);
    setBanner(null);
    setClosed(null);
    clipboardAllowed.current = false;
    publish({ state: "connecting", clipboardAllowed: false });

    const controller = new TerminalController(container, handlers.current.prefs, {
      onTitle: (title) => handlers.current.onTitle(title),
      onLink: (url) => setLink(url),
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
      onPasteReview: (text, bracketed, confirm) => setPaste({ text, bracketed, confirm }),
      onRenderer: (kind, fellBack) => {
        publish({ renderer: kind });
        if (fellBack && handlers.current.prefs.renderer === "auto" && kind === "dom" && controllerRef.current) {
          notify("info", msg.terminal.rendererFallback);
        }
      },
      onResize: (cols, rows) => publish({ cols, rows }),
      onSearchResults: (index, total) => setFindCount({ index, total }),
      onEvent: (event) => {
        switch (event.type) {
          case "state":
            setState(event.state);
            publish({ state: event.state });
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
          case "negotiated":
            publish({ security: { cipher: event.cipher, kex: event.kex, mac: event.mac, hostKey: event.hostKey, strictKex: event.strictKex } });
            break;
          case "closed":
            setTrust(null);
            setAuth(null);
            setClipboardAsk(null);
            setClosed({ error: event.error, exitStatus: event.exitStatus });
            publish({ state: event.error ? "failed" : "closed" });
            break;
        }
      },
    });
    controllerRef.current = controller;
    // Deferred one tick so a development double-mount is cancelled before it connects anywhere.
    const timer = window.setTimeout(() => void controller.start(target), 0);
    return () => {
      window.clearTimeout(timer);
      controller.dispose();
      controllerRef.current = null;
    };
    // `target` is fixed for the life of a pane; `attempt` drives reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Live preference changes keep the session and screen.
  useEffect(() => {
    controllerRef.current?.updatePreferences(prefs);
  }, [prefs]);

  useEffect(() => {
    const handle: PaneHandle = {
      focus: () => controllerRef.current?.focus(),
      openFind: () => setFindOpen(true),
      zoom: (step) => controllerRef.current?.setZoom(step),
      sessionId: () => controllerRef.current?.id ?? null,
      bracketedPaste: () => controllerRef.current?.bracketedPaste ?? false,
      connected: () => status.current.state === "connected",
    };
    handlers.current.register(handle);
    return () => handlers.current.register(null);
  }, []);

  const needsAttention = trust !== null || auth !== null;
  const indicator: TabIndicator = closed ? (closed.error ? "bad" : "idle") : needsAttention ? "attention" : state === "connected" ? "ok" : "busy";
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
  const connecting = !closed && state !== "connected" && !needsAttention;
  const stepIndex = Math.max(0, STEPS.indexOf(state));
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
      <div className="terminal-host" ref={hostRef} data-pane={props.paneId} />

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

      {connecting && (
        <div className="connecting" role="status" aria-live="polite">
          <div className="connecting-card">
            <span className="spinner" aria-hidden="true" />
            <span>
              {target.kind === "ssh" ? msg.terminal.connectingTo(identity) : msg.terminal.state.connecting}
              <span className="faint"> · {msg.terminal.state[state]}</span>
            </span>
            {target.kind === "ssh" && (
              <span className="connect-steps" aria-hidden="true">
                {STEPS.slice(0, 4).map((step, index) => (
                  <span key={step} data-done={index <= stepIndex} />
                ))}
              </span>
            )}
          </div>
        </div>
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

      {closed && (
        <div className="terminal-overlay">
          <div className="overlay-card" role={closed.error ? "alert" : "status"}>
            <div className="dialog-head">
              <span className="dialog-icon" data-tone={changed ? "danger" : closed.error ? "warning" : "accent"} aria-hidden="true">
                {changed ? <IconShieldAlert size={18} /> : closed.error ? <IconTriangleAlert size={18} /> : <IconRefreshCw size={18} />}
              </span>
              <h2>{changed ? msg.terminal.changedTitle : closed.error ? msg.terminal.failedTitle : msg.terminal.endedTitle}</h2>
            </div>
            {changed ? (
              <>
                <p>{msg.terminal.changedIntro}</p>
                <div className="stack-xs">
                  <span className="label">{msg.terminal.changedPresented}</span>
                  <Fingerprint value={changed.presentedFingerprint} />
                </div>
                <div className="stack-xs">
                  <span className="label">{msg.terminal.changedTrusted}</span>
                  {changed.trustedFingerprints.map((fingerprint) => (
                    <Fingerprint key={fingerprint} value={fingerprint} />
                  ))}
                </div>
                <Notice tone="warning">{msg.terminal.changedNext}</Notice>
              </>
            ) : closed.error ? (
              <>
                <p>{closed.error.message}</p>
                <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
                  {msg.terminal.safe} <span className="mono selectable">{msg.app.diagnostic(closed.error.code)}</span>
                </p>
              </>
            ) : (
              <p className="muted">{closed.exitStatus !== null ? msg.terminal.endedExit(closed.exitStatus) : msg.terminal.endedClean}</p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => handlers.current.onClose()}>
                {msg.terminal.closeTab}
              </button>
              {changed ? (
                <button type="button" className="btn btn-primary" onClick={() => handlers.current.onOpenKnownHosts()}>
                  {msg.terminal.openKnownHosts}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)} autoFocus={visible && focused} data-autofocus>
                  <IconRefreshCw size={15} />
                  {msg.terminal.reconnect}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Prompts appear only while their tab is in front; a background tab shows an indicator. */}
      {showPrompts && trust && (
        <Dialog title={msg.terminal.trustTitle} role="alertdialog" icon={<IconShieldCheck size={18} />} onDismiss={() => answerTrust("cancel")}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.terminal.trustIntro}
          </p>
          <dl className="kv">
            <dt>{msg.terminal.host}</dt>
            <dd>
              {trust.host} : {trust.port}
            </dd>
            {trust.resolvedAddress && trust.resolvedAddress !== trust.host && (
              <>
                <dt>{msg.terminal.resolved}</dt>
                <dd>{trust.resolvedAddress}</dd>
              </>
            )}
            <dt>{msg.terminal.algorithm}</dt>
            <dd>{trust.algorithm}</dd>
          </dl>
          <div className="stack-xs">
            <span className="label">{msg.terminal.fingerprint}</span>
            <Fingerprint value={trust.fingerprint} />
          </div>
          <div className="dialog-actions">
            {/* The safe choice has initial focus, so Enter never grants trust by accident. */}
            <button type="button" className="btn" onClick={() => answerTrust("cancel")} autoFocus data-autofocus>
              {msg.terminal.trustCancel}
            </button>
            <button type="button" className="btn" onClick={() => answerTrust("once")}>
              {msg.terminal.trustOnce}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => answerTrust("always")}>
              {msg.terminal.trustAlways}
            </button>
          </div>
        </Dialog>
      )}

      {showPrompts && auth && !trust && (
        <AuthDialog
          key={auth.promptId}
          prompt={auth}
          banner={banner}
          onAnswer={(secret) => {
            const id = sessionId();
            if (id) void sessions.answerAuth(id, auth.promptId, secret).catch(() => undefined);
            setAuth(null);
          }}
        />
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
        <Dialog title={msg.terminal.pasteTitle} icon={<IconClipboardPaste size={18} />} tone="warning" wide onDismiss={() => setPaste(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.terminal.pasteBody(lineCount(paste.text))}
          </p>
          <pre className="code-block">{paste.text}</pre>
          {paste.bracketed && <Notice tone="info">{msg.terminal.pasteBracketed}</Notice>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setPaste(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                paste.confirm();
                setPaste(null);
              }}
            >
              {msg.terminal.pasteSend}
            </button>
          </div>
        </Dialog>
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

function AuthDialog({ prompt, banner, onAnswer }: { prompt: AuthPrompt; banner: string | null; onAnswer: (secret: string | null) => void }) {
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
  return active.matches("input, textarea, select, [contenteditable='true']") || active.closest("dialog, [role='menu']") !== null;
}

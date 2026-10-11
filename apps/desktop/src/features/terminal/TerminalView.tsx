import type { IpcError, SessionEvent, SessionState } from "@tyrminal/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Notice, SecretField } from "../../components/ui/controls";
import { sessions } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { TerminalController, type TerminalTarget } from "./TerminalController";
import { groupFingerprint } from "./terminalPolicy";

type TrustPrompt = Extract<SessionEvent, { type: "trust_prompt" }>;
type AuthPrompt = Extract<SessionEvent, { type: "auth_prompt" }>;
type KeyChanged = Extract<SessionEvent, { type: "host_key_changed" }>;

export type TabIndicator = "busy" | "ok" | "bad" | "attention" | "idle";

interface TerminalViewProps {
  target: TerminalTarget;
  /** Where this session goes, as configured by the user (not supplied by the server). */
  identity: string;
  active: boolean;
  onIndicator: (indicator: TabIndicator) => void;
  onTitle: (title: string) => void;
  onOpenKnownHosts: () => void;
  onCloseTab: () => void;
}

function Fingerprint({ value }: { value: string }) {
  const { algorithm, groups } = groupFingerprint(value);
  return (
    <div className="fingerprint" aria-label={value}>
      {algorithm && <span className="muted">{algorithm}:</span>}
      {groups.map((group, index) => (
        // Position is the identity here: the groups are a fixed split of one string.
        <span key={`${index}-${group}`} aria-hidden="true">
          {group}
        </span>
      ))}
    </div>
  );
}

export function TerminalView({ target, identity, active, onIndicator, onTitle, onOpenKnownHosts, onCloseTab }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SessionState>("connecting");
  const [trust, setTrust] = useState<TrustPrompt | null>(null);
  const [auth, setAuth] = useState<AuthPrompt | null>(null);
  const [changed, setChanged] = useState<KeyChanged | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [closed, setClosed] = useState<{ error: IpcError | null; exitStatus: number | null } | null>(null);

  // Callbacks change identity every render; the controller needs stable ones.
  const handlers = useRef({ onIndicator, onTitle });
  handlers.current = { onIndicator, onTitle };

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    setState("connecting");
    setTrust(null);
    setAuth(null);
    setChanged(null);
    setBanner(null);
    setClosed(null);

    const controller = new TerminalController(container, {
      onTitle: (title) => handlers.current.onTitle(title),
      onEvent: (event) => {
        switch (event.type) {
          case "state":
            setState(event.state);
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
          case "closed":
            setTrust(null);
            setAuth(null);
            setClosed({ error: event.error, exitStatus: event.exitStatus });
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
    // `target` is fixed for the life of a tab; `attempt` drives reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const needsAttention = trust !== null || auth !== null;
  const indicator: TabIndicator = closed
    ? closed.error
      ? "bad"
      : "idle"
    : needsAttention
      ? "attention"
      : state === "connected"
        ? "ok"
        : "busy";
  useEffect(() => {
    handlers.current.onIndicator(indicator);
  }, [indicator]);

  useEffect(() => {
    if (!active) return;
    controllerRef.current?.refit();
    if (!needsAttention && !closed) controllerRef.current?.focus();
  }, [active, needsAttention, closed, state]);

  const sessionId = () => controllerRef.current?.id ?? null;

  function answerTrust(decision: "cancel" | "once" | "always") {
    const id = sessionId();
    if (id && trust) void sessions.answerTrust(id, trust.promptId, decision).catch(() => undefined);
    setTrust(null);
  }

  const stateText = closed ? (closed.error ? msg.terminal.state.failed : msg.terminal.state.closed) : msg.terminal.state[state];

  return (
    <div className="terminal-pane" hidden={!active} role="tabpanel">
      <div className="terminal-host" ref={hostRef} />
      <div className="statusbar" role="status">
        <span className={`dot ${indicator === "ok" ? "dot-ok" : indicator === "bad" ? "dot-bad" : indicator === "idle" ? "" : "dot-busy"}`} aria-hidden="true" />
        <span>{stateText}</span>
        <span className="selectable">{identity}</span>
        <span className="spacer" />
        {!closed && (
          <button type="button" className="btn btn-quiet" style={{ height: 20, fontSize: "var(--text-xs)" }} onClick={onCloseTab}>
            {msg.common.close}
          </button>
        )}
      </div>

      {closed && (
        <div className="terminal-overlay">
          <div className="card" style={{ width: "min(560px, 100%)" }} role={closed.error ? "alert" : "status"}>
            <h2>{changed ? msg.terminal.changedTitle : closed.error ? msg.terminal.failedTitle : msg.terminal.endedTitle}</h2>
            {changed ? (
              <>
                <p>{msg.terminal.changedIntro}</p>
                <div className="stack-sm">
                  <span className="muted">{msg.terminal.changedPresented}</span>
                  <Fingerprint value={changed.presentedFingerprint} />
                </div>
                <div className="stack-sm">
                  <span className="muted">{msg.terminal.changedTrusted}</span>
                  {changed.trustedFingerprints.map((fingerprint) => (
                    <Fingerprint key={fingerprint} value={fingerprint} />
                  ))}
                </div>
                <Notice tone="warning" icon="!">
                  {msg.terminal.changedNext}
                </Notice>
              </>
            ) : closed.error ? (
              <>
                <p>{closed.error.message}</p>
                <p className="muted">
                  {msg.terminal.safe} <span className="mono">{msg.app.diagnostic(closed.error.code)}</span>
                </p>
              </>
            ) : (
              <p className="muted">
                {closed.exitStatus !== null ? msg.terminal.endedExit(closed.exitStatus) : msg.terminal.endedClean}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onCloseTab}>
                {msg.terminal.closeTab}
              </button>
              {changed ? (
                <button type="button" className="btn btn-primary" onClick={onOpenKnownHosts}>
                  {msg.terminal.openKnownHosts}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)} autoFocus>
                  {msg.terminal.reconnect}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Prompts appear only while their tab is in front; a background tab shows an indicator. */}
      {active && trust && (
        <Dialog title={msg.terminal.trustTitle} role="alertdialog" onDismiss={() => answerTrust("cancel")}>
          <p className="muted">{msg.terminal.trustIntro}</p>
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
          <div className="stack-sm">
            <span className="muted">{msg.terminal.fingerprint}</span>
            <Fingerprint value={trust.fingerprint} />
          </div>
          <div className="dialog-actions">
            {/* The safe choice has initial focus, so Enter never grants trust by accident. */}
            <button type="button" className="btn" onClick={() => answerTrust("cancel")} autoFocus>
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

      {active && auth && !trust && (
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
    </div>
  );
}

function AuthDialog({ prompt, banner, onAnswer }: { prompt: AuthPrompt; banner: string | null; onAnswer: (secret: string | null) => void }) {
  const [secret, setSecret] = useState("");
  const isPassword = prompt.kind === "password";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (secret === "") return;
    const value = secret;
    setSecret("");
    onAnswer(value);
  }

  return (
    <Dialog title={isPassword ? msg.terminal.passwordTitle(prompt.username) : msg.terminal.passphraseTitle} onDismiss={() => onAnswer(null)}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{isPassword ? msg.terminal.passwordBody : msg.terminal.passphraseBody}</p>
        {banner && isPassword && (
          <div className="stack-sm">
            <span className="muted">{msg.terminal.banner}</span>
            {/* Server-supplied text: rendered as plain text, never as markup. */}
            <pre className="banner-text">{banner}</pre>
          </div>
        )}
        {prompt.attempt > 1 && (
          <Notice tone="warning" icon="!">
            {msg.terminal.retryHint} {msg.terminal.attempt(prompt.attempt, prompt.maxAttempts)}
          </Notice>
        )}
        <SecretField
          label={isPassword ? msg.hosts.password : msg.keys.passphrase}
          value={secret}
          onChange={setSecret}
          autoFocus
          maxLength={1024}
        />
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

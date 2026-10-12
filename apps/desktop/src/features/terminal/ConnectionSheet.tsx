import type { ChainPosition, HostOs, IpcError, SessionEvent, SessionState } from "@tyrminal/contracts";
import { type FormEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { useWindowFocused } from "../../components/ui/Wordmark";
import { SecretField, TextField } from "../../components/ui/controls";
import { IconCheck, IconCircleAlert, IconRefreshCw, IconScrollText, IconServer, IconShieldAlert, IconX } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgConnect } from "../../lib/messages-connect";
import { msgC } from "../../lib/messages-c";
import { msgD } from "../../lib/messages-d";
import { OsIcon } from "../hosts/OsIcon";
import { HopNotice } from "../tunnels/HopNotice";
import { ConnectTrack, type TrackStop, trackStates } from "./ConnectTrack";
import { RECONNECT_MAX_ATTEMPTS, groupFingerprint } from "./terminalPolicy";

type TrustPrompt = Extract<SessionEvent, { type: "trust_prompt" }>;
type AuthPrompt = Extract<SessionEvent, { type: "auth_prompt" }>;
type KeyChanged = Extract<SessionEvent, { type: "host_key_changed" }>;

/** One thing the session reported while connecting, with when it arrived here. */
export interface TimelineEntry {
  step: SessionState | "keys";
  at: number;
  detail?: string;
  hop?: ChainPosition | null;
}

/** Turns the session's events into timeline entries; anything else is ignored. */
export function timelineEntry(event: SessionEvent, at: number): TimelineEntry | null {
  // `hop` on state events arrives with a core change; until then it is simply absent.
  const hop = (event as { hop?: ChainPosition | null }).hop ?? null;
  if (event.type === "state") return { step: event.state, at, hop };
  if (event.type === "negotiated") return { step: "keys", at, detail: event.kex, hop };
  return null;
}

type RowKind = "done" | "now" | "fail" | "pending";
interface Row {
  kind: RowKind | "hop";
  label: string;
  detail?: ReactNode;
  time?: string;
}

const SSH_ORDER = ["resolving", "connecting", "keys", "verifying_host", "authenticating", "opening_channel"] as const;
type Step = (typeof SSH_ORDER)[number];
const isStep = (s: string): s is Step => (SSH_ORDER as readonly string[]).includes(s);

/**
 * Rows for the steps that really happened, in the order they arrived, then the remaining steps
 * of this connection, faint. Durations are measured between the events' arrival here; nothing is
 * estimated. Key-exchange details are shown only when they arrive before the identity check.
 */
function buildRows(props: {
  timeline: TimelineEntry[];
  startedAt: number;
  now: number;
  ssh: boolean;
  label: string;
  failed: boolean;
  trust: TrustPrompt | null;
  auth: AuthPrompt | null;
}): Row[] {
  const { timeline, startedAt, now, ssh, label, failed, trust, auth } = props;
  const entries: TimelineEntry[] = [];
  for (const e of timeline) {
    if (!isStep(e.step)) continue;
    const previous = entries.at(-1);
    const sameHop = (previous?.hop?.index ?? 0) === (e.hop?.index ?? 0);
    if (previous && previous.step === e.step && sameHop) continue;
    // Late key-exchange details (sent only once connected) are not a step of their own.
    if (e.step === "keys" && previous && sameHop && SSH_ORDER.indexOf(previous.step as Step) > SSH_ORDER.indexOf("keys")) continue;
    entries.push(e);
  }
  if (entries.length === 0) entries.push({ step: "connecting", at: startedAt });

  const rows: Row[] = [];
  let hopIndex = -1;
  entries.forEach((e, i) => {
    const hop = e.hop ?? null;
    if (hop && hop.index !== hopIndex) {
      hopIndex = hop.index;
      rows.push({ kind: "hop", label: msgConnect.hop(hop.label, hop.index, hop.total) });
    }
    const words = msgConnect.step[e.step as Step];
    const next = entries[i + 1];
    if (next) {
      rows.push({
        kind: "done",
        label: words.done,
        detail: e.step === "keys" && e.detail ? <span className="mono">{e.detail}</span> : undefined,
        time: msgConnect.ms(Math.max(0, next.at - e.at)),
      });
      return;
    }
    const waited = Math.floor((now - e.at) / 1000);
    let detail: ReactNode;
    if (e.step === "verifying_host" && trust) detail = msgConnect.newServer;
    else if (e.step === "authenticating" && auth) detail = null;
    else if (!failed && waited >= 10) detail = msgConnect.stillWaiting(waited);
    rows.push({ kind: failed ? "fail" : "now", label: words.now, detail });
  });

  if (ssh && !failed) {
    const last = entries.at(-1);
    const from = last ? SSH_ORDER.indexOf(last.step as Step) : 0;
    const remaining = ["verifying_host", "authenticating", "opening_channel"].filter((s) => SSH_ORDER.indexOf(s as Step) > from);
    const lastHop = last?.hop ?? null;
    for (const s of remaining) rows.push({ kind: "pending", label: msgConnect.step[s as Step].now });
    // Through jump hosts, the destination's own steps are still ahead.
    if (lastHop && lastHop.index < lastHop.total) {
      rows.push({ kind: "hop", label: msgConnect.hop(label, lastHop.total, lastHop.total) });
      for (const s of ["connecting", "verifying_host", "authenticating", "opening_channel"]) rows.push({ kind: "pending", label: msgConnect.step[s as Step].now });
    }
  }
  return rows;
}

function Steps({ rows }: { rows: Row[] }) {
  const focused = useWindowFocused();
  return (
    <ol className="connect-steps" aria-label={msgConnect.steps}>
      {rows.map((row, index) =>
        row.kind === "hop" ? (
          // Positions are the identity: rows are rebuilt from the same timeline each render.
          <li key={`h${index}`} className="connect-hop">
            {row.label}
          </li>
        ) : (
          // Keyed by state too, so a step that changes (pending, now, done) appears afresh.
          <li key={`r${index}-${row.kind}`} data-kind={row.kind} aria-current={row.kind === "now" ? "step" : undefined}>
            <span className="connect-marker" aria-hidden="true">
              {row.kind === "done" && <IconCheck size={14} />}
              {row.kind === "fail" && <IconX size={14} />}
              {row.kind === "now" && <span className="cursor-block" data-hollow={!focused} />}
            </span>
            <span className="connect-label">
              {row.label}
              {row.detail ? <span className="connect-detail">{row.detail}</span> : null}
            </span>
            {row.time && <span className="connect-time">{row.time}</span>}
          </li>
        ),
      )}
    </ol>
  );
}

/** A fingerprint in groups of four, never clipped; focusable so it can be read before answering. */
function Fingerprint({ value, autoFocus }: { value: string; autoFocus?: boolean }) {
  const { algorithm, groups } = groupFingerprint(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the fingerprint is focused first so Enter cannot answer a trust prompt by accident.
    <div ref={ref} className="fingerprint selectable" tabIndex={0} aria-label={value} data-testid="connect-fingerprint">
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

function AuthForm({ prompt, banner, onAnswer, autoFocus }: { prompt: AuthPrompt; banner: string | null; onAnswer: (secret: string | null) => void; autoFocus: boolean }) {
  const [secret, setSecret] = useState("");
  const isPassword = prompt.kind === "password";
  const isKbd = prompt.kind === "keyboard_interactive";
  const title = isKbd ? msg.terminal.kbdTitle(prompt.username) : isPassword ? msg.terminal.passwordTitle(prompt.username) : msg.terminal.passphraseTitle;
  const body = isKbd ? msg.terminal.kbdBody : isPassword ? msg.terminal.passwordBody : msg.terminal.passphraseBody;
  const label = isKbd ? msg.terminal.kbdAnswer : isPassword ? msg.hosts.password : msg.keys.passphrase;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (secret === "") return;
    const value = secret;
    setSecret("");
    onAnswer(value);
  }

  return (
    <form className="connect-prompt" onSubmit={submit} id="connect-auth" aria-label={title}>
      <h3>{title}</h3>
      <HopNotice hop={prompt.hop} />
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
      {isKbd && prompt.echo ? (
        <TextField label={label} value={secret} onChange={setSecret} autoFocus={autoFocus} maxLength={1024} autoComplete="off" spellCheck={false} />
      ) : (
        <SecretField label={label} value={secret} onChange={setSecret} autoFocus={autoFocus} maxLength={1024} />
      )}
      <p className="connect-hint">
        {body}
        {prompt.attempt > 1 && ` ${msg.terminal.retryHint} ${msg.terminal.attempt(prompt.attempt, prompt.maxAttempts)}.`}
      </p>
    </form>
  );
}

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Everything between opening a session and its shell, in the pane itself: the real steps, the
 * trust and sign-in prompts, a blocked or failed connection with its cause, and a lost
 * connection being retried. Built only from what the session reports; Cancel is always there.
 */
export function ConnectionSheet(props: {
  ssh: boolean;
  label: string;
  identity: string;
  timeline: TimelineEntry[];
  startedAt: number;
  trust: TrustPrompt | null;
  auth: AuthPrompt | null;
  changed: KeyChanged | null;
  closed: { error: IpcError | null; exitStatus: number | null } | null;
  everConnected: boolean;
  autoRetry: { attempt: number; dueAt: number } | null;
  banner: string | null;
  interactive: boolean;
  onTrust: (decision: "cancel" | "once" | "always") => void;
  onAuth: (secret: string | null) => void;
  onCancel: () => void;
  onReconnect: () => void;
  onStopRetry: () => void;
  onCloseTab: () => void;
  onOpenKnownHosts: () => void;
  onOpenLog: (() => void) | null;
  /** Offered when the server refused the host's key: install it on the server. */
  onInstallKey: (() => void) | null;
  /** False in a detached window: reconnecting happens from the main window. */
  canReconnect: boolean;
  /** The host's OS, for the icon on the host tile (null: a generic server mark). */
  os?: HostOs | null;
  /** The session just opened: the track settles while the sheet fades over the live shell. */
  settling?: boolean;
  /** Stops the track passed before connecting (quick connect's setup), shown done before its own. */
  leadStops?: TrackStop[] | undefined;
}) {
  const { ssh, label, identity, timeline, startedAt, trust, auth, changed, closed, autoRetry, banner, interactive } = props;
  const [now, setNow] = useState(() => Date.now());
  const [cancelled, setCancelled] = useState(false);
  // Failed attempts while this sheet is up (a lost connection being retried), oldest first.
  const failures = useRef<{ at: number; message: string }[]>([]);
  const lastClosed = useRef<typeof closed>(null);
  if (closed !== lastClosed.current) {
    lastClosed.current = closed;
    if (closed?.error && !changed && closed.error.code !== "CANCELLED") failures.current = [...failures.current, { at: Date.now(), message: closed.error.message }];
  }

  const connecting = !closed;
  useEffect(() => {
    if (!connecting && !autoRetry) return;
    const tick = window.setInterval(() => setNow(Date.now()), autoRetry ? 250 : 1000);
    return () => window.clearInterval(tick);
  }, [connecting, autoRetry]);
  useEffect(() => {
    if (connecting) setCancelled(false);
  }, [connecting, startedAt]);

  const failedNow = closed !== null && closed.error !== null;
  const settling = props.settling === true;
  const rows = buildRows({ timeline, startedAt, now, ssh, label, failed: failedNow || changed !== null, trust, auth });
  const retrying = failures.current.length > 0 && props.everConnected;

  function cancel() {
    setCancelled(true);
    props.onCancel();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || closed) return;
    event.stopPropagation();
    if (trust) props.onTrust("cancel");
    else cancel();
  }

  // In a detached window, reconnecting happens from the main window.
  const reconnect = (label: string) =>
    props.canReconnect ? (
      <button type="button" className="btn btn-primary" onClick={props.onReconnect} autoFocus={interactive} data-autofocus>
        <IconRefreshCw size={15} />
        {label}
      </button>
    ) : (
      <span className="connect-hint">{msgC.detach.reconnectInMain}</span>
    );

  let role: "alertdialog" | "alert" | "status" | "dialog" = "dialog";
  let tone: "danger" | "plain" = "plain";
  let title: string;
  let subtitle: ReactNode = <span className="mono">{identity}</span>;
  let body: ReactNode = null;
  let actions: ReactNode;
  // The session's connection log (ConnectionLogDialog), for when it is slow, stuck or failed.
  const log = props.onOpenLog ? (
    <button type="button" className="btn btn-ghost btn-sm" onClick={props.onOpenLog}>
      <IconScrollText size={14} />
      {msgD.connectionLog.open}
    </button>
  ) : null;

  if (changed) {
    role = "alert";
    tone = "danger";
    title = msg.terminal.changedTitle;
    subtitle = msg.terminal.changedIntro;
    body = (
      <>
        <HopNotice hop={changed.hop} />
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
        <p className="connect-hint">{msg.terminal.changedNext}</p>
      </>
    );
    actions = (
      <>
        <button type="button" className="btn btn-ghost" onClick={props.onOpenKnownHosts}>
          {msg.terminal.openKnownHosts}
        </button>
        <span className="grow" />
        {/* The safe choice is the primary and has focus. */}
        <button type="button" className="btn btn-primary" onClick={props.onCloseTab} autoFocus={interactive} data-autofocus>
          {msg.terminal.closeTab}
        </button>
      </>
    );
  } else if (closed && cancelled) {
    role = "status";
    title = msgConnect.cancelled;
    subtitle = msgConnect.cancelledBody;
    actions = (
      <>
        <span className="grow" />
        <button type="button" className="btn" onClick={props.onCloseTab}>
          {msg.terminal.closeTab}
        </button>
        {reconnect(msg.terminal.reconnect)}
      </>
    );
  } else if (closed?.error) {
    role = "alert";
    const lost = props.everConnected;
    title = lost ? msgConnect.lost : (msgConnect.failed[closed.error.code] ?? msg.terminal.failedTitle);
    subtitle = lost && failures.current[0] ? msgConnect.lostAt(label, clock(failures.current[0].at)) : closed.error.message;
    body = (
      <>
        {lost && <AttemptList failures={failures.current} />}
        {autoRetry && (
          <>
            <p className="connect-next" role="status" data-testid="auto-reconnect">
              {msg.terminal.autoReconnect(Math.max(0, Math.ceil((autoRetry.dueAt - now) / 1000)), autoRetry.attempt, RECONNECT_MAX_ATTEMPTS)}
            </p>
            <p className="connect-hint">{msgConnect.schedule}</p>
          </>
        )}
        <p className="connect-hint">
          {msg.terminal.safe} <span className="mono selectable">{msg.app.diagnostic(closed.error.code)}</span>
        </p>
      </>
    );
    actions = (
      <>
        <span className="grow" />
        <button type="button" className="btn" onClick={props.onCloseTab}>
          {msg.terminal.closeTab}
        </button>
        {props.onInstallKey && (
          <button type="button" className="btn" onClick={props.onInstallKey}>
            {msgD.installKey.fromFailure}
          </button>
        )}
        {autoRetry && (
          <button type="button" className="btn" onClick={props.onStopRetry}>
            {msg.terminal.cancelAutoReconnect}
          </button>
        )}
        {reconnect(autoRetry ? msg.terminal.reconnectNow : msg.terminal.reconnect)}
      </>
    );
  } else if (closed) {
    role = "status";
    title = msg.terminal.endedTitle;
    subtitle = closed.exitStatus !== null ? msg.terminal.endedExit(closed.exitStatus) : msg.terminal.endedClean;
    actions = (
      <>
        <span className="grow" />
        <button type="button" className="btn" onClick={props.onCloseTab}>
          {msg.terminal.closeTab}
        </button>
        {reconnect(msg.terminal.reconnect)}
      </>
    );
  } else if (trust) {
    role = "alertdialog";
    title = msg.terminal.trustTitle;
    subtitle = msg.terminal.trustIntro;
    body = (
      <>
        <HopNotice hop={trust.hop} />
        <div className="stack-xs">
          <span className="label">
            {msgConnect.fingerprintFrom(trust.algorithm, `${trust.resolvedAddress && trust.resolvedAddress !== trust.host ? trust.resolvedAddress : trust.host}:${trust.port}`)}
          </span>
          {/* Focus starts on the fingerprint, not a button, so Enter cannot grant trust by accident. */}
          <Fingerprint value={trust.fingerprint} autoFocus={interactive} />
        </div>
      </>
    );
    actions = (
      <>
        <span className="grow" />
        <button type="button" className="btn btn-ghost" onClick={() => props.onTrust("cancel")}>
          {msg.terminal.trustCancel}
        </button>
        <button type="button" className="btn" onClick={() => props.onTrust("once")}>
          {msg.terminal.trustOnce}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => props.onTrust("always")}>
          {msg.terminal.trustAlways}
        </button>
      </>
    );
  } else {
    title = settling ? msgConnect.step.connecting.done : retrying ? msgConnect.lost : msgConnect.connectingTo(label);
    if (ssh) subtitle = <span className="mono">{msgConnect.via(identity)}</span>;
    if (retrying) body = <AttemptList failures={failures.current} />;
    if (auth)
      body = (
        <>
          {retrying && <AttemptList failures={failures.current} />}
          <AuthForm key={auth.promptId} prompt={auth} banner={banner} onAnswer={props.onAuth} autoFocus={interactive} />
        </>
      );
    actions = (
      <>
        <span className="grow" />
        <button type="button" className="btn" onClick={cancel}>
          {msgConnect.cancel}
        </button>
        {auth && (
          <button type="submit" form="connect-auth" className="btn btn-primary">
            {msg.terminal.submit}
          </button>
        )}
      </>
    );
  }

  const mode = changed ? "changed" : closed && cancelled ? "cancelled" : closed?.error ? "failed" : closed ? "ended" : trust ? "trust" : auth ? "auth" : "connecting";
  const showSteps = ssh && !(closed && !closed.error) && !(closed && cancelled);
  // The track follows the same events as the steps; a lost connection's retries are told by the list.
  const showTrack = ssh && (settling || (showSteps && !retrying));
  const states = trackStates({ timeline, failed: failedNow, hostKeyChanged: changed !== null, trust: trust !== null, auth: auth !== null, connected: settling });
  return (
    <div
      className="connect-layer"
      data-dim={props.everConnected && closed !== null}
      data-leaving={settling || undefined}
      // Leaving: gone for input and assistive technology at once; the shell underneath is live.
      inert={settling || undefined}
      aria-hidden={settling || undefined}
    >
      <Sheet
        // A trust decision is a real dialog, like the modal it replaces; everything else is a region
        // of this pane, so application shortcuts and other tabs keep working while it connects.
        as={mode === "trust" ? "dialog" : "section"}
        className="connection-sheet"
        data-tone={tone}
        role={role}
        aria-labelledby="connect-title"
        aria-describedby="connect-sub"
        onKeyDown={onKeyDown}
      >
        <div className="connect-head" data-tile={ssh || undefined}>
          {ssh && (props.os ? <OsIcon os={props.os} /> : <span className="avatar connect-host-mark" aria-hidden="true"><IconServer size={16} /></span>)}
          <div className="connect-head-text">
            <h2 id={settling ? undefined : "connect-title"}>
              {tone === "danger" && <IconShieldAlert size={17} />}
              {role === "alert" && tone !== "danger" && <IconCircleAlert size={17} />}
              {title}
            </h2>
            <p id={settling ? undefined : "connect-sub"}>{subtitle}</p>
          </div>
          {ssh && !settling && log}
        </div>
        {showTrack && <ConnectTrack states={states} lead={props.leadStops} />}
        {retrying && !closed ? (
          <>
            {body}
            <Steps rows={rows} />
          </>
        ) : (
          <>
            {showSteps && !retrying && <Steps rows={rows} />}
            {body}
          </>
        )}
        {/* Keyed by what the sheet shows, so its buttons mount afresh and the right one takes focus. */}
        <div className="connect-actions" key={mode}>
          {actions}
        </div>
      </Sheet>
    </div>
  );
}

function Sheet({ as, children, ...rest }: { as: "dialog" | "section"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return as === "dialog" ? (
    <dialog open {...rest}>
      {children}
    </dialog>
  ) : (
    <section {...rest}>{children}</section>
  );
}

function AttemptList({ failures, dropped = true }: { failures: { at: number; message: string }[]; dropped?: boolean }) {
  return (
    <ol className="connect-steps" aria-label={msgConnect.steps}>
      {failures.map((f, index) => (
        <li key={f.at} data-kind="fail">
          <span className="connect-marker" aria-hidden="true">
            <IconX size={14} />
          </span>
          <span className="connect-label">
            {index === 0 && dropped ? msgConnect.dropped : msgConnect.attemptFailed(dropped ? index : index + 1)}
            <span className="connect-detail">{f.message}</span>
          </span>
          <span className="connect-time">{clock(f.at)}</span>
        </li>
      ))}
    </ol>
  );
}

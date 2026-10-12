import type { HostSummary, QuickAuth, QuickConnectInput, QuickProtocol } from "@tyrminal/contracts";
import { type FormEvent, type KeyboardEvent, useId, useMemo, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { ErrorNotice, SecretField, TextField } from "../../components/ui/controls";
import { IconChevronDown, IconSearch, IconServer } from "../../components/ui/icons";
import { type AppError, hosts as hostsApi, identities as identitiesApi, toAppError } from "../../lib/ipc";
import { msgQuick } from "../../lib/messages-quick";
import { ConnectTrack, type TrackStop, connectionStops } from "./ConnectTrack";

export type QuickStep = "protocol" | "user" | "signIn";
type Step = QuickStep;
type SignIn = "password" | "key" | "identity";

const DEFAULT_PORT: Record<QuickProtocol, number> = { ssh: 22, telnet: 23 };

/** The command line the connection corresponds to, shown as a preview. */
function previewLine(protocol: QuickProtocol, address: string, port: number, username: string): string {
  const host = address.includes(":") ? `[${address}]` : address;
  if (protocol === "telnet") return `telnet ${host}${port !== 23 ? ` ${port}` : ""}`;
  return `ssh ${username ? `${username}@` : ""}${host}${port !== 22 ? ` -p ${port}` : ""}`;
}

/** The setup's stops, all done: the start of the track once the pane connects. */
export function setupStops(protocol: QuickProtocol): TrackStop[] {
  return (protocol === "telnet" ? ["protocol"] : ["protocol", "user", "signIn"]).map((s) => ({ id: s, label: msgQuick.steps[s as Step], state: "done" }));
}

/**
 * Quick connect's setup, in the new tab's pane (an address that matches no saved host): protocol,
 * user, sign-in, then "Continue" opens the session in this pane without saving anything, or
 * "Continue & Save" saves the host first and the pane becomes that host's. Host-key trust and
 * sign-in prompts are the normal ones; a typed password is used for this one connection unless the
 * host is saved. Escape or Close closes the tab. Not a modal: other tabs and the app stay usable.
 */
export function QuickSetup({
  address,
  initialUser,
  initialPort,
  interactive,
  onConnect,
  onConnectSaved,
  onClose,
}: {
  address: string;
  initialUser: string;
  initialPort: number | null;
  /** The pane is in front and focused: the first field takes focus. */
  interactive: boolean;
  /** Continue: open the unsaved connection. */
  onConnect: (input: QuickConnectInput) => void;
  /** Continue & Save: the host was saved; connect to it the normal way. */
  onConnectSaved: (host: HostSummary) => void;
  /** Close or Escape: the tab closes. */
  onClose: () => void;
}) {
  const { hosts, keys, identities } = useVaultData();
  // Several quick connects can be set up at once, one per tab: ids and radio groups are per sheet.
  const uid = useId();
  const [step, setStep] = useState<Step>("protocol");
  const [protocol, setProtocol] = useState<QuickProtocol>("ssh");
  const [ports, setPorts] = useState<Record<QuickProtocol, string>>({
    ssh: String(initialPort ?? DEFAULT_PORT.ssh),
    telnet: String(initialPort ?? DEFAULT_PORT.telnet),
  });
  const [username, setUsername] = useState(initialUser);
  const [identityId, setIdentityId] = useState<string | null>(null);
  const [identityQuery, setIdentityQuery] = useState("");
  const [signIn, setSignIn] = useState<SignIn>("password");
  const [password, setPassword] = useState("");
  // No key chosen by default (#43): picking one is a deliberate choice.
  const [keyId, setKeyId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const allIdentities = identities.value ?? [];
  const identity = allIdentities.find((i) => i.id === identityId) ?? null;
  const shownIdentities = useMemo(() => {
    const needle = identityQuery.trim().toLowerCase();
    return allIdentities.filter((i) => !needle || `${i.label} ${i.username}`.toLowerCase().includes(needle)).slice(0, 6);
  }, [allIdentities, identityQuery]);

  const portText = ports[protocol];
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65535;
  const effectiveUser = username.trim() || identity?.username || "";
  const steps: Step[] = protocol === "telnet" ? ["protocol"] : ["protocol", "user", "signIn"];
  const last = step === steps[steps.length - 1];
  const stepOk =
    step === "protocol" ? portOk : step === "user" ? effectiveUser !== "" : signIn !== "key" || keyId !== "";

  // The track: the setup steps, then the connection's own stops, which run once Continue is
  // pressed (Telnet has none of SSH's: one stop for the connection).
  const stops: TrackStop[] = [
    ...steps.map((s, index): TrackStop => {
      const at = steps.indexOf(step);
      return { id: s, label: msgQuick.steps[s], state: index < at ? "done" : index === at ? "waiting" : "pending" };
    }),
    ...(protocol === "ssh" ? connectionStops([]) : [{ id: "connect", label: msgQuick.steps.connect, state: "pending" as const }]),
  ];

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  }

  function auth(): QuickAuth {
    if (signIn === "identity" && identity) return { kind: "identity", identityId: identity.id };
    if (signIn === "key") return { kind: "key", keyId };
    return password ? { kind: "password", password } : { kind: "ask" };
  }

  function next(event?: FormEvent) {
    event?.preventDefault();
    if (!stepOk) return;
    if (!last) {
      setStep(steps[steps.indexOf(step) + 1] as Step);
      return;
    }
    onConnect({ protocol, address, port, username: protocol === "ssh" ? username.trim() : "", auth: protocol === "ssh" ? auth() : { kind: "ask" } });
  }

  async function connectAndSave() {
    setMenuOpen(false);
    if (!stepOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const telnet = protocol === "telnet";
      const hostAuth = telnet
        ? { kind: "ask_password" as const }
        : signIn === "key"
          ? { kind: "key" as const, keyId }
          : signIn === "password" && password
            ? { kind: "stored_password" as const, password }
            : { kind: "ask_password" as const };
      const saved = await hostsApi.save({
        id: null,
        label: address,
        address,
        port,
        username: telnet ? "" : effectiveUser,
        groupId: null,
        tags: [],
        protocol: { type: telnet ? "telnet" : "ssh" },
        terminal: { encoding: "utf8", term: "xterm256color", pasteSkipMultiline: false, pasteSkipTrailingNewline: false },
        forwardAgent: false,
        production: false,
        auth: hostAuth,
      });
      if (!telnet && signIn === "identity" && identity) await identitiesApi.assign({ kind: "host", hostId: saved.id }, identity.id);
      void hosts.reload();
      onConnectSaved(saved);
    } catch (e) {
      setError(toAppError(e));
      setBusy(false);
    }
  }

  return (
    <div className="connect-layer">
      <section className="connection-sheet quick-connect-sheet" aria-labelledby={`${uid}-title`} onKeyDown={onKeyDown}>
      <form className="stack" onSubmit={next} aria-label={msgQuick.title(address)}>
        <div className="connect-head" data-tile>
          <span className="avatar connect-host-mark" aria-hidden="true">
            <IconServer size={16} />
          </span>
          <div className="connect-head-text">
            <h2 id={`${uid}-title`}>{msgQuick.title(address)}</h2>
            <p>{msgQuick.subtitle}</p>
          </div>
        </div>
        <ConnectTrack stops={stops} />
        <ErrorNotice error={error} />

        {step === "protocol" && (
          <fieldset className="stack-xs quick-protocols">
            <legend className="label">{msgQuick.protocolLegend}</legend>
            {(["ssh", "telnet"] as QuickProtocol[]).map((p) => (
              <div key={p} className="choice" data-protocol={p}>
                <input id={`${uid}-protocol-${p}`} type="radio" name={`${uid}-protocol`} value={p} checked={protocol === p} onChange={() => setProtocol(p)} autoFocus={interactive && p === "ssh"} />
                <span className="choice-body">
                <label className="choice-title" htmlFor={`${uid}-protocol-${p}`}>{msgQuick[p]}</label>
                <TextField
                  label={msgQuick.port(msgQuick[p])}
                  value={ports[p]}
                  inputMode="numeric"
                  maxLength={5}
                  onChange={(value) => setPorts((current) => ({ ...current, [p]: value }))}
                  onFocus={() => setProtocol(p)}
                  error={protocol === p && !portOk ? "1 to 65535" : undefined}
                />
                <span className="hint mono" data-testid={`quick-preview-${p}`}>
                  {msgQuick.preview(previewLine(p, address, Number(ports[p]) || DEFAULT_PORT[p], p === "ssh" ? effectiveUser : ""))}
                </span>
                {p === "telnet" && protocol === "telnet" && <span className="hint">{msgQuick.telnetNote}</span>}
                </span>
              </div>
            ))}
          </fieldset>
        )}

        {step === "user" && (
          <div className="stack">
            <TextField label={msgQuick.username} value={username} onChange={setUsername} hint={msgQuick.usernameHint} autoFocus={interactive} autoComplete="off" spellCheck={false} maxLength={256} />
            <div className="stack-xs">
              <span className="label">{msgQuick.identities}</span>
              <div className="input-with-icon">
                <IconSearch size={15} />
                <input className="input" aria-label={msgQuick.identitySearch} placeholder={msgQuick.identitySearch} value={identityQuery} onChange={(e) => setIdentityQuery(e.target.value)} spellCheck={false} />
              </div>
              <div className="list quick-identities" role="listbox" aria-label={msgQuick.identities}>
                {shownIdentities.length === 0 && <p className="muted">{msgQuick.noIdentities}</p>}
                {shownIdentities.map((i) => (
                  <div
                    key={i.id}
                    role="option"
                    tabIndex={0}
                    aria-selected={identityId === i.id}
                    className="quick-identity"
                    onClick={() => {
                      setIdentityId(i.id);
                      setSignIn("identity");
                      if (i.username) setUsername(i.username);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setIdentityId(i.id);
                        setSignIn("identity");
                        if (i.username) setUsername(i.username);
                      }
                    }}
                  >
                    <span className="truncate">{i.label}</span>
                    <span className="faint mono truncate">{i.username}</span>
                  </div>
                ))}
              </div>
              {identity && (
                <p className="connect-hint">
                  {msgQuick.identityPicked(identity.label)}{" "}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setIdentityId(null);
                      setSignIn("password");
                    }}
                  >
                    {msgQuick.clearIdentity}
                  </button>
                </p>
              )}
            </div>
          </div>
        )}

        {step === "signIn" && (
          <fieldset className="stack">
            <legend className="label">{msgQuick.signInLegend}</legend>
            {identity && (
              <div className="choice">
                <input id={`${uid}-signin-identity`} type="radio" name={`${uid}-signin`} checked={signIn === "identity"} onChange={() => setSignIn("identity")} />
                <span className="choice-body">
                  <label className="choice-title" htmlFor={`${uid}-signin-identity`}>{msgQuick.identity(identity.label)}</label>
                </span>
              </div>
            )}
            <div className="choice">
              <input id={`${uid}-signin-password`} type="radio" name={`${uid}-signin`} checked={signIn === "password"} onChange={() => setSignIn("password")} autoFocus={interactive && !identity} />
              <span className="choice-body">
                <label className="choice-title" htmlFor={`${uid}-signin-password`}>{msgQuick.passwordChoice}</label>
                {signIn === "password" && <SecretField label={msgQuick.password} value={password} onChange={setPassword} hint={msgQuick.passwordHint} maxLength={1024} autoComplete="off" />}
              </span>
            </div>
            <div className="choice">
              <input id={`${uid}-signin-key`} type="radio" name={`${uid}-signin`} checked={signIn === "key"} onChange={() => setSignIn("key")} />
              <span className="choice-body">
                <label className="choice-title" htmlFor={`${uid}-signin-key`}>{msgQuick.key}</label>
                {signIn === "key" &&
                  ((keys.value ?? []).length === 0 ? (
                    <span className="hint">{msgQuick.noKeys}</span>
                  ) : (
                    <select className="select" aria-label={msgQuick.chooseKey} value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                      <option value="">{msgQuick.chooseKey}</option>
                      {(keys.value ?? []).map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label} ({k.algorithm})
                        </option>
                      ))}
                    </select>
                  ))}
              </span>
            </div>
          </fieldset>
        )}

        <div className="connect-actions">
          {step !== "protocol" ? (
            <button type="button" className="btn btn-ghost" onClick={() => setStep(steps[steps.indexOf(step) - 1] as Step)}>
              {msgQuick.back}
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {msgQuick.close}
            </button>
          )}
          <span className="grow" />
          {last ? (
            <span className="btn-split">
              <button type="submit" className="btn btn-primary" disabled={!stepOk || busy} title={msgQuick.connectHint}>
                {msgQuick.connect}
              </button>
              <button
                ref={moreRef}
                type="button"
                className="btn btn-primary btn-split-more"
                aria-label={msgQuick.more}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={!stepOk || busy}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconChevronDown size={14} />
              </button>
              {menuOpen && (
                // A one-item menu of the other way to finish, inside the sheet.
                <div
                  className="menu quick-save-menu"
                  role="menu"
                  aria-label={msgQuick.more}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMenuOpen(false);
                      moreRef.current?.focus();
                    }
                  }}
                >
                  <button type="button" role="menuitem" className="menu-item" autoFocus onClick={() => void connectAndSave()} title={msgQuick.saveHint}>
                    {msgQuick.save}
                  </button>
                </div>
              )}
            </span>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!stepOk}>
              {msgQuick.next}
            </button>
          )}
        </div>
      </form>
      </section>
    </div>
  );
}

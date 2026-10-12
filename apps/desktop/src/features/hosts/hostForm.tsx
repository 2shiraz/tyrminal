// The host form shared by the Host details panel and the quick-save dialog: one state hook with
// the validation and save order, and the cards that render it. Stored passwords are write-only:
// the field starts empty, is masked until the user presses its reveal button, and is cleared after
// every save attempt.
import type { GroupSummary, HostAuthInput, HostOs, HostSummary, HostTerminal, IdentitySummary, KeySummary, SerialSettings } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { SecretField, Switch, TextField } from "../../components/ui/controls";
import { IconKeyRound, IconPlus, IconServer, IconX } from "../../components/ui/icons";
import { hosts as hostsApi, identities as identitiesApi, keysD } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgAutosave } from "../../lib/messages-autosave";
import { msgD } from "../../lib/messages-d";
import { msgProduction } from "../../lib/messages-production";
import { useAction } from "../../lib/useAsync";
import { identityEvents } from "../credentials/IdentitiesSection";
import { InstallKeyDialog } from "../credentials/InstallKeyDialog";
// agent B: tunnels and history
import { HostAdvancedSection, useHostAdvanced } from "../tunnels/HostAdvanced";
import { validAddress, validLabel, validTags, validUsername } from "./fieldRules";
import { DropSecretNotice, type LiveProxySecret, LiveSecretField } from "./LiveSecret";
import { OsIcon } from "./OsIcon";
import { productionReason } from "./production";
import {
  AgentForwarding,
  DEFAULT_SERIAL,
  DEFAULT_TERMINAL,
  PasteFields,
  type ProtocolKind,
  SerialFields,
  TelnetWarning,
  TerminalFields,
} from "./ProtocolFields";

type AuthKind = HostAuthInput["kind"];

/** What a host in `groupId` inherits: the nearest group in the chain that sets each value. */
export function groupDefaults(groups: GroupSummary[], groupId: string | null) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: { username: string | null; port: number | null; keyId: string | null } = { username: null, port: null, keyId: null };
  let current = groupId ? byId.get(groupId) : undefined;
  for (let depth = 0; current && depth < 16; depth += 1) {
    out.username ??= current.username;
    out.port ??= current.port;
    out.keyId ??= current.keyId;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

/** `Parent/Child` names for a group, for pickers. */
export function groupPath(groups: GroupSummary[], id: string): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const names: string[] = [];
  let current = byId.get(id);
  for (let depth = 0; current && depth < 16; depth += 1) {
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" / ");
}

export interface HostFormOptions {
  host: HostSummary | null;
  /** Prefill for a new host (quick connect, duplicate). */
  initial?: { label?: string; address: string; port: number; username: string; auth?: HostSummary["auth"] } | undefined;
  keys: KeySummary[];
  groups?: GroupSummary[];
  /** Group preselected for a new host (the group being viewed). */
  defaultGroupId?: string | null;
  /** The identity assigned to this host itself, when the caller offers the identity picker. */
  identity?: { list: IdentitySummary[]; current: string | null } | undefined;
}

export function useHostForm({ host: hostProp, initial, keys, groups = [], defaultGroupId = null, identity }: HostFormOptions) {
  // The host as the form opened it. An autosaving owner passes newer summaries as it writes; the
  // form keeps its own fields and never reloads under the user's typing.
  const [host] = useState(hostProp);
  const source = host ?? initial;
  // The starting point is fixed for the life of the form; owners remount it to start over.
  const [start] = useState(() => {
    const sourceAuth = host?.auth ?? initial?.auth;
    return {
      groupId: host ? host.groupId : defaultGroupId,
      label: host?.label ?? initial?.label ?? initial?.address ?? "",
      address: source?.address ?? "",
      // Inherited values show as empty fields with the group's value as a hint.
      port: host?.inherited.port ? "" : String(source?.port ?? (defaultGroupId ? "" : 22)),
      username: host?.inherited.username ? "" : (source?.username ?? ""),
      tags: (host?.tags ?? []).join(", "),
      authKind: (host?.inherited.auth
        ? "inherit"
        : sourceAuth?.kind === "stored_password" && !host
          ? "ask_password"
          : // A new host asks for the password unless its group decides: a key is used only
            // once the user picks one, never because one exists.
            (sourceAuth?.kind ?? (defaultGroupId ? "inherit" : "ask_password"))) as AuthKind,
      keyId: sourceAuth?.kind === "key" && !host?.inherited.auth ? sourceAuth.keyId : "",
      identityId: identity?.current ?? "",
      protocol: (host?.protocol.type ?? "ssh") as ProtocolKind,
      serial: host?.protocol.type === "serial" ? host.protocol.settings : DEFAULT_SERIAL,
      terminal: host?.terminal ?? DEFAULT_TERMINAL,
      forwardAgent: host?.forwardAgent ?? false,
      production: host?.production === "host",
    };
  });
  const [groupId, setGroupId] = useState<string | null>(start.groupId);
  // agent B: tunnels and history (the group chosen here decides which route the host can inherit)
  const advanced = useHostAdvanced(host?.id ?? null, groupId);
  const [label, setLabel] = useState(start.label);
  const [address, setAddress] = useState(start.address);
  const [port, setPort] = useState(start.port);
  const [username, setUsername] = useState(start.username);
  const [tags, setTags] = useState(start.tags);
  const [authKind, setAuthKind] = useState<AuthKind>(start.authKind);
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(start.keyId);
  const [identityId, setIdentityId] = useState(start.identityId);
  const [protocol, setProtocolState] = useState<ProtocolKind>(start.protocol);
  const [serial, setSerial] = useState(start.serial);
  const [terminal, setTerminal] = useState(start.terminal);
  const [forwardAgent, setForwardAgent] = useState(start.forwardAgent);
  const [production, setProduction] = useState(start.production);
  const [certified, setCertified] = useState<Set<string>>(new Set());
  const { pending, error, run } = useAction();

  // Which keys carry an OpenSSH certificate (public data), to label them in the key picker.
  useEffect(() => {
    let live = true;
    keysD
      .certificates()
      .then((list) => live && setCertified(new Set(list.map((c) => c.keyId))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const inherited = useMemo(() => groupDefaults(groups, groupId), [groups, groupId]);
  const inheritedKey = inherited.keyId ? keys.find((k) => k.id === inherited.keyId) : undefined;
  const hadStoredPassword = host?.auth.kind === "stored_password" && !host.inherited.auth;
  const portNumber = port === "" ? null : Number(port);
  const portValid = portNumber === null ? groupId !== null : Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const effectiveUser = username || inherited.username || "";
  const effectivePort = portNumber ?? inherited.port ?? 22;
  const authValid =
    authKind === "ask_password" ||
    (authKind === "inherit" && groupId !== null) ||
    (authKind === "stored_password" && (password.length > 0 || hadStoredPassword)) ||
    (authKind === "key" && keyId !== "");
  // Telnet and serial hosts sign in at the device's own prompt: no user name or stored credentials.
  const ready =
    protocol === "serial"
      ? label.trim() !== "" && serial.path.trim() !== ""
      : protocol === "telnet"
        ? label.trim() !== "" && address.trim() !== "" && (port === "" || portValid)
        : label.trim() !== "" && address.trim() !== "" && effectiveUser !== "" && portValid && authValid && advanced.valid;
  /** Inline errors per field: shown at once, and an autosaving owner never stores the field. */
  const errors = {
    address: protocol === "serial" ? undefined : address.trim() === "" ? (host ? msgAutosave.addressEmpty : undefined) : validAddress(address) ? undefined : msgAutosave.address,
    label: label.trim() === "" ? (host ? msgAutosave.label : undefined) : validLabel(label) ? undefined : msgAutosave.label,
    username: protocol === "ssh" && !validUsername(username) ? msgAutosave.username : undefined,
    tags: validTags(tags) ? undefined : msgAutosave.tags,
    // A key sign-in needs a key the user chose; none is ever picked for them.
    key: protocol === "ssh" && authKind === "key" && keyId === "" ? msgAutosave.keyMissing : undefined,
  };
  const fieldsValid = !errors.address && !errors.label && !errors.username && !errors.tags && !errors.key;
  /** Follows the protocol's usual port unless the user chose another. */
  const setProtocol = (next: ProtocolKind) => {
    if (next === "telnet" && port === "22") setPort("23");
    if (next === "ssh" && port === "23") setPort("22");
    setProtocolState(next);
  };
  /** Undo: puts every non-secret field back to `to` (a typed, unset password stays). */
  function restore(to: HostFields) {
    setGroupId(to.groupId);
    setLabel(to.label);
    setAddress(to.address);
    setPort(to.port);
    setUsername(to.username);
    setTags(to.tags);
    setAuthKind(to.authKind);
    setKeyId(to.keyId);
    setIdentityId(to.identityId);
    setProtocolState(to.protocol);
    setSerial(to.serial);
    setTerminal(to.terminal);
    setForwardAgent(to.forwardAgent);
    setProduction(to.production);
  }

  /** Saves the host; resolves to the saved host, or `undefined` when the core refused it. */
  async function save(): Promise<HostSummary | undefined> {
    if (!ready || pending) return undefined;
    const auth: HostAuthInput =
      authKind === "key"
        ? { kind: "key", keyId }
        : authKind === "stored_password"
          ? { kind: "stored_password", password: password.length > 0 ? password : null }
          : authKind === "inherit"
            ? { kind: "inherit" }
            : { kind: "ask_password" };
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const saved = await run(async () => {
      // The advanced connection settings (jump host, proxy) and identities apply to SSH only.
      if (protocol !== "ssh") {
        return hostsApi.save({
          id: host?.id ?? null,
          label,
          address: protocol === "serial" ? serial.path : address,
          port: protocol === "serial" ? null : portNumber,
          username: "",
          auth: { kind: "ask_password" },
          groupId,
          tags: tagList,
          protocol: protocol === "serial" ? { type: "serial", settings: serial } : { type: "telnet" },
          terminal,
          forwardAgent: false,
          production,
        });
      }
      // agent B: tunnels and history (advanced settings: see HostAdvanced.tsx for the order)
      await advanced.saveBefore();
      const result = await hostsApi.save({
        id: host?.id ?? null,
        label,
        address,
        port: portNumber,
        username,
        auth,
        groupId,
        tags: tagList,
        protocol: { type: "ssh" },
        terminal,
        forwardAgent: forwardAgent && authKind === "key",
        production,
      });
      await advanced.saveAfter(result.id);
      if (identity && identityId !== start.identityId) {
        await identitiesApi.assign({ kind: "host", hostId: result.id }, identityId || null);
        identityEvents.changed();
      }
      return result;
    });
    setPassword("");
    return saved ?? undefined;
  }

  return {
    host,
    keys,
    groups,
    identity,
    advanced,
    start: start as HostFields,
    fields: { groupId, label, address, port, username, tags, authKind, password, keyId, identityId, protocol, serial, terminal, forwardAgent, production },
    errors,
    restore,
    set: {
      setGroupId,
      setLabel,
      setAddress,
      setPort,
      setUsername,
      setTags,
      setAuthKind,
      setPassword,
      setKeyId,
      setIdentityId,
      setProtocol,
      setSerial,
      setTerminal,
      setForwardAgent,
      setProduction,
    },
    certified,
    inherited,
    inheritedKey,
    hadStoredPassword,
    portValid,
    effectiveUser,
    effectivePort,
    ready: ready && fieldsValid,
    pending,
    error,
    save,
  };
}

export type HostForm = ReturnType<typeof useHostForm> & {
  /** Set by an autosaving owner (the Host details panel): secrets get their own buttons. */
  live?: LiveHost | undefined;
};

/** Every non-secret field of the form, as the form holds it. */
export interface HostFields {
  groupId: string | null;
  label: string;
  address: string;
  port: string;
  username: string;
  tags: string;
  authKind: AuthKind;
  keyId: string;
  identityId: string;
  protocol: ProtocolKind;
  serial: SerialSettings;
  terminal: HostTerminal;
  forwardAgent: boolean;
  production: boolean;
}

/** What an autosaving owner adds to the cards: explicit secret actions and held removals. */
export interface LiveHost {
  passwordStored: boolean;
  /** The host exists or can be created now, so a secret can be written. */
  canSet: boolean;
  setPassword: () => void;
  /** The sign-in change would remove the stored password: it waits for `removePassword`. */
  dropsPassword: boolean;
  removePassword: () => void;
  proxy: LiveProxySecret;
  isNew: boolean;
}

/** One card of the form, a group named by its heading. */
function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="host-section" role="group" aria-labelledby={id}>
      <h3 id={id} className="host-section-title">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 1. Address, with the host's OS mark (or a neutral server mark). The field's label names the card. */
function AddressCard({ form, os, autoFocus }: { form: HostForm; os: HostOs | null; autoFocus: boolean }) {
  return (
    <section className="host-section host-address">
      {os ? (
        <OsIcon os={os} />
      ) : (
        <span className="avatar host-address-mark" aria-hidden="true">
          <IconServer size={18} />
        </span>
      )}
      <TextField
        label={msg.hosts.address}
        value={form.fields.address}
        onChange={form.set.setAddress}
        // A new host in the panel: says it is saved once the address is valid (in the field's own
        // hint, so the panel does not shift when the host is created).
        hint={form.live?.isNew ? msgAutosave.newHostHint : msg.hosts.addressHint}
        error={form.errors.address ?? (form.live && !form.live.isNew && form.fields.address.trim() === "" ? msgAutosave.addressEmpty : undefined)}
        maxLength={253}
        autoFocus={autoFocus}
      />
    </section>
  );
}

/** 2. Name, group and tags. */
function GeneralCard({ form }: { form: HostForm }) {
  const { fields, set, groups } = form;
  return (
    <Card title={msgD.hostPanel.general}>
      <TextField
        label={msg.hosts.label}
        value={fields.label}
        onChange={set.setLabel}
        maxLength={256}
        error={form.errors.label ?? (form.live && !form.live.isNew && fields.label.trim() === "" ? msgAutosave.label : undefined)}
        hint={form.live?.isNew && fields.label.trim() === "" ? msgAutosave.labelDefault : undefined}
      />
      {groups.length > 0 && (
        <label className="field">
          <span className="label">{msg.hosts.group}</span>
          <select
            className="select"
            value={fields.groupId ?? ""}
            onChange={(event) => {
              const next = event.target.value || null;
              set.setGroupId(next);
              if (!next && fields.authKind === "inherit") set.setAuthKind("ask_password");
            }}
          >
            <option value="">{msg.hosts.noGroup}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupPath(groups, g.id)}
              </option>
            ))}
          </select>
        </label>
      )}
      <TextField label={msg.hosts.tags} value={fields.tags} onChange={set.setTags} hint={msg.hosts.tagsHint} error={form.errors.tags} maxLength={600} />
      <ProductionSwitch form={form} />
    </Card>
  );
}

const PROTOCOL_NAMES: Record<ProtocolKind, string> = { ssh: "SSH", telnet: msg.hosts.telnet, serial: msg.hosts.serial };

/** 3. "[SSH] on [22] port": the protocol (SSH, or Telnet or a serial device instead) and its port or line settings. */
function ProtocolCard({ form }: { form: HostForm }) {
  const { fields, set, inherited, portValid } = form;
  const id = useId();
  const protocolId = useId();
  const inheritedPort = String(inherited.port ?? 22);
  const error = fields.port !== "" && !portValid ? "1–65535" : undefined;
  const hint = fields.protocol === "ssh" && fields.groupId && fields.port === "" ? msg.hosts.inherit(inheritedPort) : undefined;
  return (
    <Card title={msgD.hostPanel.protocol}>
      <div className="protocol-line">
        <label htmlFor={protocolId} className="visually-hidden">
          {msg.hosts.protocol}
        </label>
        <select
          id={protocolId}
          className="select protocol-select"
          value={fields.protocol}
          onChange={(event) => set.setProtocol(event.target.value as ProtocolKind)}
        >
          {(Object.keys(PROTOCOL_NAMES) as ProtocolKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {PROTOCOL_NAMES[kind]}
            </option>
          ))}
        </select>
        {fields.protocol !== "serial" && (
          <>
            <span aria-hidden="true">{msgD.hostPanel.on}</span>
            <label htmlFor={id} className="visually-hidden">
              {msg.hosts.port}
            </label>
            <input
              id={id}
              className="input protocol-port"
              value={fields.port}
              onChange={(event) => set.setPort(event.target.value)}
              inputMode="numeric"
              maxLength={5}
              placeholder={fields.protocol === "ssh" && fields.groupId ? inheritedPort : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <span aria-hidden="true">{msgD.hostPanel.portWord}</span>
          </>
        )}
      </div>
      {error ? (
        <span id={`${id}-error`} className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
      {form.live?.dropsPassword && fields.protocol !== "ssh" && (
        <DropSecretNotice text={msgAutosave.removesPassword} action={msgAutosave.removePassword} onRemove={form.live.removePassword} />
      )}
      {fields.protocol === "telnet" && <TelnetWarning />}
      {fields.protocol === "serial" && <SerialFields value={fields.serial} onChange={set.setSerial} />}
    </Card>
  );
}

/** 4. User name and sign-in: group key, a keychain key (certificates ride on their key), a password, or an identity. */
function CredentialsCard({ form }: { form: HostForm }) {
  const { fields, set, keys, inherited, inheritedKey, certified, identity } = form;
  const [showIdentity, setShowIdentity] = useState(fields.identityId !== "");
  // Installing the chosen key on this (saved) host, signing in once with its password.
  const [installing, setInstalling] = useState(false);
  const keyErrorId = useId();
  const plainKeys = keys.filter((k) => !certified.has(k.id));
  const certKeys = keys.filter((k) => certified.has(k.id));
  const chosenIdentity = identity?.list.find((i) => i.id === fields.identityId);
  return (
    <Card title={msgD.hostPanel.credentials}>
      <TextField
        label={msg.hosts.username}
        value={fields.username}
        onChange={set.setUsername}
        maxLength={255}
        error={form.errors.username}
        placeholder={inherited.username ?? undefined}
        hint={
          fields.groupId && fields.username === ""
            ? inherited.username
              ? msg.hosts.inherit(inherited.username)
              : msg.hosts.needsUser
            : undefined
        }
      />

      <fieldset className="stack-sm host-auth">
        <legend className="label">{msg.hosts.auth}</legend>
        {fields.groupId && (
          <label className="choice">
            <input type="radio" name="auth" checked={fields.authKind === "inherit"} onChange={() => set.setAuthKind("inherit")} />
            <span className="choice-body">
              <span className="choice-title">{msg.hosts.authInherit}</span>
              <span className="hint">{msg.hosts.authInheritHint(inheritedKey?.label ?? null)}</span>
            </span>
          </label>
        )}
        <label className="choice">
          <input type="radio" name="auth" checked={fields.authKind === "key"} onChange={() => set.setAuthKind("key")} />
          <span className="choice-body">
            <span className="choice-title">{msg.hosts.key}</span>
            <span className="hint">{keys.length > 0 ? msg.hosts.keyHint : msg.hosts.keyNone}</span>
            {fields.authKind === "key" && keys.length > 0 && (
              <select
                className="select"
                style={{ marginTop: 6 }}
                aria-label={msg.hosts.keyChoose}
                aria-invalid={form.errors.key ? true : undefined}
                aria-describedby={form.errors.key ? keyErrorId : undefined}
                value={fields.keyId}
                onChange={(event) => set.setKeyId(event.target.value)}
              >
                <option value="" disabled>
                  {msg.hosts.keyChooseOne}
                </option>
                {plainKeys.length > 0 && (
                  <optgroup label={msgD.hostPanel.sshKeys}>
                    {plainKeys.map((key) => (
                      <option key={key.id} value={key.id}>
                        {key.label} ({key.algorithm})
                      </option>
                    ))}
                  </optgroup>
                )}
                {certKeys.length > 0 && (
                  <optgroup label={msgD.hostPanel.certificates}>
                    {certKeys.map((key) => (
                      <option key={key.id} value={key.id}>
                        {msgD.hostPanel.withCertificate(key.label)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
            {form.errors.key && (
              <span id={keyErrorId} className="field-error" role="alert">
                {form.errors.key}
              </span>
            )}
            {fields.authKind === "key" && form.host && fields.keyId !== "" && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={() => setInstalling(true)}>
                <IconKeyRound size={14} />
                {msgD.installKey.fromHost}
              </button>
            )}
          </span>
        </label>
        {installing && form.host && <InstallKeyDialog hostId={form.host.id} keyId={fields.keyId} onClose={() => setInstalling(false)} />}
        <label className="choice">
          <input type="radio" name="auth" checked={fields.authKind === "ask_password"} onChange={() => set.setAuthKind("ask_password")} />
          <span className="choice-body">
            <span className="choice-title">{msg.hosts.askPassword}</span>
            <span className="hint">{msg.hosts.askPasswordHint}</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="auth" checked={fields.authKind === "stored_password"} onChange={() => set.setAuthKind("stored_password")} />
          <span className="choice-body">
            <span className="choice-title">{msg.hosts.storedPassword}</span>
            <span className="hint">{msg.hosts.storedPasswordHint}</span>
          </span>
        </label>
        {fields.authKind === "stored_password" &&
          (form.live ? (
            <LiveSecretField
              label={msg.hosts.password}
              value={fields.password}
              onChange={set.setPassword}
              stored={form.live.passwordStored}
              maxLength={1024}
              canSet={form.live.canSet}
              onSet={form.live.setPassword}
            />
          ) : (
            <SecretField
              label={msg.hosts.password}
              value={fields.password}
              onChange={set.setPassword}
              hint={form.hadStoredPassword ? msg.hosts.passwordKeep : undefined}
              maxLength={1024}
            />
          ))}
        {form.live?.dropsPassword && (
          <DropSecretNotice text={msgAutosave.removesPassword} action={msgAutosave.removePassword} onRemove={form.live.removePassword} />
        )}
      </fieldset>

      {identity && (
        <div className="host-pickers">
          {showIdentity ? (
            <div className="host-picker">
              <label className="field">
                <span className="label">{msgD.identities.title}</span>
                <select className="select" value={fields.identityId} onChange={(event) => set.setIdentityId(event.target.value)}>
                  <option value="">{msgD.identities.none}</option>
                  {identity.list.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </select>
                <span className="hint">{chosenIdentity ? msgD.hostPanel.identityWins(chosenIdentity.label) : msgD.identities.assignBody}</span>
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={msgD.hostPanel.removeIdentity}
                data-tooltip={msgD.hostPanel.removeIdentity}
                onClick={() => {
                  set.setIdentityId("");
                  setShowIdentity(false);
                }}
              >
                <IconX size={14} />
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowIdentity(true)} disabled={identity.list.length === 0}>
              <IconPlus size={14} />
              {msgD.hostPanel.addIdentity}
            </button>
          )}
          {!showIdentity && identity.list.length === 0 && <span className="hint">{msgD.hostPanel.noIdentities}</span>}
        </div>
      )}
    </Card>
  );
}

/** 5. "Show more": the connection settings that live in their own records (jump host, proxy). */
function MoreCard({ form, extra }: { form: HostForm; extra?: ReactNode }) {
  const advanced = form.advanced;
  const configured = advanced.jumpHostId !== null || advanced.proxy.kind !== "none" || advanced.groupRoute !== null;
  // Held in state so a re-render after an autosave never folds it while the user is in it.
  const [open, setOpen] = useState(configured);
  useEffect(() => {
    if (configured) setOpen(true);
  }, [configured]);
  return (
    <details className="host-section host-more" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="host-section-title">{msgD.hostPanel.more}</summary>
      <div className="stack-sm host-more-body">
        <TerminalFields value={form.fields.terminal} onChange={form.set.setTerminal} showTerm={form.fields.protocol !== "serial"} />
        <PasteFields value={form.fields.terminal} onChange={form.set.setTerminal} />
        {form.fields.protocol === "ssh" && form.fields.authKind === "key" && (
          <AgentForwarding checked={form.fields.forwardAgent} onChange={form.set.setForwardAgent} />
        )}
        {/* agent B: tunnels and history */}
        {form.fields.protocol === "ssh" && <HostAdvancedSection host={form.host} state={advanced} embedded live={form.live?.proxy} />}
        {form.fields.protocol === "ssh" && extra}
      </div>
    </details>
  );
}

/** The host's own production flag, with a note when it is a production host anyway (P-26). */
function ProductionSwitch({ form }: { form: HostForm }) {
  const { prefs } = usePreferences();
  const { fields, set, groups } = form;
  // What the host would be without its own flag, from the values in the form.
  let id: string | null = fields.groupId;
  let fromGroup = false;
  for (let depth = 0; id && depth < 16; depth += 1) {
    const g = groups.find((x) => x.id === id);
    if (!g) break;
    if (g.production) fromGroup = true;
    id = g.parentId;
  }
  const reason = fromGroup ? "group" : productionReason({ production: null, tags: fields.tags.split(",").map((t) => t.trim()) }, prefs.productionTag);
  return (
    <div className="stack-xs">
      <Switch label={msgProduction.hostSwitch} hint={msgProduction.hostHint} checked={fields.production} onChange={set.setProduction} />
      {!fields.production && reason === "group" && <p className="hint">{msgProduction.inheritedGroup}</p>}
      {!fields.production && reason === "tag" && <p className="hint">{msgProduction.inheritedTag(prefs.productionTag)}</p>}
    </div>
  );
}

/** Every card of the form, top to bottom. `extra` goes at the end of "Show more". */
export function HostFormCards({
  form,
  os = null,
  autoFocus = false,
  extra,
}: {
  form: HostForm;
  os?: HostOs | null;
  autoFocus?: boolean;
  extra?: ReactNode;
}) {
  return (
    <>
      {form.fields.protocol !== "serial" && <AddressCard form={form} os={os} autoFocus={autoFocus} />}
      <GeneralCard form={form} />
      <ProtocolCard form={form} />
      {form.fields.protocol === "ssh" && <CredentialsCard form={form} />}
      <MoreCard form={form} extra={extra} />
      {form.ready && form.fields.protocol === "ssh" && <p className="muted host-effective">{msg.hosts.effective(form.effectiveUser, form.fields.address.trim(), form.effectivePort)}</p>}
    </>
  );
}

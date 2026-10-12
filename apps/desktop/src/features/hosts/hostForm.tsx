// The host form shared by the Host details panel and the quick-save dialog: one state hook with
// the validation and save order, and the cards that render it. Stored passwords are write-only:
// the field starts empty, is masked until the user presses its reveal button, and is cleared after
// every save attempt.
import type { GroupSummary, HostAuthInput, HostOs, HostSummary, IdentitySummary, KeySummary } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { SecretField, TextField } from "../../components/ui/controls";
import { IconPlus, IconServer, IconX } from "../../components/ui/icons";
import { hosts as hostsApi, identities as identitiesApi, keysD } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";
import { identityEvents } from "../credentials/IdentitiesSection";
// agent B: tunnels and history
import { HostAdvancedSection, useHostAdvanced } from "../tunnels/HostAdvanced";
import { OsIcon } from "./OsIcon";

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

export function useHostForm({ host, initial, keys, groups = [], defaultGroupId = null, identity }: HostFormOptions) {
  const source = host ?? initial;
  // agent B: tunnels and history
  const advanced = useHostAdvanced(host?.id ?? null);
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
          : (sourceAuth?.kind ?? (defaultGroupId ? "inherit" : keys.length > 0 ? "key" : "ask_password"))) as AuthKind,
      keyId: sourceAuth?.kind === "key" && !host?.inherited.auth ? sourceAuth.keyId : (keys[0]?.id ?? ""),
      identityId: identity?.current ?? "",
    };
  });
  const [groupId, setGroupId] = useState<string | null>(start.groupId);
  const [label, setLabel] = useState(start.label);
  const [address, setAddress] = useState(start.address);
  const [port, setPort] = useState(start.port);
  const [username, setUsername] = useState(start.username);
  const [tags, setTags] = useState(start.tags);
  const [authKind, setAuthKind] = useState<AuthKind>(start.authKind);
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(start.keyId);
  const [identityId, setIdentityId] = useState(start.identityId);
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
  const ready = label.trim() !== "" && address.trim() !== "" && effectiveUser !== "" && portValid && authValid && advanced.valid;
  /** What still stops a save, in the order of the cards, for the footer's explanation. */
  const missing = [
    address.trim() === "" && msg.hosts.address,
    label.trim() === "" && msg.hosts.label,
    !portValid && msg.hosts.port,
    effectiveUser === "" && msg.hosts.username,
    !authValid && (authKind === "stored_password" ? msg.hosts.password : msg.hosts.auth),
    !advanced.valid && msgD.hostPanel.more,
  ].filter((x): x is string => typeof x === "string");
  const dirty =
    groupId !== start.groupId ||
    label !== start.label ||
    address !== start.address ||
    port !== start.port ||
    username !== start.username ||
    tags !== start.tags ||
    authKind !== start.authKind ||
    (authKind === "key" && keyId !== start.keyId) ||
    password.length > 0 ||
    identityId !== start.identityId ||
    advanced.changed;

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
      // agent B: tunnels and history (advanced settings: see HostAdvanced.tsx for the order)
      await advanced.saveBefore();
      const result = await hostsApi.save({ id: host?.id ?? null, label, address, port: portNumber, username, auth, groupId, tags: tagList });
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
    fields: { groupId, label, address, port, username, tags, authKind, password, keyId, identityId },
    set: { setGroupId, setLabel, setAddress, setPort, setUsername, setTags, setAuthKind, setPassword, setKeyId, setIdentityId },
    certified,
    inherited,
    inheritedKey,
    hadStoredPassword,
    portValid,
    effectiveUser,
    effectivePort,
    ready,
    missing,
    dirty,
    pending,
    error,
    save,
  };
}

export type HostForm = ReturnType<typeof useHostForm>;

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
        hint={msg.hosts.addressHint}
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
      <TextField label={msg.hosts.label} value={fields.label} onChange={set.setLabel} maxLength={256} />
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
      <TextField label={msg.hosts.tags} value={fields.tags} onChange={set.setTags} hint={msg.hosts.tagsHint} maxLength={600} />
    </Card>
  );
}

/** 3. "SSH on [22] port". */
function ProtocolCard({ form }: { form: HostForm }) {
  const { fields, set, inherited, portValid } = form;
  const id = useId();
  const inheritedPort = String(inherited.port ?? 22);
  const error = fields.port !== "" && !portValid ? "1–65535" : undefined;
  const hint = fields.groupId && fields.port === "" ? msg.hosts.inherit(inheritedPort) : undefined;
  return (
    <Card title={msgD.hostPanel.protocol}>
      <div className="protocol-line">
        <span className="protocol-name">SSH</span>
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
          placeholder={fields.groupId ? inheritedPort : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <span aria-hidden="true">{msgD.hostPanel.portWord}</span>
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
    </Card>
  );
}

/** 4. User name and sign-in: group key, a keychain key (certificates ride on their key), a password, or an identity. */
function CredentialsCard({ form }: { form: HostForm }) {
  const { fields, set, keys, inherited, inheritedKey, certified, identity } = form;
  const [showIdentity, setShowIdentity] = useState(fields.identityId !== "");
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
                value={fields.keyId}
                onChange={(event) => set.setKeyId(event.target.value)}
              >
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
          </span>
        </label>
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
        {fields.authKind === "stored_password" && (
          <SecretField
            label={msg.hosts.password}
            value={fields.password}
            onChange={set.setPassword}
            hint={form.hadStoredPassword ? msg.hosts.passwordKeep : undefined}
            maxLength={1024}
          />
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
  const configured = advanced.jumpHostId !== null || advanced.proxy.kind !== "none";
  return (
    <details className="host-section host-more" open={configured ? true : undefined}>
      <summary className="host-section-title">{msgD.hostPanel.more}</summary>
      <div className="stack-sm host-more-body">
        {/* agent B: tunnels and history */}
        <HostAdvancedSection host={form.host} state={advanced} embedded />
        {extra}
      </div>
    </details>
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
      <AddressCard form={form} os={os} autoFocus={autoFocus} />
      <GeneralCard form={form} />
      <ProtocolCard form={form} />
      <CredentialsCard form={form} />
      <MoreCard form={form} extra={extra} />
      {form.ready && <p className="muted host-effective">{msg.hosts.effective(form.effectiveUser, form.fields.address.trim(), form.effectivePort)}</p>}
    </>
  );
}

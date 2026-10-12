import type { GroupSummary, HostAuthInput, HostSummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useMemo, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, SecretField, TextField } from "../../components/ui/controls";
import { IconServer } from "../../components/ui/icons";
import { hosts as hostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
// agent B: tunnels and history
import { HostAdvancedSection, useHostAdvanced } from "../tunnels/HostAdvanced";
import {
  DEFAULT_SERIAL,
  DEFAULT_TERMINAL,
  type ProtocolKind,
  ProtocolSelect,
  SerialFields,
  TelnetWarning,
  AgentForwarding,
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

export function HostEditor({
  host,
  initial,
  keys,
  groups = [],
  defaultGroupId = null,
  onClose,
  onSaved,
}: {
  host: HostSummary | null;
  /** Prefill for a new host (quick connect, duplicate). */
  initial?: { label?: string; address: string; port: number; username: string; auth?: HostSummary["auth"] } | undefined;
  keys: KeySummary[];
  groups?: GroupSummary[];
  /** Group preselected for a new host (the group being viewed). */
  defaultGroupId?: string | null;
  onClose: () => void;
  onSaved: (saved: HostSummary) => void;
}) {
  const source = host ?? initial;
  // agent B: tunnels and history
  const advanced = useHostAdvanced(host?.id ?? null);
  const [groupId, setGroupId] = useState<string | null>(host ? host.groupId : defaultGroupId);
  const [label, setLabel] = useState(host?.label ?? initial?.label ?? initial?.address ?? "");
  const [address, setAddress] = useState(source?.address ?? "");
  // Inherited values show as empty fields with the group's value as a hint.
  const [port, setPort] = useState(host?.inherited.port ? "" : String(source?.port ?? (defaultGroupId ? "" : 22)));
  const [username, setUsername] = useState(host?.inherited.username ? "" : (source?.username ?? ""));
  const [tags, setTags] = useState((host?.tags ?? []).join(", "));
  const sourceAuth = host?.auth ?? initial?.auth;
  const [authKind, setAuthKind] = useState<AuthKind>(
    host?.inherited.auth
      ? "inherit"
      : sourceAuth?.kind === "stored_password" && !host
        ? "ask_password"
        : (sourceAuth?.kind ?? (defaultGroupId ? "inherit" : keys.length > 0 ? "key" : "ask_password")),
  );
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(sourceAuth?.kind === "key" && !host?.inherited.auth ? sourceAuth.keyId : (keys[0]?.id ?? ""));
  const { pending, error, run } = useAction();
  // agent A: protocols
  const [protocol, setProtocol] = useState<ProtocolKind>(host?.protocol.type ?? "ssh");
  const [serial, setSerial] = useState(host?.protocol.type === "serial" ? host.protocol.settings : DEFAULT_SERIAL);
  const [terminal, setTerminal] = useState(host?.terminal ?? DEFAULT_TERMINAL);
  const [forwardAgent, setForwardAgent] = useState(host?.forwardAgent ?? false);

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
  const ready =
    protocol === "serial"
      ? label.trim() !== "" && serial.path.trim() !== ""
      : protocol === "telnet"
        ? label.trim() !== "" && address.trim() !== "" && (port === "" || portValid)
        : label.trim() !== "" && address.trim() !== "" && effectiveUser !== "" && portValid && authValid;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
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
    // Telnet and serial hosts sign in at the device's own prompt: no stored credentials, and the
    // advanced connection settings (jump host, proxy) apply to SSH only.
    const saved = await run(async () => {
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
      });
      await advanced.saveAfter(result.id);
      return result;
    });
    setPassword("");
    if (saved) onSaved(saved);
  }

  return (
    <Dialog title={host ? msg.hosts.editorEdit : msg.hosts.editorNew} icon={<IconServer size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <TextField label={msg.hosts.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <ProtocolSelect
          value={protocol}
          onChange={(next) => {
            // Follow the protocol's usual port unless the user chose another.
            if (next === "telnet" && port === "22") setPort("23");
            if (next === "ssh" && port === "23") setPort("22");
            setProtocol(next);
          }}
        />
        {protocol === "telnet" && <TelnetWarning />}
        {protocol === "serial" && <SerialFields value={serial} onChange={setSerial} />}
        <TerminalFields value={terminal} onChange={setTerminal} showTerm={protocol !== "serial"} />
        {groups.length > 0 && (
          <label className="field">
            <span className="label">{msg.hosts.group}</span>
            <select
              className="select"
              value={groupId ?? ""}
              onChange={(event) => {
                const next = event.target.value || null;
                setGroupId(next);
                if (!next && authKind === "inherit") setAuthKind("ask_password");
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
        {protocol !== "serial" && (
        <div className="split">
          <TextField label={msg.hosts.address} value={address} onChange={setAddress} hint={msg.hosts.addressHint} maxLength={253} />
          <TextField
            label={msg.hosts.port}
            value={port}
            onChange={setPort}
            inputMode="numeric"
            maxLength={5}
            placeholder={groupId ? String(inherited.port ?? 22) : undefined}
            hint={groupId && port === "" ? msg.hosts.inherit(String(inherited.port ?? 22)) : undefined}
            error={port !== "" && !portValid ? "1–65535" : undefined}
          />
        </div>
        )}
        {protocol === "ssh" && (
        <TextField
          label={msg.hosts.username}
          value={username}
          onChange={setUsername}
          maxLength={255}
          placeholder={inherited.username ?? undefined}
          hint={
            groupId && username === ""
              ? inherited.username
                ? msg.hosts.inherit(inherited.username)
                : msg.hosts.needsUser
              : undefined
          }
        />
        )}
        <TextField label={msg.hosts.tags} value={tags} onChange={setTags} hint={msg.hosts.tagsHint} maxLength={600} />

        {protocol === "ssh" && (
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            {msg.hosts.auth}
          </legend>
          {groupId && (
            <label className="choice">
              <input type="radio" name="auth" checked={authKind === "inherit"} onChange={() => setAuthKind("inherit")} />
              <span className="choice-body">
                <span className="choice-title">{msg.hosts.authInherit}</span>
                <span className="hint">{msg.hosts.authInheritHint(inheritedKey?.label ?? null)}</span>
              </span>
            </label>
          )}
          <label className="choice">
            <input type="radio" name="auth" checked={authKind === "key"} onChange={() => setAuthKind("key")} />
            <span className="choice-body">
              <span className="choice-title">{msg.hosts.key}</span>
              <span className="hint">{keys.length > 0 ? msg.hosts.keyHint : msg.hosts.keyNone}</span>
              {authKind === "key" && keys.length > 0 && (
                <select
                  className="select"
                  style={{ marginTop: 6 }}
                  aria-label={msg.hosts.keyChoose}
                  value={keyId}
                  onChange={(event) => setKeyId(event.target.value)}
                >
                  {keys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.label} ({key.algorithm})
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="auth" checked={authKind === "ask_password"} onChange={() => setAuthKind("ask_password")} />
            <span className="choice-body">
              <span className="choice-title">{msg.hosts.askPassword}</span>
              <span className="hint">{msg.hosts.askPasswordHint}</span>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="auth" checked={authKind === "stored_password"} onChange={() => setAuthKind("stored_password")} />
            <span className="choice-body">
              <span className="choice-title">{msg.hosts.storedPassword}</span>
              <span className="hint">{msg.hosts.storedPasswordHint}</span>
            </span>
          </label>
          {authKind === "stored_password" && (
            <SecretField
              label={msg.hosts.password}
              value={password}
              onChange={setPassword}
              hint={hadStoredPassword ? msg.hosts.passwordKeep : undefined}
              maxLength={1024}
            />
          )}
        </fieldset>
        )}

        {protocol === "ssh" && authKind === "key" && (
          <AgentForwarding checked={forwardAgent} onChange={setForwardAgent} />
        )}
        {/* agent B: tunnels and history */}
        {protocol === "ssh" && <HostAdvancedSection host={host} state={advanced} />}

        {ready && protocol === "ssh" && (
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.hosts.effective(effectiveUser, address.trim(), effectivePort)}
          </p>
        )}
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
            {pending ? msg.common.working : msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

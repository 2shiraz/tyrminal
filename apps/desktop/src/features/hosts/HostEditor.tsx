import type { HostAuthInput, HostSummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, SecretField, TextField } from "../../components/ui/controls";
import { IconServer } from "../../components/ui/icons";
import { hosts as hostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

type AuthKind = HostAuthInput["kind"];

export function HostEditor({
  host,
  initial,
  keys,
  onClose,
  onSaved,
}: {
  host: HostSummary | null;
  /** Prefill for a new host (quick connect, duplicate). */
  initial?: { label?: string; address: string; port: number; username: string; auth?: HostSummary["auth"] } | undefined;
  keys: KeySummary[];
  onClose: () => void;
  onSaved: (saved: HostSummary) => void;
}) {
  const source = host ?? initial;
  const [label, setLabel] = useState(host?.label ?? initial?.label ?? initial?.address ?? "");
  const [address, setAddress] = useState(source?.address ?? "");
  const [port, setPort] = useState(String(source?.port ?? 22));
  const [username, setUsername] = useState(source?.username ?? "");
  const sourceAuth = host?.auth ?? initial?.auth;
  const [authKind, setAuthKind] = useState<AuthKind>(
    sourceAuth?.kind === "stored_password" && !host ? "ask_password" : (sourceAuth?.kind ?? (keys.length > 0 ? "key" : "ask_password")),
  );
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(sourceAuth?.kind === "key" ? sourceAuth.keyId : (keys[0]?.id ?? ""));
  const { pending, error, run } = useAction();

  const hadStoredPassword = host?.auth.kind === "stored_password";
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const authValid =
    authKind === "ask_password" ||
    (authKind === "stored_password" && (password.length > 0 || hadStoredPassword)) ||
    (authKind === "key" && keyId !== "");
  const ready = label.trim() !== "" && address.trim() !== "" && username !== "" && portValid && authValid;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    const auth: HostAuthInput =
      authKind === "key"
        ? { kind: "key", keyId }
        : authKind === "stored_password"
          ? { kind: "stored_password", password: password.length > 0 ? password : null }
          : { kind: "ask_password" };
    const saved = await run(() => hostsApi.save({ id: host?.id ?? null, label, address, port: portNumber, username, auth }));
    setPassword("");
    if (saved) onSaved(saved);
  }

  return (
    <Dialog title={host ? msg.hosts.editorEdit : msg.hosts.editorNew} icon={<IconServer size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <TextField label={msg.hosts.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <div className="split">
          <TextField label={msg.hosts.address} value={address} onChange={setAddress} hint={msg.hosts.addressHint} maxLength={253} />
          <TextField
            label={msg.hosts.port}
            value={port}
            onChange={setPort}
            inputMode="numeric"
            maxLength={5}
            error={port !== "" && !portValid ? "1–65535" : undefined}
          />
        </div>
        <TextField label={msg.hosts.username} value={username} onChange={setUsername} maxLength={255} />

        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            {msg.hosts.auth}
          </legend>
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

        {ready && (
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.hosts.effective(username, address.trim(), portNumber)}
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

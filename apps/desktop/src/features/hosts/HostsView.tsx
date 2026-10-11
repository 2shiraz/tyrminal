import type { HostAuthInput, HostSummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useMemo, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, SecretField, TextField } from "../../components/ui/controls";
import { hosts as hostsApi, keys as keysApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction, useLoaded } from "../../lib/useAsync";

function authSummary(host: HostSummary, keys: KeySummary[]): string {
  switch (host.auth.kind) {
    case "ask_password":
      return msg.hosts.authAsk;
    case "stored_password":
      return msg.hosts.authStored;
    case "key": {
      const keyId = host.auth.keyId;
      const key = keys.find((k) => k.id === keyId);
      return key ? msg.hosts.authKey(key.label) : msg.hosts.authKeyMissing;
    }
  }
}

export function HostsView({ onConnect }: { onConnect: (host: HostSummary) => void }) {
  const hosts = useLoaded(hostsApi.list);
  const keys = useLoaded(keysApi.list);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<HostSummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<HostSummary | null>(null);
  const remove = useAction();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = hosts.value ?? [];
    if (!needle) return all;
    return all.filter((h) => `${h.label} ${h.address} ${h.username}`.toLowerCase().includes(needle));
  }, [hosts.value, query]);

  const total = hosts.value?.length ?? 0;

  return (
    <section className="panel-view" aria-labelledby="hosts-title">
      <div className="view-header">
        <h1 id="hosts-title">{msg.hosts.title}</h1>
        {total > 0 && (
          <input
            className="input"
            style={{ width: 240 }}
            type="search"
            placeholder={msg.common.search}
            aria-label={msg.hosts.searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          {msg.hosts.add}
        </button>
      </div>

      <ErrorNotice error={hosts.error ?? remove.error} />

      {hosts.value && total === 0 && (
        <div className="empty">
          <h2>{msg.hosts.emptyTitle}</h2>
          <p>{msg.hosts.emptyBody}</p>
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
            {msg.hosts.add}
          </button>
        </div>
      )}

      {total > 0 && filtered.length === 0 && <p className="muted">{msg.hosts.noMatch}</p>}

      <ul className="list">
        {filtered.map((host) => (
          <li key={host.id} className="row">
            <div className="row-main">
              <span className="row-title">{host.label}</span>
              <span className="row-sub">
                {msg.hosts.destination(host.username, host.address, host.port)} · {authSummary(host, keys.value ?? [])}
              </span>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => onConnect(host)}>
              {msg.hosts.connect}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(host)}>
              {msg.common.edit}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setDeleting(host)}>
              {msg.common.delete}
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <HostEditor
          host={editing === "new" ? null : editing}
          keys={keys.value ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void hosts.reload();
          }}
        />
      )}

      {deleting && (
        <Dialog title={msg.hosts.deleteTitle(deleting.label)} role="alertdialog" onDismiss={() => setDeleting(null)}>
          <p className="muted">{msg.hosts.deleteBody}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={remove.pending}
              onClick={async () => {
                const target = deleting;
                setDeleting(null);
                await remove.run(() => hostsApi.remove(target.id));
                void hosts.reload();
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

type AuthKind = HostAuthInput["kind"];

function HostEditor({
  host,
  keys,
  onClose,
  onSaved,
}: {
  host: HostSummary | null;
  keys: KeySummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(host?.label ?? "");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(host?.auth.kind ?? (keys.length > 0 ? "key" : "ask_password"));
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(host?.auth.kind === "key" ? host.auth.keyId : (keys[0]?.id ?? ""));
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
    const saved = await run(() =>
      hostsApi.save({ id: host?.id ?? null, label, address, port: portNumber, username, auth }),
    );
    setPassword("");
    if (saved) onSaved();
  }

  return (
    <Dialog title={host ? msg.hosts.editorEdit : msg.hosts.editorNew} onDismiss={onClose}>
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
          <legend className="label" style={{ fontSize: "var(--text-sm)", fontWeight: 550, color: "var(--text-muted)", marginBottom: 4 }}>
            {msg.hosts.auth}
          </legend>
          <label className="radio-row">
            <input type="radio" name="auth" checked={authKind === "key"} onChange={() => setAuthKind("key")} />
            <span className="stack-sm" style={{ flex: 1 }}>
              <span>{msg.hosts.key}</span>
              <span className="hint muted">{keys.length > 0 ? msg.hosts.keyHint : msg.hosts.keyNone}</span>
              {authKind === "key" && keys.length > 0 && (
                <select className="select" aria-label={msg.hosts.keyChoose} value={keyId} onChange={(event) => setKeyId(event.target.value)}>
                  {keys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.label} ({key.algorithm})
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>
          <label className="radio-row">
            <input type="radio" name="auth" checked={authKind === "ask_password"} onChange={() => setAuthKind("ask_password")} />
            <span className="stack-sm">
              <span>{msg.hosts.askPassword}</span>
              <span className="hint muted">{msg.hosts.askPasswordHint}</span>
            </span>
          </label>
          <label className="radio-row">
            <input type="radio" name="auth" checked={authKind === "stored_password"} onChange={() => setAuthKind("stored_password")} />
            <span className="stack-sm" style={{ flex: 1 }}>
              <span>{msg.hosts.storedPassword}</span>
              <span className="hint muted">{msg.hosts.storedPasswordHint}</span>
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

        {ready && <p className="muted">{msg.hosts.effective(username, address.trim(), portNumber)}</p>}
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

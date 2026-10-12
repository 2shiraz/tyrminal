import type { IdentitySummary, KeySummary, SecretChange } from "@tyrminal/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, IconButton, SecretField, Switch, TextField } from "../../components/ui/controls";
import { IconPencil, IconPlus, IconTrash2, IconUser } from "../../components/ui/icons";
import { identities as identitiesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";
// identity deletion (BUILD_SPEC §10.2)
import { DeleteIdentityDialog } from "../identities/DeleteIdentityDialog";

/** Notifies views that show identities (hosts, keychain) that they changed. */
const listeners = new Set<() => void>();
export const identityEvents = {
  changed: () => {
    for (const fn of listeners) fn();
  },
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/** The identity list, reloaded whenever identities or their uses change. */
export function useIdentities() {
  const [list, setList] = useState<IdentitySummary[] | null>(null);
  const reload = useCallback(() => {
    identitiesApi
      .list()
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(() => {
    reload();
    return identityEvents.subscribe(reload);
  }, [reload]);
  return list;
}

/** Reusable identities on the Keychain page (KEY-15/16). */
export function IdentitiesSection({ keys }: { keys: KeySummary[] }) {
  const list = useIdentities();
  const [editing, setEditing] = useState<IdentitySummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<IdentitySummary | null>(null);
  const remove = useAction();
  const keyLabel = (id: string | null) => keys.find((k) => k.id === id)?.label ?? null;

  return (
    <section className="page-inner" aria-labelledby="identities-title" style={{ maxWidth: 900 }}>
      <div className="page-header">
        <div className="page-title">
          <h2 id="identities-title">{msgD.identities.title}</h2>
          <p>{msgD.identities.body}</p>
        </div>
        <button type="button" className="btn" onClick={() => setEditing("new")}>
          <IconPlus size={16} />
          {msgD.identities.add}
        </button>
      </div>
      <ErrorNotice error={remove.error} />
      {list && list.length === 0 && <p className="muted">{msgD.identities.empty}</p>}
      {list && list.length > 0 && (
        <ul className="list" aria-label={msgD.identities.title}>
          {list.map((identity) => (
            <li key={identity.id}>
              <span className="tile-icon" aria-hidden="true">
                <IconUser size={17} />
              </span>
              <div className="row-main">
                <span className="row-title">{identity.label}</span>
                <span className="row-sub">{msgD.identities.summary(identity.username, identity.hasPassword, keyLabel(identity.keyId))}</span>
                <span className="row-sub">{msgD.identities.usedBy(identity.usedBy)}</span>
              </div>
              <IconButton size="sm" label={msgD.identities.edit(identity.label)} onClick={() => setEditing(identity)}>
                <IconPencil size={15} />
              </IconButton>
              <IconButton size="sm" label={`${msg.common.delete} ${identity.label}`} onClick={() => setDeleting(identity)}>
                <IconTrash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <IdentityDialog
          identity={editing === "new" ? null : editing}
          keys={keys}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            identityEvents.changed();
          }}
        />
      )}

      {/* identity deletion (BUILD_SPEC §10.2): an identity in use needs an explicit choice. */}
      {deleting && (
        <DeleteIdentityDialog
          identity={deleting}
          others={(list ?? []).filter((i) => i.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            identityEvents.changed();
          }}
        />
      )}
    </section>
  );
}

function IdentityDialog({
  identity,
  keys,
  onClose,
  onDone,
}: {
  identity: IdentitySummary | null;
  keys: KeySummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(identity?.label ?? "");
  const [username, setUsername] = useState(identity?.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [keyId, setKeyId] = useState(identity?.keyId ?? "");
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const change: SecretChange = password ? { kind: "set", value: password } : clearPassword ? { kind: "clear" } : { kind: "keep" };
    const saved = await run(() => identitiesApi.save({ id: identity?.id ?? null, label, username, password: change, keyId: keyId || null }));
    // The typed password is dropped from the page as soon as it is saved.
    setPassword("");
    if (saved) onDone();
  }

  return (
    <Dialog title={identity ? msgD.identities.edit(identity.label) : msgD.identities.newTitle} icon={<IconUser size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <TextField label={msgD.identities.label} value={label} onChange={setLabel} maxLength={128} data-autofocus required />
        <TextField label={msgD.identities.username} value={username} onChange={setUsername} hint={msgD.identities.usernameHint} autoComplete="off" spellCheck={false} />
        <SecretField
          label={msgD.identities.password}
          value={password}
          onChange={setPassword}
          hint={identity?.hasPassword ? msgD.identities.passwordKeep : msgD.identities.passwordNone}
          autoComplete="new-password"
          disabled={clearPassword}
        />
        {identity?.hasPassword && <Switch label={msgD.identities.clearPassword} checked={clearPassword} onChange={setClearPassword} />}
        <label className="field">
          <span className="label">{msgD.identities.key}</span>
          <select className="input" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">{msgD.identities.noKey}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending || !label.trim()}>
            {pending ? msg.common.working : msgD.identities.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Reusable identities (KEY-15..17): the list on the Keychain page and the editor. The password is
// write-only here: the summary says whether one is stored, and saving sends a new one, "keep" or
// "clear", never the stored value.

import type { IdentityPasswordInput, IdentitySummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorNotice, IconButton, SecretField, SkeletonRows, TextField } from "../../components/ui/controls";
import { IconPencil, IconPlus, IconTrash2, IconUser } from "../../components/ui/icons";
import { identities as identitiesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-identities";
import { useAction } from "../../lib/useAsync";

/** One line describing what an identity holds (never the password). */
export function identityDetails(identity: IdentitySummary, keys: KeySummary[]): string {
  const parts: string[] = [];
  if (identity.username) parts.push(identity.username);
  if (identity.keyId) {
    const key = keys.find((k) => k.id === identity.keyId);
    parts.push(key ? msgI.identities.keyLabel(key.label) : msgI.identities.keyMissing);
  }
  if (identity.hasPassword) parts.push(msgI.identities.hasPassword);
  return parts.join(" · ");
}

export function IdentitiesSection() {
  const { identities, keys, hosts, groups } = useVaultData();
  const [editing, setEditing] = useState<IdentitySummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<IdentitySummary | null>(null);
  const remove = useAction();
  const list = identities.value ?? [];

  // Usage counts change when hosts or groups are edited elsewhere: refresh on opening the page.
  useEffect(() => {
    void identities.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
  }, []);

  const reloadAll = () => {
    void identities.reload();
    void hosts.reload();
    void groups.reload();
  };

  return (
    <section className="page-inner" aria-labelledby="identities-title" style={{ maxWidth: 900 }}>
      <div className="page-header">
        <div className="page-title">
          <h2 id="identities-title">{msgI.identities.title}</h2>
          <p>{msgI.identities.intro}</p>
        </div>
        <button type="button" className="btn" onClick={() => setEditing("new")}>
          <IconPlus size={16} />
          {msgI.identities.add}
        </button>
      </div>
      <ErrorNotice error={identities.error ?? remove.error} />
      {identities.value === null && !identities.error && <SkeletonRows count={1} />}
      {identities.value && list.length === 0 && (
        <EmptyState icon={<IconUser size={28} />} title={msgI.identities.emptyTitle} body={msgI.identities.emptyBody} />
      )}
      {list.length > 0 && (
        <ul className="list" aria-label={msgI.identities.title}>
          {list.map((identity) => (
            <li key={identity.id}>
              <span className="tile-icon" aria-hidden="true">
                <IconUser size={17} />
              </span>
              <div className="row-main">
                <span className="row-title">{identity.label}</span>
                <span className="row-sub">{identityDetails(identity, keys.value ?? [])}</span>
                <span className="row-sub">{msgI.identities.usedBy(identity.usedByHosts, identity.usedByGroups)}</span>
              </div>
              <IconButton size="sm" label={`${msg.common.edit} ${identity.label}`} onClick={() => setEditing(identity)}>
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
        <IdentityEditor
          identity={editing === "new" ? null : editing}
          keys={keys.value ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadAll();
          }}
        />
      )}

      {deleting && (
        <Dialog
          title={msgI.identities.deleteTitle(deleting.label)}
          role="alertdialog"
          icon={<IconTrash2 size={18} />}
          tone="danger"
          onDismiss={() => setDeleting(null)}
        >
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {deleting.usedByHosts > 0 || deleting.usedByGroups > 0
              ? msgI.identities.deleteInUse(deleting.usedByHosts, deleting.usedByGroups)
              : msgI.identities.deleteBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={deleting.usedByHosts > 0 || deleting.usedByGroups > 0}
              onClick={async () => {
                const target = deleting;
                setDeleting(null);
                await remove.run(() => identitiesApi.remove(target.id));
                reloadAll();
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

function IdentityEditor({
  identity,
  keys,
  onClose,
  onSaved,
}: {
  identity: IdentitySummary | null;
  keys: KeySummary[];
  onClose: () => void;
  onSaved: (saved: IdentitySummary) => void;
}) {
  const [label, setLabel] = useState(identity?.label ?? "");
  const [username, setUsername] = useState(identity?.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [keyId, setKeyId] = useState(identity?.keyId ?? "");
  const { pending, error, run } = useAction();
  const fieldId = useId();
  const hadPassword = identity?.hasPassword ?? false;
  const ready = label.trim() !== "" && !/\s/.test(username.trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    const passwordInput: IdentityPasswordInput =
      password.length > 0 ? { kind: "set", password } : clearPassword ? { kind: "clear" } : { kind: "keep" };
    const saved = await run(() =>
      identitiesApi.save({
        id: identity?.id ?? null,
        label: label.trim(),
        username: username.trim(),
        password: passwordInput,
        keyId: keyId === "" ? null : keyId,
      }),
    );
    setPassword("");
    if (saved) onSaved(saved);
  }

  return (
    <Dialog title={identity ? msgI.identities.editTitle : msgI.identities.newTitle} icon={<IconUser size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <TextField label={msgI.identities.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <TextField label={msgI.identities.username} value={username} onChange={setUsername} maxLength={255} hint={msgI.identities.usernameHint} />
        <SecretField
          label={msgI.identities.password}
          value={password}
          onChange={(value) => {
            setPassword(value);
            if (value) setClearPassword(false);
          }}
          maxLength={1024}
          hint={hadPassword && !clearPassword ? msgI.identities.passwordStored : msgI.identities.passwordHint}
        />
        {hadPassword && password === "" && (
          <label className="choice">
            <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} />
            <span className="choice-body">
              <span className="choice-title">{msgI.identities.removePassword}</span>
            </span>
          </label>
        )}
        <div className="field">
          <label className="label" htmlFor={`${fieldId}-key`}>
            {msgI.identities.key}
          </label>
          <select
            id={`${fieldId}-key`}
            className="select"
            value={keyId}
            aria-describedby={`${fieldId}-key-hint`}
            onChange={(event) => setKeyId(event.target.value)}
          >
            <option value="">{msgI.identities.keyNone}</option>
            {keys.map((key) => (
              <option key={key.id} value={key.id}>
                {key.label} ({key.algorithm})
              </option>
            ))}
          </select>
          <span className="hint" id={`${fieldId}-key-hint`}>
            {msgI.identities.keyHint}
          </span>
        </div>
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

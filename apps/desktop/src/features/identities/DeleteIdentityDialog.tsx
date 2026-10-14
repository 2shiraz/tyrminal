// Deleting an identity (spec §10.2): when hosts or groups use it, the dialog lists them,
// says how each host would sign in without it, and deletes only after the user picks another
// identity for them or chooses to remove it from them. Nothing falls back silently.

import type { IdentityReferences, IdentitySummary, IdentityUse } from "@tyrminal/contracts";
import { useEffect, useId, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice } from "../../components/ui/controls";
import { IconTrash2 } from "../../components/ui/icons";
import { identityDeletion } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-identities";
import { useAction } from "../../lib/useAsync";

export function DeleteIdentityDialog({
  identity,
  others,
  onClose,
  onDeleted,
}: {
  identity: IdentitySummary;
  /** Every other identity, for reassignment. */
  others: IdentitySummary[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [uses, setUses] = useState<IdentityUse[] | null>(null);
  const [choice, setChoice] = useState<"reassign" | "remove" | null>(null);
  const [replacement, setReplacement] = useState(others[0]?.id ?? "");
  const load = useAction();
  const remove = useAction();
  const selectId = useId();

  useEffect(() => {
    let live = true;
    void load.run(() => identityDeletion.usage(identity.id)).then((found) => {
      if (live && found) setUses(found);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per identity
  }, [identity.id]);

  const inUse = (uses?.length ?? 0) > 0;
  const hosts = uses?.filter((u) => u.target.kind === "host").length ?? 0;
  const groups = uses?.filter((u) => u.target.kind === "group").length ?? 0;
  const references: IdentityReferences | null =
    choice === "remove" ? { kind: "remove" } : choice === "reassign" && replacement ? { kind: "reassign", identityId: replacement } : null;
  const ready = uses !== null && (!inUse || references !== null);

  async function confirm() {
    if (!ready || remove.pending) return;
    const done = await remove.run(async () => {
      await identityDeletion.remove(identity.id, inUse ? references : null);
      return true;
    });
    if (done) onDeleted();
  }

  return (
    <Dialog title={msgI.deletion.title(identity.label)} role="alertdialog" icon={<IconTrash2 size={18} />} tone="danger" onDismiss={onClose}>
      <div className="stack">
        {uses === null && !load.error && <p className="muted">{msgI.deletion.loading}</p>}
        {uses !== null && !inUse && <p className="muted">{msgI.deletion.unused}</p>}
        {inUse && (
          <>
            <p>{msgI.deletion.used(hosts, groups)}</p>
            <ul className="stack-sm" aria-label={msgI.deletion.usersLabel} style={{ margin: 0, paddingLeft: 18, fontSize: "var(--text-sm)" }}>
              {uses?.map((use) => (
                <li key={use.target.kind === "host" ? `h${use.target.hostId}` : `g${use.target.groupId}`}>
                  <strong>{use.label}</strong>
                  {use.target.kind === "group" ? ` (${msgI.deletion.group})` : use.direct ? "" : ` (${msgI.deletion.fromGroup})`}
                  {choice === "remove" && use.afterRemoval && <span className="muted"> — {msgI.deletion.after(msgI.signIn(use.afterRemoval))}</span>}
                </li>
              ))}
            </ul>
            <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <label className="choice">
                <input type="radio" name="identity-references" checked={choice === "reassign"} disabled={others.length === 0} onChange={() => setChoice("reassign")} />
                <span className="choice-body">
                  <span className="choice-title">{msgI.deletion.reassign}</span>
                  <span className="hint">{others.length > 0 ? msgI.deletion.reassignHint : msgI.deletion.noOther}</span>
                </span>
              </label>
              {choice === "reassign" && others.length > 0 && (
                <div className="field">
                  <label className="label" htmlFor={selectId}>
                    {msgI.deletion.chooseOther}
                  </label>
                  <select id={selectId} className="select" value={replacement} onChange={(event) => setReplacement(event.target.value)}>
                    {others.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className="choice">
                <input type="radio" name="identity-references" checked={choice === "remove"} onChange={() => setChoice("remove")} />
                <span className="choice-body">
                  <span className="choice-title">{msgI.deletion.remove}</span>
                  <span className="hint">{msgI.deletion.removeHint}</span>
                </span>
              </label>
            </fieldset>
          </>
        )}
        <ErrorNotice error={load.error ?? remove.error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            {msg.common.cancel}
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={() => void confirm()} disabled={!ready || remove.pending}>
            {remove.pending ? msg.common.working : msgI.deletion.confirm}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

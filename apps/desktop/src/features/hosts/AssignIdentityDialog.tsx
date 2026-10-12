import type { IdentityAssignment, IdentitySummary, SettingsTarget } from "@tyrminal/contracts";
import { useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice } from "../../components/ui/controls";
import { IconUser } from "../../components/ui/icons";
import { identities as identitiesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";

/** Chooses the identity a host or group uses (KEY-17), showing what a host ends up using. */
export function AssignIdentityDialog({
  target,
  name,
  current,
  list,
  onClose,
  onDone,
}: {
  target: SettingsTarget;
  name: string;
  current: IdentityAssignment | null;
  list: IdentitySummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [identityId, setIdentityId] = useState(current?.identityId ?? "");
  const { pending, error, run } = useAction();
  const labelOf = (id: string | null | undefined) => list.find((i) => i.id === id)?.label ?? null;
  const effective = labelOf(current?.effectiveIdentityId);
  const origin = current?.origin;

  return (
    <Dialog title={msgD.identities.assignTitle(name)} icon={<IconUser size={18} />} onDismiss={onClose}>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const done = await run(() => identitiesApi.assign(target, identityId || null));
          if (done) onDone();
        }}
      >
        <p className="muted">{msgD.identities.assignBody}</p>
        {target.kind === "host" && (
          <p data-testid="identity-effective">
            {effective === null
              ? msgD.identities.notUsed
              : origin?.kind === "group"
                ? msgD.identities.fromGroup(effective, origin.name)
                : msgD.identities.effective(effective)}
          </p>
        )}
        <label className="field">
          <span className="label">{msgD.identities.title}</span>
          <select className="input" value={identityId} onChange={(e) => setIdentityId(e.target.value)} data-autofocus>
            <option value="">{msgD.identities.none}</option>
            {list.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.label}
              </option>
            ))}
          </select>
        </label>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? msg.common.working : msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

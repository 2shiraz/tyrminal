// Privilege-prompt assistance (KEY-18, AUT-05 "changed"): the user asks for it with the palette
// command or its shortcut, sees which identity's password will be typed into which host, and
// confirms. Nothing watches terminal output for prompts: a server can print anything, including
// text that looks like a sudo prompt. The password is typed by the core, never sent here, and
// without Enter so the user submits it after checking the prompt.

import type { SessionIdentity } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Notice } from "../../components/ui/controls";
import { IconUser } from "../../components/ui/icons";
import { identities as identitiesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-identities";
import { useAction } from "../../lib/useAsync";

export function InsertPasswordDialog({
  sessionId,
  hostLabel,
  onClose,
  onInserted,
}: {
  sessionId: string;
  hostLabel: string;
  onClose: () => void;
  onInserted: (identity: SessionIdentity) => void;
}) {
  // undefined: loading; null: the host uses no identity.
  const [identity, setIdentity] = useState<SessionIdentity | null | undefined>(undefined);
  const load = useAction();
  const insert = useAction();

  useEffect(() => {
    let live = true;
    void load.run(() => identitiesApi.forSession(sessionId)).then((found) => {
      // `undefined` here means the lookup failed (its error is shown); `null` means no identity.
      if (live && found !== undefined) setIdentity(found);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per session
  }, [sessionId]);

  const ready = identity?.hasPassword === true;

  async function confirm() {
    if (!identity || !ready || insert.pending) return;
    // The identity id the user saw goes with the request; the core refuses if the host now uses
    // a different one.
    const done = await insert.run(async () => {
      await identitiesApi.insertPassword(sessionId, identity.identityId);
      return true;
    });
    if (done) onInserted(identity);
  }

  return (
    <Dialog title={msgI.insert.title} icon={<IconUser size={18} />} onDismiss={onClose}>
      <div className="stack">
        {identity === undefined && !load.error && <p className="muted">{msg.common.working}</p>}
        {identity === null && <p className="muted">{msgI.insert.none}</p>}
        {identity && !identity.hasPassword && <p className="muted">{msgI.insert.noPassword(identity.label)}</p>}
        {identity && identity.hasPassword && (
          <>
            <p>{msgI.insert.body(identity.label, hostLabel)}</p>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {msgI.insert.noEnter}
            </p>
            <Notice tone="warning">{msgI.insert.warning}</Notice>
          </>
        )}
        <ErrorNotice error={load.error ?? insert.error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} data-autofocus={ready ? undefined : true}>
            {msg.common.cancel}
          </button>
          {ready && (
            <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={insert.pending} data-autofocus>
              {insert.pending ? msg.common.working : msgI.insert.confirm}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

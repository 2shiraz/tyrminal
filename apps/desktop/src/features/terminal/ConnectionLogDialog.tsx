import { useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice } from "../../components/ui/controls";
import { IconScrollText } from "../../components/ui/icons";
import { sessions } from "../../lib/ipc";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";

/**
 * The connection log of one session: what happened while it connected (addresses, hops,
 * algorithms, which sign-in method was tried), shortly after it ended too. The core keeps it
 * free of secrets; it is shown as plain text and can be copied by the user.
 */
export function ConnectionLogDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const load = useAction();

  useEffect(() => {
    let live = true;
    void load.run(() => sessions.diagnostics(sessionId)).then((result) => {
      if (live && result) setLines(result);
    });
    return () => {
      live = false;
    };
  }, [sessionId, load.run]);

  return (
    <Dialog title={msgD.connectionLog.title(title)} icon={<IconScrollText size={18} />} wide onDismiss={onClose}>
      <div className="stack">
        <p className="muted">{msgD.connectionLog.body}</p>
        <ErrorNotice error={load.error} />
        {lines && lines.length === 0 && <p className="muted">{msgD.connectionLog.empty}</p>}
        {lines && lines.length > 0 && (
          <pre className="connection-log mono" data-testid="connection-log" tabIndex={0} aria-label={msgD.connectionLog.label}>
            {lines.join("\n")}
          </pre>
        )}
        <div className="dialog-actions">
          {lines && lines.length > 0 && (
            <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(lines.join("\n")).catch(() => undefined)}>
              {msgD.connectionLog.copy}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
            {msgD.connectionLog.close}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

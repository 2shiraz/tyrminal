import { useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { IconCopy, IconInfo } from "../../components/ui/icons";
import { sessions, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgI } from "../../lib/messages-input";

// Shown as text only; a line can never carry terminal or layout control characters.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** The core's diagnostic lines for one session, with Copy (CON-15). */
export function ConnectionDetails({ sessionId, label, onClose }: { sessionId: string; label: string; onClose: () => void }) {
  const notify = useToast();
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    sessions.diagnostics(sessionId).then(
      (result) => {
        if (live) setLines(result.map((line) => line.replace(CONTROL, "�")));
      },
      (e) => {
        if (live) setError(toAppError(e).message);
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  async function copy() {
    try {
      await navigator.clipboard.writeText((lines ?? []).join("\n"));
      notify("success", msgI.details.copied);
    } catch {
      notify("danger", msgI.details.copyFailed);
    }
  }

  return (
    <Dialog title={msgI.details.title(label)} icon={<IconInfo size={18} />} onDismiss={onClose} wide>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msgI.details.note}
      </p>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : lines === null ? (
        <p role="status" className="faint">
          {msgI.details.loading}
        </p>
      ) : lines.length === 0 ? (
        <p className="faint">{msgI.details.empty}</p>
      ) : (
        <ol className="connection-details mono selectable" aria-label={msgI.details.listLabel}>
          {lines.map((line, i) => (
            // Lines are positional: the same text can appear twice.
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} data-autofocus>
          {msg.common.close}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void copy()} disabled={!lines || lines.length === 0}>
          <IconCopy size={14} /> {msgI.details.copy}
        </button>
      </div>
    </Dialog>
  );
}

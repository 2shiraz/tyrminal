import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Notice, TextField } from "../../components/ui/controls";
import { IconLayoutTemplate } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";

/** Names a new layout. Saving happens only when the user confirms here (or chooses Save). */
export function SaveLayoutDialog({
  initialName,
  summary,
  onSave,
  onCancel,
}: {
  initialName: string;
  /** e.g. "2 tabs, 5 panes". */
  summary: string;
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "" || busy) return;
    setBusy(true);
    const failure = await onSave(name.trim());
    setBusy(false);
    setError(failure);
  }

  return (
    <Dialog title={msgC.layouts.saveTitle} icon={<IconLayoutTemplate size={18} />} onDismiss={onCancel}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgC.layouts.saveBody}
        </p>
        <p className="faint" style={{ fontSize: "var(--text-sm)" }}>
          {summary}
        </p>
        <TextField label={msgC.layouts.nameLabel} value={name} onChange={setName} autoFocus maxLength={256} spellCheck={false} />
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={name.trim() === "" || busy}>
            {msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

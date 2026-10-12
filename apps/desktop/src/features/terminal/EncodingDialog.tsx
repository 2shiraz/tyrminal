import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { IconType } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { ENCODINGS } from "./encoding";

/** Picks the character encoding of the focused session (TRM-05). */
export function EncodingDialog({ current, target, onApply, onCancel }: { current: string; target: string; onApply: (id: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(current);
  function submit(event: FormEvent) {
    event.preventDefault();
    onApply(value);
  }
  return (
    <Dialog title={msgC.encoding.title} icon={<IconType size={18} />} onDismiss={onCancel}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {target}
        </p>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgC.encoding.body}
        </p>
        <div className="field">
          <label htmlFor="session-encoding">{msgC.encoding.label}</label>
          <select id="session-encoding" className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
            {ENCODINGS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary">
            {msgC.encoding.apply}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

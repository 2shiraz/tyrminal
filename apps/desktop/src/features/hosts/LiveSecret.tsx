// Secrets in autosaving editors. A password or passphrase is never autosaved: it is written only
// by its "Set password" button (or Enter in its field), once, and the field is cleared after the
// attempt. A change that would drop a stored secret is held until the user removes it on purpose.
import { Notice, SecretField } from "../../components/ui/controls";
import { msgAutosave } from "../../lib/messages-autosave";

export interface LiveProxySecret {
  /** Whether the route can be written now (valid, and its host exists or can be created). */
  canSet: boolean;
  set: () => void;
  remove: () => void;
}

export function LiveSecretField({
  label,
  value,
  onChange,
  stored,
  maxLength,
  canSet,
  onSet,
  setLabel = msgAutosave.setPassword,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A secret is already stored (an empty field keeps it). */
  stored: boolean;
  maxLength: number;
  canSet: boolean;
  onSet: () => void;
  setLabel?: string;
}) {
  const ready = value.length > 0 && canSet;
  return (
    <div className="live-secret">
      <SecretField
        label={label}
        value={value}
        onChange={onChange}
        hint={stored ? msgAutosave.passwordReplaceHint : msgAutosave.passwordHint}
        maxLength={maxLength}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Enter sets the secret; it never submits the surrounding form.
          event.preventDefault();
          if (ready) onSet();
        }}
      />
      <button type="button" className="btn btn-sm live-secret-set" disabled={!ready} onClick={onSet}>
        {setLabel}
      </button>
    </div>
  );
}

/** A change that would remove a stored secret: explained, and saved only on request. */
export function DropSecretNotice({ text, action, onRemove }: { text: string; action: string; onRemove: () => void }) {
  return (
    <Notice tone="warning">
      <span>{text}</span>{" "}
      <button type="button" className="btn btn-sm btn-danger live-secret-remove" onClick={onRemove}>
        {action}
      </button>
    </Notice>
  );
}

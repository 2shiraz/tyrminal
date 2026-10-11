import { type InputHTMLAttributes, type ReactNode, useId, useState } from "react";

import type { AppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
}

export function TextField({ label, value, onChange, hint, error, ...rest }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        {...rest}
      />
      {error ? (
        <span id={`${id}-error`} className="hint" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Input for a secret. The value lives in component state only for as long as the form is open;
 * owners clear it on submit. It is never placed in a placeholder, title or any other attribute.
 */
export function SecretField(props: FieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--space-2)", alignItems: "end" }}>
      <TextField {...props} type={visible ? "text" : "password"} autoComplete="off" />
      <button
        type="button"
        className="btn"
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        style={{ marginBottom: props.hint || props.error ? 20 : 0 }}
      >
        {visible ? msg.common.hide : msg.common.show}
      </button>
    </div>
  );
}

/** What failed, that data is safe, and a diagnostic code the user can quote. */
export function ErrorNotice({ error, children }: { error: AppError | null; children?: ReactNode }) {
  if (!error) return null;
  return (
    <div className="notice notice-danger" role="alert">
      <span className="icon" aria-hidden="true">
        !
      </span>
      <div className="stack-sm">
        <span>{error.message}</span>
        {children}
        <span className="muted mono">{msg.app.diagnostic(error.code)}</span>
      </div>
    </div>
  );
}

export function Notice({ tone, icon, children }: { tone: "warning" | "success" | "info"; icon: string; children: ReactNode }) {
  const cls = tone === "info" ? "notice" : `notice notice-${tone}`;
  return (
    <div className={cls}>
      <span className="icon" aria-hidden="true">
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

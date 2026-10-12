import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  forwardRef,
  useId,
  useState,
} from "react";

import type { AppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { type ActionId, bindings, keyCaps } from "../../lib/shortcuts";
import { IconCircleAlert, IconCircleCheck, IconEye, IconEyeOff, IconInfo, IconTriangleAlert } from "./icons";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  /** Rendered inside the input on the right (for example a show/hide toggle). */
  trailing?: ReactNode;
}

export function TextField({ label, value, onChange, hint, error, trailing, ...rest }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-with-icon">
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
          style={trailing ? { paddingRight: 40 } : undefined}
          data-autofocus={rest.autoFocus ? true : undefined}
          {...rest}
        />
        {trailing}
      </div>
      {error ? (
        <span id={`${id}-error`} className="field-error" role="alert">
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
    <TextField
      {...props}
      type={visible ? "text" : "password"}
      autoComplete="off"
      trailing={
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          style={{ position: "absolute", right: 3 }}
          aria-pressed={visible}
          aria-label={visible ? msg.common.hide : msg.common.show}
          data-tooltip={visible ? msg.common.hide : msg.common.show}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <IconEyeOff /> : <IconEye />}
        </button>
      }
    />
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 5,
  maxLength,
  autoFocus,
  mono = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  rows?: number;
  maxLength?: number;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="textarea"
        style={mono ? undefined : { fontFamily: "var(--font-ui)" }}
        rows={rows}
        value={value}
        maxLength={maxLength}
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? true : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** What failed, that data is safe, and a diagnostic code the user can quote. */
export function ErrorNotice({ error, children }: { error: AppError | null; children?: ReactNode }) {
  if (!error) return null;
  return (
    <div className="notice notice-danger" role="alert">
      <IconCircleAlert size={16} />
      <div className="stack-xs">
        <span>{error.message}</span>
        {children}
        <span className="muted mono selectable" style={{ fontSize: "var(--text-xs)" }}>
          {msg.app.diagnostic(error.code)}
        </span>
      </div>
    </div>
  );
}

const NOTICE_ICONS = {
  warning: IconTriangleAlert,
  success: IconCircleCheck,
  info: IconInfo,
  danger: IconCircleAlert,
} as const;

export function Notice({ tone, children }: { tone: keyof typeof NOTICE_ICONS; children: ReactNode }) {
  const Icon = NOTICE_ICONS[tone];
  return (
    <div className={`notice notice-${tone}`}>
      <Icon size={16} />
      <div>{children}</div>
    </div>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
  shortcut?: ActionId;
}

/** Icon-only button. The label is its accessible name and its tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", shortcut, className = "", children, ...rest },
  ref,
) {
  const tip = shortcut ? `${label} (${keyCaps(bindings[shortcut]).join(" ")})` : label;
  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn-ghost btn-icon ${size === "sm" ? "btn-sm" : ""} ${className}`}
      aria-label={label}
      data-tooltip={tip}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Shortcut({ action }: { action: ActionId }) {
  return (
    <span className="kbd-group" aria-hidden="true">
      {keyCaps(bindings[action]).map((cap) => (
        <kbd key={cap}>{cap}</kbd>
      ))}
    </span>
  );
}

export function Keys({ caps }: { caps: string[] }) {
  return (
    <span className="kbd-group" aria-hidden="true">
      {caps.map((cap) => (
        <kbd key={cap}>{cap}</kbd>
      ))}
    </span>
  );
}

export function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="switch-row" htmlFor={id}>
      <span className="setting-label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value}>
          <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.icon}
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className="range-field">
      <input
        id={id}
        className="range"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--fill": fill } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id} className="range-value">
        {format(value)}
      </output>
    </div>
  );
}

export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

/** Deterministic hue from a label, so a host keeps its color everywhere. */
export function hueFor(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

export function initials(text: string): string {
  const words = text.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0], words[1]] : [text.trim().slice(0, 2)];
  return letters
    .map((w) => [...(w ?? "")][0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function Avatar({ label, size = "md" }: { label: string; size?: "sm" | "md" }) {
  return (
    <span className={`avatar ${size === "sm" ? "avatar-sm" : ""}`} style={{ "--hue": hueFor(label) } as CSSProperties} aria-hidden="true">
      {initials(label)}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  children,
  headingLevel = 2,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true">
        {icon}
      </div>
      <Heading>{title}</Heading>
      <p>{body}</p>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

export function SkeletonRows({ count = 3, height = 56 }: { count?: number; height?: number }) {
  return (
    <div className="stack-sm" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        // Placeholder rows have no identity beyond their position.
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/** Relative time for "last connected" labels. */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

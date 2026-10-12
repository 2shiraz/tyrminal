import { type ReactNode, useId } from "react";

/**
 * A group of settings inside a section: a strip with the group's name (and optional actions or
 * hint) above its rows. It carries the `box` and `box-strip` classes, so the shared box
 * primitives style it once they exist; `settings.css` gives it the same shape until then.
 */
export function SettingsGroup({
  title,
  hint,
  actions,
  className = "",
  children,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`box settings-group ${className}`} aria-labelledby={id}>
      <div className="box-strip settings-group-strip">
        <h3 id={id}>{title}</h3>
        {actions && <span className="settings-group-actions">{actions}</span>}
      </div>
      {hint && <p className="settings-group-hint">{hint}</p>}
      <div className="settings-group-rows">{children}</div>
    </section>
  );
}

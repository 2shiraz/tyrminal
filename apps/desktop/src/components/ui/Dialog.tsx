import { type ReactNode, useEffect, useId, useRef } from "react";

interface DialogProps {
  title: string;
  /** Called for Escape and backdrop dismissal. Omit to make the dialog require an explicit choice. */
  onDismiss?: () => void;
  children: ReactNode;
  /** `alertdialog` for decisions that must not be dismissed casually (trust, destructive actions). */
  role?: "dialog" | "alertdialog";
  icon?: ReactNode;
  tone?: "accent" | "warning" | "danger";
  wide?: boolean;
  /** Shown at the end of the title row (an autosave status). */
  aside?: ReactNode;
}

/**
 * Modal dialog on the native `<dialog>` element: focus is trapped by the platform, and focus
 * returns to the previously focused element when the dialog closes.
 */
export function Dialog({ title, onDismiss, children, role = "dialog", icon, tone = "accent", wide = false, aside }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // React applies `autoFocus` before the dialog opens, and showModal() then focuses the first
    // focusable element. Restore the intended initial focus (the safe choice in decisions).
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "dialog-wide" : ""}`}
      role={role}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Never let Escape close the element behind React's back; route it through the owner.
        event.preventDefault();
        onDismiss?.();
      }}
      onMouseDown={(event) => {
        // A click on the backdrop (the dialog element itself, outside its body) dismisses.
        if (event.target === ref.current && onDismiss && role === "dialog") onDismiss();
      }}
    >
      <div className="dialog-body">
        <div className="dialog-head">
          {icon && (
            <span className="dialog-icon" data-tone={tone} aria-hidden="true">
              {icon}
            </span>
          )}
          <h2 id={titleId}>{title}</h2>
          {aside}
        </div>
        {children}
      </div>
    </dialog>
  );
}

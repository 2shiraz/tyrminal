import { type ReactNode, useEffect, useId, useRef } from "react";

interface DialogProps {
  title: string;
  /** Called for Escape and backdrop dismissal. Omit to make the dialog require an explicit choice. */
  onDismiss?: () => void;
  children: ReactNode;
  /** `alertdialog` for decisions that must not be dismissed casually (trust, destructive actions). */
  role?: "dialog" | "alertdialog";
}

/**
 * Modal dialog on the native `<dialog>` element: focus is trapped by the platform, and focus
 * returns to the previously focused element when the dialog closes.
 */
export function Dialog({ title, onDismiss, children, role = "dialog" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      role={role}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Never let Escape close the element behind React's back; route it through the owner.
        event.preventDefault();
        onDismiss?.();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
